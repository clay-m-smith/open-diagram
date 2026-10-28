import assert from "node:assert/strict"
import test from "node:test"
import { HISTORY_BYTES, HISTORY_LIMIT, HistorySchema } from "../src/diagram/history-model.js"
import { rememberHistory, restoreHistory, summarizeHistory } from "../src/diagram/history.js"
import { initialState, ViewSchema, type DiagramGranularity, type DiagramView } from "../src/diagram/model.js"

const sources = [{ id: "source", label: "model.ts" }, { id: "notation", label: "relations.ts" }, { id: "unused", label: "Not cited" }]
const view = (id = "model"): DiagramView => ({ id, label: id, graph: { title: id, summary: "Accepted model",
  nodes: [{ id: "node", label: "Node", kind: "service", detail: "Observed", status: "observed", evidence: ["source"] }], edges: [] } })
const empty = () => restoreHistory(undefined)
const snapshot = (views = [view()], updatedAt = 1, granularity: DiagramGranularity = "overview") => ({
  views, sources: sources.map(source => ({ ...source })), updatedAt, granularity,
})

test("history deduplicates canonical content by view and depth, refreshing time without losing citations", () => {
  const native = view()
  native.graph.notation = { version: 2, family: "architecture", groups: [
    { id: "group", label: "Group", kind: "module", parent: null, nodes: ["node"], evidence: ["notation"] },
  ], ports: [], links: [] }
  let history = rememberHistory(empty(), { ...snapshot([native]), sources: sources.map(source => ({ ...source, text: "PRIVATE_RAW_SOURCE" })) })
  assert.deepEqual(history.entries[0].sources, [sources[1], sources[0]])
  assert.deepEqual(history.entries[0].view, native)
  const id = history.entries[0].id
  const reordered = { graph: native.graph, label: native.label, id: native.id }
  history = rememberHistory(history, { ...snapshot([reordered], 5), sources: [...sources].reverse().map(source =>
    source.id === "unused" ? { ...source, label: "Unrelated change" } : source) })
  assert.equal(history.entries.length, 1)
  assert.equal(history.entries[0].id, id)
  assert.equal(history.entries[0].updatedAt, 5)
  history = rememberHistory(history, snapshot([native], 6, "granular"))
  history = rememberHistory(history, snapshot([{ ...native, id: "second" }], 7))
  history = rememberHistory(history, { ...snapshot([native], 8), sources: sources.map(source => ({ ...source, label: source.label + " changed" })) })
  assert.equal(history.entries.length, 4, "depth, view identity and cited labels are content")
  assert.ok(HistorySchema.safeParse(history).success)
  assert.doesNotMatch(JSON.stringify(history), /Not cited|PRIVATE_RAW_SOURCE/)
})

test("history retains 24 snapshots, evicts oldest and keeps acceptance view order on timestamp ties", () => {
  let history = empty()
  for (let i = 0; i < 30; i++) history = rememberHistory(history, snapshot([view(`v${i}`)], i))
  assert.equal(history.entries.length, HISTORY_LIMIT)
  assert.deepEqual(history.entries.map(entry => entry.view.id), Array.from({ length: 24 }, (_, i) => `v${29 - i}`))
  history = rememberHistory(history, snapshot([view("first"), view("second")], 30))
  assert.deepEqual(history.entries.slice(0, 2).map(entry => entry.view.id), ["first", "second"])
  history = rememberHistory(history, snapshot([view("v10")], 31))
  assert.equal(history.entries[0].view.id, "v10")
  assert.equal(history.entries.filter(entry => entry.view.id === "v10").length, 1)
})

test("UTF8 JSON byte budget evicts oldest before count limit; oversized incoming view preserves history", () => {
  const large = view()
  large.graph.nodes = Array.from({ length: 24 }, (_, i) => ({ ...large.graph.nodes[0], id: `n${i}`,
    label: "界".repeat(70), detail: "界".repeat(240), behavior: "界".repeat(600) }))
  assert.ok(ViewSchema.safeParse(large).success)
  let history = empty()
  for (let i = 0; i < 24; i++) history = rememberHistory(history, snapshot([{ ...large, id: `v${i}` }], i))
  assert.ok(history.entries.length > 1 && history.entries.length < HISTORY_LIMIT)
  assert.ok(Buffer.byteLength(JSON.stringify(history), "utf8") <= HISTORY_BYTES)
  assert.equal(history.entries[0].view.id, "v23")
  // Defensive skip, even if a future schema permits a view this large.
  const oversized = view("oversized"); oversized.graph.summary = "界".repeat(HISTORY_BYTES)
  assert.deepEqual(rememberHistory(history, snapshot([oversized], 99)), history)
})

test("restore rejects old, malformed, oversized, duplicate and content-tampered history without throwing", () => {
  const history = rememberHistory(empty(), snapshot())
  assert.deepEqual(restoreHistory(JSON.parse(JSON.stringify(history))), history)
  const tampered = structuredClone(history); tampered.entries[0].view.graph.title = "Changed graph"
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic
  for (const raw of [undefined, null, {}, { ...history, version: 0 }, tampered, cyclic,
    { ...history, entries: [history.entries[0], history.entries[0]] },
    { ...history, entries: Array(25).fill(history.entries[0]) },
    { ...history, padding: "x".repeat(HISTORY_BYTES) }]) assert.deepEqual(restoreHistory(raw), empty())
  const unsorted = rememberHistory(history, snapshot([view("second")], 2))
  unsorted.entries.reverse()
  assert.equal(restoreHistory(unsorted).entries[0].view.id, "second")
})

test("snapshots and restoration own their data; summaries mark exact current content including legacy graph", () => {
  const input = snapshot()
  const original = structuredClone(input)
  const history = rememberHistory(empty(), input)
  const baseline = structuredClone(history)
  const next = rememberHistory(history, snapshot([view("second")], 2))
  const restored = restoreHistory(history)
  input.views[0].graph.nodes[0].evidence.push("unused")
  input.sources[0].label = "Changed"
  next.entries[1].view.graph.title = "Mutated result"
  restored.entries[0].sources[0].label = "Mutated restore"
  assert.deepEqual(history, baseline)
  const state = { ...initialState("session"), graph: original.views[0].graph, sources: original.sources }
  const legacy = rememberHistory(history, snapshot([{ ...original.views[0], id: "overview", label: "Overview" }], 3))
  assert.deepEqual(summarizeHistory(legacy, state).map(item => item.current), [true, false])
  state.views = original.views
  const summaries = summarizeHistory(legacy, state)
  assert.deepEqual(summaries.map(item => item.current), [false, true])
  assert.equal(summaries[1].title, "model")
  assert.equal(summaries[1].label, "model")
  state.granularity = "granular"
  assert.ok(summarizeHistory(legacy, state).every(item => !item.current))
  assert.deepEqual(history, baseline, "summarizing never reorders or changes input")
})
