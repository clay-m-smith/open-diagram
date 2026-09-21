import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { collectEvidence, mergeEvidence } from "../src/diagram/evidence.js"
import { evidenceKey } from "../src/diagram/cache.js"
import { authorRequest } from "../src/diagram/author.js"
import { materialEvidence } from "../src/diagram/cache.js"
import { SnapshotSchema } from "../src/diagram/schema.js"

function tool(id: string, name: string, input: unknown, text: string, at: number): SessionMessageInfo {
  return { type: "assistant", id, time: { created: at }, content: [{ type: "tool", id, name,
    time: { completed: at }, state: { status: "completed", input, content: [{ type: "text", text }] } }] } as unknown as SessionMessageInfo
}
const read = (id: string, path: string, text: string, at: number, offset = 1) => tool(id, "read", { path, offset }, text, at)
const edit = (id: string, path: string, oldString: string, newString: string, at: number) => tool(id, "edit", { path, oldString, newString }, "Success", at)

test("coalesced partial edits and later head reread retain all observed mutations", () => {
  const start = [read("base", "/project/model.py", "encoder = Linear\nactivation = ReLU", 1), read("tail", "/project/model.py", "activation = ReLU", 2, 100)]
  const baseline = mergeEvidence(collectEvidence(start), [])
  const changed = mergeEvidence(collectEvidence([...start,
    edit("edit1", "/project/model.py", "Linear", "Embedding", 3),
    edit("edit2", "/project/model.py", "ReLU", "GELU", 4),
    read("head", "/project/model.py", "encoder = Linear\nactivation = ReLU", 5),
  ]), [])
  assert.match(changed.map((item) => item.text).join("\n"), /Embedding/)
  assert.match(changed.map((item) => item.text).join("\n"), /GELU/)
  assert.equal(changed.filter((item) => item.mutation).length, 2)
  assert.equal(new Set(changed.map((item) => item.id)).size, changed.length)
  assert.notEqual(evidenceKey(changed, "overview"), evidenceKey(baseline, "overview"))
})

test("cross-category observations have unique citations and cannot overwrite successful edit", () => {
  for (const path of ["/project/data.json", "/project/styles.css"]) {
    const start = read("base", path, "{ value: 1 }", 1)
    const first = mergeEvidence(collectEvidence([start, edit("edit1", path, "1", "2", 2)]), [])
    const second = mergeEvidence(collectEvidence([start, edit("edit1", path, "1", "2", 2), edit("edit2", path, "2", "3", 3)]), [])
    assert.equal(new Set(second.map((item) => item.id)).size, second.length)
    assert.match(second.filter((item) => item.mutation).map((item) => item.text).join("\n"), /replacement text:\n3/)
    assert.notEqual(evidenceKey(first, "overview"), evidenceKey(second, "overview"))
  }
})

test("equal timestamp reads retain latest transcript observation", () => {
  const data = collectEvidence([read("old", "/project/model.py", "class OldEncoder: pass", 1), read("new", "/project/model.py", "class NewEncoder: pass", 1)])
  assert.equal(data.length, 1)
  assert.match(data[0].text, /NewEncoder/)
  assert.doesNotMatch(data[0].text, /OldEncoder/)
})

test("opaque source fingerprints detect changes beyond bounded excerpts", () => {
  const prefix = "# introductory comment\n".repeat(400)
  const first = collectEvidence([tool("write", "write", { path: "/project/model.py", content: `${prefix}\nencoder = Linear` }, "Success", 1)])
  const second = collectEvidence([tool("write", "write", { path: "/project/model.py", content: `${prefix}\nencoder = Embedding` }, "Success", 2)])
  assert.equal(first[0].id, second[0].id)
  assert.equal(first[0].text, second[0].text, "test exercises unseen excerpt tail")
  assert.notEqual(evidenceKey(first, "overview"), evidenceKey(second, "overview"))
  assert.ok(second[0].text.length <= 4000)
})

test("inventory updates are material even alongside unchanged user request", () => {
  const request = { type: "user", id: "user", time: { created: 1 }, text: "Diagram repository layout" } as unknown as SessionMessageInfo
  const first = collectEvidence([request, tool("glob1", "glob", { pattern: "src/**" }, "src/api.ts", 2)])
  const same = collectEvidence([request, tool("glob2", "glob", { pattern: "src/**" }, "src/api.ts", 3)])
  const changed = collectEvidence([request, tool("glob3", "glob", { pattern: "src/**" }, "src/api.ts\nsrc/worker.ts", 4)])
  assert.equal(evidenceKey(first, "overview"), evidenceKey(same, "overview"))
  assert.notEqual(evidenceKey(first, "overview"), evidenceKey(changed, "overview"))
})

test("public compaction retains current project focus without admitting reasoning or child objectives", () => {
  const summary = "## Objective\nDevelop the current covariance receiver, not the retired three-head separator.\n## Current design\nRaw IQ -> moment estimates -> learned covariance -> solve -> range Doppler.\n## Next\nRecover halted training; recovery is supporting work."
  const compact = (text: string, at: number) => ({ type: "compaction", id: `compact${at}`, time: { created: at }, status: "completed", summary: text,
    recent: "PRIVATE RECENT", providerState: { private: "PRIVATE PROVIDER" } }) as unknown as SessionMessageInfo
  const source = read("source", "receiver.py", "def forward(iq): return solve(covariance(iq), iq)", 3)
  const first = collectEvidence([compact(summary, 1), source])
  const focus = first.find(item => item.category === "context")!
  assert.match(focus.text, /current covariance receiver/)
  assert.match(focus.label, /historical, not source proof/)
  assert.ok(materialEvidence(first).includes(focus), "native author selection and fingerprinting retain focus even alongside source")
  assert.ok(SnapshotSchema.shape.evidence.safeParse(first).success)
  assert.equal(evidenceKey(first, "overview"), evidenceKey(collectEvidence([compact(summary, 2), source]), "overview"), "same summary reobservation has no inference cost")
  const next = collectEvidence([compact(summary, 1), compact(summary + "\nCurrent geometry: 8 by 32.", 4), source])
  assert.equal(next.filter(item => item.category === "context").length, 1)
  assert.notEqual(evidenceKey(first, "overview"), evidenceKey(next, "overview"))
  const merged = mergeEvidence(next, collectEvidence([compact("Child task: audit receipts", 10)]))
  assert.match(merged.find(item => item.category === "context")!.text, /Current geometry/)
  assert.doesNotMatch(JSON.stringify(merged), /PRIVATE|Child task/)
  assert.equal(collectEvidence([{ ...compact(summary, 1), status: "running" } as SessionMessageInfo]).length, 0)
})

test("incremental contract exposes and enforces remaining aggregate node budget", () => {
  const evidence = [{ id: "source", label: "source", text: "implementation" }]
  const node = { id: "node", label: "Node", kind: "operation", detail: "", status: "observed" as const, evidence: ["source"] }
  const view = { id: "model", label: "Model", graph: { title: "Model", summary: "", nodes: [node], edges: [] } }
  const author = authorRequest(evidence, view.graph, false, "overview", { views: [view], maxNodes: 1 })
  assert.match(author.request.instruction, /at most 1 nodes TOTAL/)
  assert.throws(() => author.parse(JSON.stringify({ relevant: true, reason: "test", views: [{ ...view, graph: { ...view.graph,
    nodes: [{ ...node, evidence: ["e1"] }, { ...node, id: "other", evidence: ["e1"] }] } }] })), /remaining 1-node/)
})
