import assert from "node:assert/strict"
import test from "node:test"
import { AUTHOR_DRAFT_TOOLS, createAuthorDraft } from "../src/diagram/author-draft.js"
import type { DiagramView } from "../src/diagram/model.js"

const evidence = [{ id: "e1", label: "Source", text: "Observed system" }]
const node = (id: string) => ({ id, label: id, kind: "service", detail: "detail", status: "observed" as const, evidence: ["e1"] })
const baseline = (): DiagramView[] => [{ id: "main", label: "Main", graph: {
  title: "System", summary: "Summary", nodes: [{ ...node("a"), behavior: "Retained behavior" }], edges: [],
} }]
function ok(value: unknown) { assert.deepEqual(value, { ok: true }) }

test("ordered incomplete composition validates only when repaired; schemas remain discoverable", () => {
  assert.deepEqual(Object.keys(AUTHOR_DRAFT_TOOLS), ["inspect", "view", "node", "edge", "notation", "remove", "validate"])
  for (const tool of Object.values(AUTHOR_DRAFT_TOOLS)) assert.ok(tool.description && tool.input)
  const draft = createAuthorDraft({ evidence })
  ok(draft.execute("view", { id: "main", label: "Main", title: "System", summary: "Summary", reason: "Observed system", defaults: { status: "observed", evidence: ["e1"] } }))
  ok(draft.execute("edge", { view: "main", edge: { from: "a", to: "b", label: "calls" } }))
  ok(draft.execute("node", { view: "main", node: { id: "a", label: "A" } }))
  assert.equal(draft.validate().ok, false)
  ok(draft.execute("node", { view: "main", node: { id: "a", kind: "service", detail: "" } }))
  ok(draft.execute("node", { view: "main", node: node("b") }))
  const result = draft.validate()
  assert.ok(result.ok)
  assert.equal(result.value.views[0].graph.nodes[0].status, "observed")
  ok(draft.execute("remove", { target: "view", view: "main" }))
  assert.deepEqual(draft.validate(), { ok: true, value: { relevant: false, reason: "Observed system", views: [] } })
})

test("partial upserts preserve baseline fields; inputs and every output are isolated", () => {
  const views = baseline()
  const original = structuredClone(views)
  const draft = createAuthorDraft({ evidence, views })
  views[0].graph.nodes[0].detail = "external mutation"
  ok(draft.execute("view", { id: "main", reason: "Changed label", defaults: { status: "planned", evidence: ["missing"] } }))
  const patch = { view: "main", node: { id: "a", label: "New" } }
  ok(draft.execute("node", patch)); patch.node.label = "external"
  const snapshot: any = draft.inspect()
  assert.deepEqual(snapshot.views[0].graph.nodes[0], { ...original[0].graph.nodes[0], label: "New" })
  snapshot.views[0].graph.nodes[0].detail = "output mutation"
  const result = draft.validate(); assert.ok(result.ok)
  result.value.views[0].graph.nodes[0].detail = "validation mutation"
  const second = draft.validate(); assert.ok(second.ok)
  assert.equal(second.value.views[0].graph.nodes[0].detail, "detail")
  assert.equal(original[0].graph.nodes[0].label, "a")
})

test("invalid operations roll back entirely, reject arbitrary paths and prototype keys", () => {
  const draft = createAuthorDraft({ evidence, views: baseline() })
  const before = draft.inspect()
  for (const [name, input] of [
    ["node", { view: "main", node: { id: "a", status: "wrong" } }],
    ["node", { view: "main", node: { id: "a", path: "/graph/title", value: "x" } }],
    ["view", JSON.parse('{"id":"main","__proto__":{"polluted":true}}')],
    ["notation", { view: "main", family: "flowchart", field: "steps", index: 2, value: { node: "a", shape: "process", evidence: ["e1"] } }],
    ["edge", { view: "main", index: 0, edge: { label: "x" } }],
    ["constructor", {}],
  ] as const) {
    assert.equal((draft.execute(name, input) as any).ok, false)
    assert.deepEqual(draft.inspect(), before)
  }
  ok(draft.execute("view", { id: "main", reason: "Repairable" }))
  ok(draft.execute("node", { view: "main", node: { id: "a", evidence: ["missing"] } }))
  assert.equal(draft.validate().ok, false)
  ok(draft.execute("node", { view: "main", node: { id: "a", evidence: ["e1"] } }))
  assert.equal(draft.validate().ok, true)
})

