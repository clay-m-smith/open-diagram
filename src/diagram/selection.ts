import { createHash } from "node:crypto"

export type EvidenceCandidate = {
  key: string
  label: string
  text: string
  category: "request" | "source" | "structure" | "recent" | "inventory" | "assistant"
  source?: string
  order: number
}

type Category = EvidenceCandidate["category"]
type Evidence = { id: string; label: string; text: string }
type Ranked = { candidate: EvidenceCandidate; index: number; identity: string }
type Range = { start: number; end: number }

const OMIT = "\n[... omitted ...]\n"
const SCAN_LIMIT = 131_072
const POOL_LIMIT = 128
const ID_LENGTH = 26
const CATEGORIES: Category[] = ["request", "source", "structure", "inventory", "recent", "assistant"]
const SHARES: Record<Category, number> = {
  request: 0.14, source: 0.34, structure: 0.24, inventory: 0.12, recent: 0.10, assistant: 0.06,
}
const TEXT_LIMITS: Record<Category, number> = {
  request: 4000, source: 4000, structure: 4000, inventory: 4000, recent: 900, assistant: 1200,
}

function bound(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function clean(text: string): string {
  return text
    // Strip terminal escape sequences, including OSC hyperlinks and string controls.
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
}

/** Inspect bounded, evenly spaced regions, rather than only a large file's prefix. */
function sample(text: string): string {
  if (text.length <= SCAN_LIMIT) return clean(text)
  const size = SCAN_LIMIT / 8
  const parts: string[] = []
  for (let index = 0; index < 8; index++) {
    const start = Math.floor(index * (text.length - size) / 7)
    let part = text.slice(start, start + size)
    const first = part.indexOf("\n")
    const last = part.lastIndexOf("\n")
    if (index > 0 && first >= 0) part = part.slice(first + 1)
    if (index < 7 && last >= 0) {
      const end = part.lastIndexOf("\n")
      if (end >= 0) part = part.slice(0, end)
    }
    parts.push(clean(part))
  }
  return parts.join(OMIT)
}

function semanticScore(line: string): number {
  // Tool line labels remain in output; remove them only for recognizing syntax.
  const body = line.replace(/^\s*(?:L)?\d+\s*[:|]\s?/, "").trimStart()
  if (/^(?:(?:export|default|public|private|protected|static|async|abstract|override|final|internal|open)\s+)*(?:class|interface|struct|enum|type|trait|record|module|namespace|def|function|func|fn|impl)\b/.test(body)) return 9
  if (/^(?:(?:export|const|let|var)\s+).*?(?:=>|\bfunction\b)/.test(body)) return 8
  if (/^(?:async\s+)?[\w$]+\([^;\n]*\)\s*(?::[^=;{}]+)?\s*(?:\{|:|=>)/.test(body)) return 8
  if (/^(?:#{1,6}\s+\S|\[[^\]]+\]\s*$|(?:graph|flowchart|sequenceDiagram|stateDiagram|classDiagram)\b)/.test(body)) return 7
  if (/\S\s*(?:--?>|==?>|<-|<--)\s*\S|\b(?:depends on|calls|publishes to|subscribes to)\b/.test(body)) return 6
  if (/^(?:if|else|elif|for|while|switch|case|match|try|catch|return|yield|await)\b/.test(body)) return 5
  if (/^(?:[\w$.]+\s*=\s*)?[\w$.]+\([^)]/.test(body)) return 4
  if (/^[-\w."'/]+\s*[:=]\s*\S/.test(body)) return 4
  if (/^(?:import|from|require|include|use|package)\b/.test(body)) return 2
  return 0
}

function renderRanges(text: string, ranges: Range[]): string {
  const merged: Range[] = []
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else if (range.end > range.start) merged.push({ ...range })
  }
  let result = ""
  let end = 0
  for (const range of merged) {
    if (range.start > end) result += OMIT
    result += text.slice(range.start, range.end)
    end = range.end
  }
  if (end < text.length) result += OMIT
  return result
}

/**
 * Return original structural windows, in source order, with explicit omissions.
 * Syntax recognition is domain-neutral. No source is evaluated or read from disk.
 */
export function structuralExcerpt(text: string, limit: number): string {
  limit = bound(limit, 0)
  if (!limit) return ""
  const input = sample(text)
  if (input.length <= limit) return input
  if (limit <= OMIT.length) return input.slice(0, limit)
  if (limit <= OMIT.length * 2) return input.slice(0, limit - OMIT.length) + OMIT

  const count = Math.min(4, Math.max(1, Math.floor(limit / 600)))
  const available = limit - (count + 2) * OMIT.length
  if (available <= 0) return input.slice(0, limit - OMIT.length) + OMIT
  const head = Math.min(240, Math.floor(available * 0.12))
  const width = Math.max(1, Math.floor((available - head) / count))
  const lines: Array<Range & { score: number }> = []
  let start = 0
  while (start < input.length) {
    const newline = input.indexOf("\n", start)
    const end = newline < 0 ? input.length : newline + 1
    lines.push({ start, end, score: semanticScore(input.slice(start, Math.min(end, start + 1000))) })
    start = end
  }

  const anchors: Array<{ line: number; score: number; distance: number } | undefined> = Array(count)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.end <= head) continue
    const band = Math.min(count - 1, Math.floor(Math.max(0, line.start - head) * count / (input.length - head)))
    const center = head + (band + 0.5) * (input.length - head) / count
    const distance = Math.abs(line.start - center)
    const previous = anchors[band]
    if (!previous || line.score > previous.score || (line.score === previous.score && distance < previous.distance)) {
      anchors[band] = { line: index, score: line.score, distance }
    }
  }

  const ranges: Range[] = head ? [{ start: 0, end: head }] : []
  for (let band = 0; band < count; band++) {
    const anchor = anchors[band]
    // A single enormous line can cross every band. Sample its body as well.
    let from = anchor ? lines[anchor.line]!.start : Math.floor(head + (band + 0.5) * (input.length - head) / count)
    if (anchor && anchor.line > 0) {
      const before = lines[anchor.line - 1]!
      if (from - before.start <= Math.min(100, width / 4)) from = before.start
    }
    const to = Math.min(input.length, from + width)
    const newline = input.lastIndexOf("\n", to - 1)
    const end = newline > from + width / 2 ? newline + 1 : to
    ranges.push({ start: from, end })
  }
  // At most count + 2 omission markers and `available` source characters.
  return renderRanges(input, ranges)
}

function requestExcerpt(text: string, limit: number): string {
  // Keep both the opening task and final constraints when a request is oversized.
  const input = (text.length <= SCAN_LIMIT
    ? clean(text)
    : clean(text.slice(0, SCAN_LIMIT / 2)) + OMIT + clean(text.slice(-SCAN_LIMIT / 2))).trim()
  if (input.length <= limit) return input
  if (limit <= OMIT.length) return input.slice(0, limit)
  const available = limit - OMIT.length
  const head = Math.ceil(available * 0.65)
  return input.slice(0, head) + OMIT + input.slice(input.length - (available - head))
}

function identity(candidate: EvidenceCandidate): string {
  return candidate.source === undefined ? `key:${candidate.key}` : `source:${candidate.source}`
}

function chronology(a: Ranked, b: Ranked): number {
  const aOrder = Number.isFinite(a.candidate.order) ? a.candidate.order : 0
  const bOrder = Number.isFinite(b.candidate.order) ? b.candidate.order : 0
  return aOrder - bOrder || a.index - b.index
}

function trimPool(pool: Map<string, Ranked>): void {
  const retained = [...pool.values()].sort((a, b) => chronology(b, a)).slice(0, POOL_LIMIT)
  pool.clear()
  for (const item of retained) pool.set(item.identity, item)
}

function shortlist(candidates: readonly EvidenceCandidate[]): Ranked[] {
  const pools = new Map(CATEGORIES.map((category) => [category, new Map<string, Ranked>()]))
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!
    const pool = pools.get(candidate.category)!
    const item = { candidate, index, identity: identity(candidate) }
    const previous = pool.get(item.identity)
    if (!previous || chronology(item, previous) > 0) pool.set(item.identity, item)
    if (pool.size >= POOL_LIMIT * 2) trimPool(pool)
  }
  const retained = new Map<string, Ranked>()
  for (const pool of pools.values()) {
    trimPool(pool)
    for (const item of pool.values()) {
      const previous = retained.get(item.identity)
      if (!previous || chronology(item, previous) > 0) retained.set(item.identity, item)
    }
  }
  // A newer duplicate may have moved category and been evicted there. Resolve
  // retained identities globally without retaining every input record or text.
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!
    const key = identity(candidate)
    const previous = retained.get(key)
    if (!previous) continue
    const item = { candidate, index, identity: key }
    if (chronology(item, previous) > 0) retained.set(key, item)
  }
  return [...retained.values()].sort((a, b) => chronology(b, a))
}

/**
 * Budget counts all returned id + label + text characters (not JSON framing).
 * A nonempty record needs at least 27 characters: 26 for its ID and one for text.
 * Latest request is reserved first whenever budget/limit can hold a record.
 * Candidate metadata is scanned twice; each excerpt inspects at most 128 KiB
 * of input text, with at most 768 shortlisted identities across all categories.
 */
export function selectEvidence(
  candidates: readonly EvidenceCandidate[],
  options: { budget?: number; limit?: number } = {},
): Array<{ id: string; label: string; text: string }> {
  const budget = bound(options.budget, 36_000)
  const limit = bound(options.limit, 32)
  if (budget <= ID_LENGTH || !limit || !candidates.length) return []
  const groups = new Map(CATEGORIES.map((category) => [category, [] as Ranked[]]))
  for (const item of shortlist(candidates)) groups.get(item.candidate.category)!.push(item)
  const cursors = new Map(CATEGORIES.map((category) => [category, 0]))
  const selected: Array<{ item: Ranked; evidence: Evidence }> = []
  let remaining = budget

  function build(item: Ranked, allowance: number): Evidence | undefined {
    if (allowance <= ID_LENGTH) return undefined
    const candidate = item.candidate
    const id = `e_${createHash("sha256").update(item.identity).digest("hex").slice(0, 24)}`
    const labelLimit = Math.min(160, Math.floor((allowance - ID_LENGTH) * 0.15))
    const label = clean(candidate.label.slice(0, 2048)).replace(/\s+/g, " ").trim().slice(0, labelLimit)
    const textLimit = Math.min(TEXT_LIMITS[candidate.category], allowance - id.length - label.length)
    const text = candidate.category === "request"
      ? requestExcerpt(candidate.text, textLimit)
      : structuralExcerpt(candidate.text, textLimit)
    if (!text.trim()) return undefined
    return { id, label, text }
  }

  function take(category: Category, allowance: number): number {
    if (selected.length >= limit || allowance <= ID_LENGTH) return 0
    const items = groups.get(category)!
    let cursor = cursors.get(category)!
    while (cursor < items.length) {
      const item = items[cursor++]!
      cursors.set(category, cursor)
      const evidence = build(item, Math.min(allowance, remaining))
      if (!evidence) continue
      const used = evidence.id.length + evidence.label.length + evidence.text.length
      selected.push({ item, evidence })
      remaining -= used
      return used
    }
    return 0
  }

  // Reserved shares stop later logs from evicting earlier implementation facts.
  take("request", Math.min(remaining, Math.max(ID_LENGTH + 1, Math.floor(budget * SHARES.request))))
  for (const category of CATEGORIES.slice(1)) {
    let allowance = Math.min(remaining, Math.floor(budget * SHARES[category]))
    const slots = Math.max(1, Math.floor(limit * SHARES[category]))
    for (let count = 0; count < slots && allowance > ID_LENGTH; count++) {
      const used = take(category, allowance)
      if (!used) break
      allowance -= used
    }
  }

  // Spend unused reservations on fuller excerpts before admitting more noise.
  for (const entry of selected) {
    if (!remaining) break
    const old = entry.evidence
    const used = old.id.length + old.label.length + old.text.length
    const expanded = build(entry.item, used + remaining)
    if (!expanded) continue
    const growth = expanded.id.length + expanded.label.length + expanded.text.length - used
    if (growth > 0) {
      entry.evidence = expanded
      remaining -= growth
    }
  }

  const fill: Category[] = ["source", "structure", "inventory", "request", "recent", "assistant"]
  while (remaining > ID_LENGTH && selected.length < limit) {
    let progress = false
    for (const category of fill) {
      if (take(category, remaining)) progress = true
      if (remaining <= ID_LENGTH || selected.length >= limit) break
    }
    if (!progress) break
  }
  return selected.sort((a, b) => chronology(a.item, b.item)).map(({ evidence }) => evidence)
}
