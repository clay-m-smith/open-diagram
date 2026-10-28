import assert from "node:assert/strict"
import test from "node:test"
import { createDiagramController, type DiagramClient, type RenderInput } from "../src/gui/controller.js"
import { initialState, type DiagramState } from "../src/diagram/model.js"
import type { DiagramHistoryEntry, DiagramHistorySummary } from "../src/diagram/history-model.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const location = { directory: "/project", workspaceID: "one" }
const ready = (revision = 1, epoch = "server"): DiagramState => ({ ...initialState("same"), epoch, revision, phase: "ready", relevant: true,
  graph: { title: "Pipeline", summary: "Summary", nodes: [{ id: "n", label: "Node", detail: "Detail", kind: "input", status: "observed", evidence: ["src"] }], edges: [] } })
function wire() {
  type Options = Parameters<DiagramClient["get"]>[1]
  const reads: Array<ReturnType<typeof deferred<DiagramState>> & { options: Options }> = []
  const renders: Array<ReturnType<typeof deferred<Awaited<ReturnType<DiagramClient["render"]>>>> & { input: RenderInput; options: Options }> = []
  const controls: unknown[] = []
  const listeners = new Set<Parameters<DiagramClient["events"]["on"]>[1]>()
  const client: DiagramClient = {
    get: (_, options) => { const task = { ...deferred<DiagramState>(), options }; reads.push(task); return task.promise },
    control: async (input) => { controls.push(input); return ready(2) },
    render: (input, options) => { const task = { ...deferred<Awaited<ReturnType<DiagramClient["render"]>>>(), input, options }; renders.push(task); return task.promise },
    history: async () => [],
    historyGet: async () => { throw new Error("No cached diagram") },
    renderHistory: async () => { throw new Error("No cached diagram") },
    events: { on: (_, listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
  }
  return { client, reads, renders, controls, listeners,
    emit(state: DiagramState, scope = location) { for (const listener of listeners) listener({ data: state, location: scope }) },
    image(index: number, svg: string) { const task = renders[index]; task.resolve({ ...task.input, svg }) },
  }
}

test("GUI isolates identical session/location ids across servers and cancels old owners", async (t) => {
  const a = wire(); const b = wire()
  const controller = createDiagramController(() => {})
  t.after(() => controller.dispose())
  controller.select({ server: "a", sessionID: "same", location, client: a.client })
  await settle(); a.reads[0].resolve(ready()); await settle()
  assert.deepEqual(a.reads[0].options.location, location)
  controller.select({ server: "b", sessionID: "same", location, client: a.client })
  assert.equal(controller.snapshot().state, undefined, "server identity matters even when transport object is reused")
  controller.select({ server: "b", sessionID: "same", location, client: b.client })
  assert.equal(a.listeners.size, 0)
  assert.equal(a.renders[0].options.signal.aborted, true)
  assert.equal(controller.snapshot().state, undefined)
  await settle(); b.reads[0].resolve(ready(3)); await settle()
  a.image(0, "old server"); a.emit(ready(99)); await settle()
  assert.equal(controller.snapshot().state?.revision, 3)
  assert.equal(controller.snapshot().svg, undefined)
  b.image(0, "new server"); await settle()
  assert.equal(controller.snapshot().svg, "new server")
  const pending = controller.read(); await settle(); controller.select(undefined)
  assert.equal(await pending, false)
  b.reads[1].resolve(ready(100)); await settle()
  assert.equal(controller.snapshot().state, undefined)
  assert.equal(b.listeners.size, 0)
  assert.equal(a.controls.length + b.controls.length, 0, "viewing never controls collection")
})

test("GUI rejects delayed renders, scopes events, reconciles epochs and retains failed-read snapshot", async (t) => {
  const rpc = wire(); const controller = createDiagramController(() => {})
  t.after(() => controller.dispose())
  controller.select({ server: "a", sessionID: "same", location, client: rpc.client })
  await settle(); rpc.reads[0].resolve(ready()); await settle()
  rpc.emit(ready(99), { ...location, workspaceID: "other" })
  assert.equal(controller.snapshot().state?.revision, 1)
  rpc.emit(ready(2)); await settle()
  assert.equal(rpc.renders[0].options.signal.aborted, true)
  rpc.image(1, "revision two"); await settle(); rpc.image(0, "revision one"); await settle()
  assert.equal(controller.snapshot().svg, "revision two")
  controller.inspect("n"); await settle(); controller.appearance("dark"); await settle()
  rpc.image(3, "dark selected"); await settle(); rpc.image(2, "light selected"); await settle()
  assert.equal(controller.snapshot().svg, "dark selected")
  const retry = controller.read(); await settle(); rpc.reads[1].reject(new Error("offline")); await retry
  assert.equal(controller.snapshot().state?.revision, 2)
  assert.equal(controller.snapshot().svg, "dark selected")
  assert.match(controller.snapshot().problem!, /unavailable/)
  rpc.emit(ready(0, "unknown")); await settle()
  assert.equal(controller.snapshot().state?.epoch, "server", "unknown epoch requires authoritative GET")
  rpc.reads[2].resolve(ready(0, "next")); await settle()
  rpc.emit(ready(500)); await settle()
  assert.equal(controller.snapshot().state?.epoch, "next")
  assert.equal(rpc.reads.length, 3, "retired epoch does not trigger new requests")
  assert.equal(rpc.controls.length, 0)
  controller.dispose()
  assert.equal(rpc.listeners.size, 0)
  assert.equal(rpc.renders.at(-1)!.options.signal.aborted, true)
})

test("GUI retains same-session image across client replacement and retries event subscription", async (t) => {
  const old = wire(); const next = wire()
  const controller = createDiagramController(() => {})
  t.after(() => controller.dispose())
  controller.select({ server: "a", sessionID: "same", location, client: old.client })
  await settle(); old.reads[0].resolve(ready()); await settle(); old.image(0, "cached"); await settle()
  const on = next.client.events.on
  let broken = true
  next.client.events.on = (...args) => { if (broken) throw new Error("offline"); return on(...args) }
  controller.select({ server: "a", sessionID: "same", location, client: next.client })
  await settle(); next.reads[0].reject(new Error("offline")); await settle()
  assert.equal(controller.snapshot().svg, "cached")
  broken = false
  const retried = controller.read(); await settle(); next.reads[1].resolve(ready(2)); await retried; await settle()
  assert.equal(next.listeners.size, 1)
  assert.equal(controller.snapshot().problem, undefined)
  next.emit(ready(3)); await settle()
  assert.equal(controller.snapshot().state?.revision, 3)
})

test("GUI never exposes an old image as the current revision after render failure", async (t) => {
  const rpc = wire(); const controller = createDiagramController(() => {})
  t.after(() => controller.dispose())
  controller.select({ server: "a", sessionID: "same", location, client: rpc.client })
  await settle(); rpc.reads[0].resolve(ready()); await settle(); rpc.image(0, "revision one"); await settle()
  rpc.emit(ready(2)); await settle()
  assert.equal(controller.snapshot().svg, undefined)
  rpc.renders[1].reject(new Error("render unavailable")); await settle()
  assert.equal(controller.snapshot().state?.revision, 2)
  assert.equal(controller.snapshot().svg, undefined, "Save SVG cannot export a superseded revision")
  assert.match(controller.snapshot().problem!, /unavailable/)
})

test("GUI keeps historical selection during live updates, returns to Live and cancels cross-session history", async (t) => {
  const rpc = wire(); const controller = createDiagramController(() => {})
  t.after(() => controller.dispose())
  const entry: DiagramHistoryEntry = { id: "a".repeat(24), granularity: "overview", updatedAt: 1,
    view: { id: "overview", label: "Old", graph: { ...ready().graph!, title: "Historical graph" } }, sources: [{ id: "src", label: "Old source" }] }
  const summary: DiagramHistorySummary = { id: entry.id, granularity: entry.granularity, updatedAt: entry.updatedAt,
    viewID: entry.view.id, label: entry.view.label, title: entry.view.graph.title, current: false }
  const picks: Array<ReturnType<typeof deferred<DiagramHistoryEntry>> & { signal: AbortSignal }> = []
  let archiveCalls = 0
  let archive = [summary]
  rpc.client.history = async () => archive
  rpc.client.historyGet = (_, options) => { const pending = { ...deferred<DiagramHistoryEntry>(), signal: options.signal }; picks.push(pending); return pending.promise }
  rpc.client.renderHistory = async (input) => { archiveCalls++; return { sessionID: input.sessionID, snapshotID: input.snapshotID, svg: "historical SVG" } }
  controller.select({ server: "a", sessionID: "same", location, client: rpc.client })
  await settle(); rpc.reads[0].resolve(ready()); await settle()
  assert.deepEqual(controller.snapshot().history, archive)
  const selecting = controller.chooseHistory(entry.id); await settle(); picks[0].reject(new Error("temporary")); await selecting
  assert.equal(controller.snapshot().historical, undefined)
  const retry = controller.read(); await settle(); rpc.reads[1].resolve(ready()); picks[1].resolve(entry); await retry; await settle()
  assert.equal(controller.snapshot().historical?.sources[0].label, "Old source")
  assert.equal(controller.snapshot().svg, "historical SVG")
  rpc.emit(ready(2)); await settle()
  assert.equal(controller.snapshot().state?.revision, 2)
  assert.equal(controller.snapshot().snapshotID, entry.id)
  assert.equal(controller.snapshot().svg, "historical SVG")
  assert.equal(archiveCalls, 1, "live revisions do not rerender immutable history")
  controller.live(); await settle()
  assert.equal(controller.snapshot().snapshotID, undefined)
  assert.equal(controller.snapshot().historical, undefined)
  assert.equal(controller.snapshot().svg, undefined)
  const late = controller.chooseHistory(entry.id); await settle()
  controller.select({ server: "other", sessionID: "same", location, client: rpc.client })
  assert.equal(picks[2].signal.aborted, true)
  picks[2].resolve(entry); await late; await settle()
  assert.equal(controller.snapshot().historical, undefined)
  rpc.reads.at(-1)!.resolve(ready(3)); await settle()
  const again = controller.chooseHistory(entry.id); await settle(); picks[3].resolve(entry); await again; await settle()
  archive = []
  rpc.emit(ready(4)); await settle()
  assert.equal(controller.snapshot().snapshotID, undefined, "pruned history returns to Live explicitly")
  assert.match(controller.snapshot().historyProblem!, /expired/)
  assert.equal(rpc.controls.length, 0, "browsing history never changes tracking or starts authoring")
})
