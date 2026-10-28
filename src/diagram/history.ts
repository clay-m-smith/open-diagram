import { createHash } from "node:crypto"
import { analysisViews, type DiagramGranularity, type DiagramState, type DiagramView } from "./model.js"
import { HISTORY_BYTES, HISTORY_LIMIT, HistorySchema, type DiagramHistory, type DiagramHistoryEntry, type DiagramHistorySummary } from "./history-model.js"
import { diagramEvidence } from "./notation.js"

// Object insertion order is not content; array order remains meaningful.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}
function citedSources(view: DiagramView, sources: DiagramState["sources"]): DiagramState["sources"] {
  const cited = new Set(diagramEvidence(view.graph))
  return sources.filter(source => cited.has(source.id)).map(({ id, label }) => ({ id, label }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
function contentID(granularity: DiagramGranularity, view: DiagramView, sources: DiagramState["sources"]): string {
  return createHash("sha256").update(canonical([granularity, view, citedSources(view, sources)])).digest("hex").slice(0, 24)
}
function bytes(history: DiagramHistory): number { return Buffer.byteLength(JSON.stringify(history), "utf8") }
function newest(entries: DiagramHistoryEntry[]): DiagramHistoryEntry[] {
  return entries.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Bad optional history must never invalidate the live diagram cache. */
export function restoreHistory(raw: unknown): DiagramHistory {
  const empty: DiagramHistory = { version: 1, entries: [] }
  try {
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > HISTORY_BYTES) return empty
    const parsed = HistorySchema.safeParse(raw)
    if (!parsed.success) return empty
    const history = parsed.data
    const ids = new Set<string>()
    for (const entry of history.entries) {
      if (ids.has(entry.id) || entry.id !== contentID(entry.granularity, entry.view, entry.sources)
        || new Set(entry.sources.map(source => source.id)).size !== entry.sources.length
        || canonical(entry.sources) !== canonical(citedSources(entry.view, entry.sources))) return empty
      ids.add(entry.id)
    }
    return { version: 1, entries: newest(history.entries) }
  } catch { return empty }
}

export function rememberHistory(history: DiagramHistory, snapshot: {
  views: DiagramView[]; sources: DiagramState["sources"]; granularity: DiagramGranularity; updatedAt: number
}): DiagramHistory {
  const previous = restoreHistory(history)
  const accepted: DiagramHistoryEntry[] = []
  for (const view of snapshot.views) {
    const entry: DiagramHistoryEntry = { id: contentID(snapshot.granularity, view, snapshot.sources),
      granularity: snapshot.granularity, updatedAt: snapshot.updatedAt,
      view: structuredClone(view), sources: citedSources(view, snapshot.sources) }
    // Check before eviction: a single oversized view cannot empty prior history.
    if (bytes({ version: 1, entries: [entry] }) > HISTORY_BYTES || accepted.some(item => item.id === entry.id)) continue
    accepted.push(entry)
  }
  const refreshed = new Set(accepted.map(entry => entry.id))
  const result: DiagramHistory = { version: 1,
    entries: newest([...accepted, ...previous.entries.filter(entry => !refreshed.has(entry.id))]).slice(0, HISTORY_LIMIT) }
  while (bytes(result) > HISTORY_BYTES) result.entries.pop()
  return result
}

export function summarizeHistory(history: DiagramHistory, state: DiagramState): DiagramHistorySummary[] {
  const current = new Set(analysisViews(state).map(view => contentID(state.granularity, view, state.sources)))
  return newest([...history.entries]).map(entry => ({ id: entry.id, granularity: entry.granularity,
    updatedAt: entry.updatedAt, viewID: entry.view.id, label: entry.view.label, title: entry.view.graph.title,
    current: current.has(entry.id) }))
}