test("notation collection and record edits preserve unrelated fields, enforce final coverage and citations", () => {
  const draft = createAuthorDraft({ evidence, views: baseline() })
  ok(draft.execute("view", { id: "main", reason: "Notation" }))
  const set = (field: string, value: unknown, index?: number) => draft.execute("notation", { view: "main", family: "flowchart", field, value, ...(index === undefined ? {} : { index }) })
  ok(set("groups", [])); ok(set("branches", []))
  assert.equal(draft.validate().ok, false)
  ok(set("steps", { node: "a", shape: "process", evidence: ["missing"] }, 0))
  assert.equal(draft.validate().ok, false)
  ok(set("steps", { node: "a", shape: "decision", evidence: ["e1"] }, 0))
  const result = draft.validate(); assert.ok(result.ok)
  assert.deepEqual(result.value.views[0].graph.notation, { version: 2, family: "flowchart", groups: [], branches: [], steps: [{ node: "a", shape: "decision", evidence: ["e1"] }] })
  ok(draft.execute("edge", { view: "main", edge: { from: "a", to: "a", label: "loop" } }))
  assert.equal(draft.validate().ok, false)
  ok(set("branches", [{ edge: 0, condition: "again", evidence: ["e1"] }]))
  assert.equal(draft.validate().ok, true)
  ok(draft.execute("remove", { target: "edge", view: "main", index: 0 }))
  assert.equal((draft.inspect() as any).views[0].graph.notation, null)
  assert.equal(draft.validate().ok, true)
})

test("message index shifts clear dependent ranges instead of silently retargeting", () => {
  const draft = createAuthorDraft({ evidence, views: baseline() })
  const set = (field: string, value: unknown) => draft.execute("notation", { view: "main", family: "sequence", field, value })
  ok(set("participants", ["a"]))
  ok(set("messages", [{ id: "m1", from: "a", to: "a", label: "call", kind: "sync", evidence: ["e1"] }, { id: "m2", from: "a", to: "a", label: "return", kind: "return", evidence: ["e1"] }]))
  ok(set("activations", [{ node: "a", from: 0, to: 1 }]))
  ok(draft.execute("remove", { target: "record", view: "main", family: "sequence", field: "messages", index: 0 }))
  const notation = (draft.inspect() as any).views[0].graph.notation
  assert.deepEqual(notation.activations, []); assert.deepEqual(notation.fragments, [])
  assert.equal(notation.messages[0].id, "m2")
})

test("hard counts, UTF-8 bytes, mutation budget and final policy limits are bounded", () => {
  const draft = createAuthorDraft({ evidence, views: baseline(), maxNodes: 1, viewIDs: ["main"] })
  ok(draft.execute("view", { id: "main", reason: "Budget" }))
  ok(draft.execute("node", { view: "main", node: node("b") }))
  assert.equal(draft.validate().ok, false)
  ok(draft.execute("remove", { target: "node", view: "main", id: "b" }))
  ok(draft.execute("view", { id: "other" }))
  assert.equal(draft.validate().ok, false)
  ok(draft.execute("remove", { target: "view", view: "other" }))
  assert.equal(draft.validate().ok, true)
  for (let i = 1; i < 24; i++) ok(draft.execute("node", { view: "main", node: node(`n${i}`) }))
  let before = draft.inspect()
  assert.equal((draft.execute("node", { view: "main", node: node("overflow") }) as any).ok, false)
  assert.deepEqual(draft.inspect(), before)
  assert.equal((draft.execute("view", { id: "main", reason: "界".repeat(50_000) }) as any).ok, false)
  assert.deepEqual(draft.inspect(), before)
  for (const id of ["v2", "v3", "v4"]) ok(draft.execute("view", { id }))
  before = draft.inspect()
  assert.equal((draft.execute("view", { id: "v5" }) as any).ok, false)
  assert.deepEqual(draft.inspect(), before)
  const limited = createAuthorDraft({ evidence, views: baseline() })
  for (let i = 0; i < 256; i++) ok(limited.execute("view", { id: "main", reason: "Bounded" }))
  assert.equal((limited.execute("view", { id: "main", reason: "Overflow" }) as any).ok, false)
  assert.equal(limited.validate().ok, true)
  const counts = createAuthorDraft({ evidence })
  for (const view of ["one", "two"]) {
    ok(counts.execute("view", { id: view }))
    for (let i = 0; i < 24; i++) ok(counts.execute("node", { view, node: node(`n${i}`) }))
  }
  ok(counts.execute("view", { id: "three" }))
  before = counts.inspect()
  assert.equal((counts.execute("node", { view: "three", node: node("overTotal") }) as any).ok, false)
  assert.deepEqual(counts.inspect(), before)
  for (let i = 0; i < 48; i++) ok(counts.execute("edge", { view: "one", edge: { from: "n0", to: "n1", label: `edge${i}` } }))
  before = counts.inspect()
  assert.equal((counts.execute("edge", { view: "one", edge: { from: "n0", to: "n1", label: "overflow" } }) as any).ok, false)
  assert.deepEqual(counts.inspect(), before)
  for (let i = 0; i < 24; i++) ok(counts.execute("notation", { view: "one", family: "flowchart", field: "steps", index: i, value: { node: `n${i}`, shape: "process", evidence: ["e1"] } }))
  before = counts.inspect()
  assert.equal((counts.execute("notation", { view: "one", family: "flowchart", field: "steps", index: 24, value: { node: "extra", shape: "process", evidence: ["e1"] } }) as any).ok, false)
  assert.deepEqual(counts.inspect(), before, "record append cannot bypass collection count limits")
})
