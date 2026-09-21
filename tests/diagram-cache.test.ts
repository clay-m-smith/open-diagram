import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { DiagramEngine, type EngineDependencies } from "../src/diagram/engine.js"
import { evidenceKey, StoredDiagramSchema, type StoredDiagram } from "../src/diagram/cache.js"
import type { Evidence } from "../src/diagram/evidence.js"
import { StateSchema, type DiagramAnalysis, type DiagramView } from "../src/diagram/schema.js"
import { authorRequest } from "../src/diagram/author.js"

const evidence: Evidence[] = [
  { id: "model_source", label: "read model.py", text: "Convolution(input=4, output=128)", category: "source", at: 1 },
  { id: "train_source", label: "read train.py", text: "Objective: squared error, batch=16", category: "source", at: 2 },
]
const view = (id: string, source: string, label = id): DiagramView => ({ id, label: id, graph: {
  title: id, summary: "Observed implementation", nodes: [{ id: "node", label, kind: "operation", detail: "Observed source", status: "observed", evidence: [source] }], edges: [],
} })
const views = [view("model", "model_source"), view("training", "train_source")]
const analysis = (items = views): DiagramAnalysis => ({ relevant: true, reason: "Observed implementation", views: items, graph: items[0].graph })
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000
  while (!await predicate()) { assert.ok(Date.now() < deadline, "cache transition deadline"); await delay(2) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture(analyze: NonNullable<EngineDependencies["analyze"]>) {
  const saved = new Map<string, StoredDiagram>()
  let writes = 0
  const deps: EngineDependencies = { intervalMs: 5, debounceMs: 3, analyze, load: async (id) => saved.get(id),
    save: async (id, state) => { writes++; saved.set(id, structuredClone(state)) }, publish: async () => {} }
  return { saved, deps, writes: () => writes }
}

test("accepted diagrams survive reload and both depths; Refresh, timestamps and progress have zero authoring cost", async () => {
  let calls = 0
  const h = fixture(async (_e, _p, _f, _s, depth) => { calls++; return analysis(views.map((item) => ({ ...item, graph: { ...item.graph, summary: depth } }))) })
  let engine = new DiagramEngine(h.deps)
  try {
    await engine.observe("a", evidence)
    await until(() => h.saved.get("a")?.memo?.entries.length === 1)
    const original = await engine.get("a")
    const writes = h.writes()
    for (let index = 0; index < 10; index++) {
      await engine.observe("a", [...evidence.map((item) => ({ ...item, at: index + 100 })).reverse(),
        { id: `progress_${index}`, label: "Progress", text: `Completed ${index} checks`, category: "assistant" },
        { id: `message_${index}`, label: "User request", text: `Follow-up message ${index}`, category: "request" },
        { id: `log_${index}`, label: "shell", text: `Test results ${index}`, category: "recent" }])
      await engine.control("a", undefined, true)
    }
    await delay(15)
    assert.equal(calls, 1)
    assert.equal(h.writes(), writes, "noise and cached Refresh cause no persistence churn")
    assert.equal((await engine.get("a")).updatedAt, original.updatedAt)
    await engine.control("a", undefined, false, undefined, "granular")
    await until(() => calls === 2 && h.saved.get("a")?.memo?.entries.length === 2)
    const granular = await engine.get("a")
    await engine.control("a", undefined, false, undefined, "overview")
    assert.deepEqual((await engine.get("a")).views, original.views)
    await engine.dispose()
    engine = new DiagramEngine(h.deps)
    await engine.get("a")
    await engine.observe("a", evidence)
    await engine.control("a", undefined, true)
    await engine.control("a", undefined, false, undefined, "granular")
    assert.deepEqual((await engine.get("a")).views, granular.views)
    assert.equal((await engine.get("a")).updatedAt, granular.updatedAt)
    await delay(15)
    assert.equal(calls, 2, "reload and cached depth toggle issue no model calls")
    assert.equal("memo" in await engine.get("a"), false, "internal memo never leaks through RPC snapshot")
    assert.equal(StoredDiagramSchema.parse(h.saved.get("a")).memo!.entries.length, 2)
    assert.ok(StateSchema.safeParse(await engine.get("a")).success)
  } finally { await engine.dispose() }
})

test("known source change updates only dependent view; bursts and duplicate Refresh coalesce", async () => {
  const calls: { data: readonly Evidence[]; update?: { views: DiagramView[] }; gate: ReturnType<typeof deferred<DiagramAnalysis>> }[] = []
  const h = fixture(async (data, _p, _f, _s, _d, update) => {
    const gate = deferred<DiagramAnalysis>(); calls.push({ data, update, gate }); return gate.promise
  })
  const engine = new DiagramEngine(h.deps)
  try {
    await engine.observe("a", evidence)
    await until(() => calls.length === 1)
    calls[0].gate.resolve(analysis())
    await until(() => !!h.saved.get("a"))
    for (let width = 129; width < 139; width++) await engine.observe("a", [{ ...evidence[0], text: `Convolution(input=4, output=${width})` }, evidence[1]])
    await until(() => calls.length === 2)
    assert.deepEqual(calls[1].update?.views.map((item) => item.id), ["model"])
    assert.deepEqual(calls[1].data.map((item) => item.id), ["model_source"])
    assert.match(calls[1].data[0].text, /138/)
    for (let index = 0; index < 10; index++) await engine.control("a", undefined, true)
    calls[1].gate.resolve(analysis([view("model", "model_source", "Conv 138")]))
    await until(async () => (await engine.get("a")).views[0].graph.nodes[0].label === "Conv 138")
    await delay(20)
    assert.equal(calls.length, 2, "same in-flight work never queues redundant successor")
    assert.deepEqual((await engine.get("a")).views[1], views[1], "untouched training view preserved exactly")
  } finally { for (const call of calls) call.gate.resolve(analysis()); await engine.dispose() }
})

test("known edits can incrementally update all views; new sources still permit a full replan", async () => {
  for (const selected of [[views[0]], views]) {
    const scopes: (string[] | undefined)[] = []
    const data = evidence.slice(0, selected.length)
    const h = fixture(async (input, _p, _f, _s, _d, update) => {
      scopes.push(update?.views.map(view => view.id))
      if (scopes.length === 3) assert.ok(input.some(item => item.id === "new_source"), "unknown scope must include new evidence, not only cached dependencies")
      if (update) {
        assert.equal(update.replaceAll, true, "all-view updates allow structural reorganization rather than freezing view count")
        return analysis([...selected, { ...selected[0], id: "expanded", label: "Expanded" }])
      }
      return analysis(selected)
    })
    const engine = new DiagramEngine(h.deps)
    try {
      await engine.observe("all", data)
      await until(() => !!h.saved.get("all"))
      const changed = data.map(item => ({ ...item, text: item.text + " changed" }))
      await engine.observe("all", changed)
      await until(() => scopes.length === 2)
      assert.deepEqual(scopes[1], selected.map(view => view.id))
      await until(async () => (await engine.get("all")).views.length === selected.length + 1)
      await engine.observe("all", [...changed, { id: "new_source", label: "New source", text: "New subsystem", category: "source" }])
      await until(() => scopes.length === 3)
       assert.deepEqual(scopes[2], [...selected.map(view => view.id), "expanded"], "unknown scope supplies reusable baseline while replaceAll permits new views")
    } finally { await engine.dispose() }
  }
})

test("compacted focus changes replan all tabs, while ordinary source edits keep focus in narrowed input", async () => {
  const focus: Evidence = { id: "focus", label: "Compacted context", text: "Current design is Model A", category: "context" }
  const currentViews = structuredClone(views)
  currentViews[1].graph.nodes[0].evidence.push("focus")
  let calls = 0
  const h = fixture(async (input, _p, _f, _s, _d, update) => {
    calls++
    assert.ok(input.some(item => item.id === "focus"))
    if (calls === 2) {
      assert.deepEqual(update?.views.map(view => view.id), ["model"])
      return analysis([currentViews[0]])
    }
    if (calls === 3) {
      assert.equal(update?.replaceAll, true, "new focus must not freeze an old uncited primary model tab")
      assert.equal(update.views.length, 2)
    }
    return analysis(currentViews)
  })
  const engine = new DiagramEngine(h.deps)
  try {
    await engine.observe("focus", [...evidence, focus])
    await until(() => !!h.saved.get("focus"))
    const changed = [{ ...evidence[0], text: "Convolution 256" }, evidence[1]]
    await engine.observe("focus", [...changed, focus])
    await until(() => calls === 2 && h.saved.get("focus")?.phase === "ready")
    await engine.observe("focus", [...changed, { ...focus, text: "Current design is Model B; Model A is retired" }])
    await until(() => calls === 3)
  } finally { await engine.dispose() }
})

test("failed incremental update never erases accepted output; unchanged noise does not retry; explicit retry can recover", async () => {
  let calls = 0; let fail = true
  const h = fixture(async (_data, _p, _f, _s, _d, update) => {
    calls++
    if (update && fail) throw new Error("Fixture unavailable")
    return analysis(update ? [view("model", "model_source", "Conv 256")] : views)
  })
  let engine = new DiagramEngine(h.deps)
  try {
    await engine.observe("a", evidence)
    await until(() => !!h.saved.get("a"))
    const good = await engine.get("a")
    const next = [{ ...evidence[0], text: "Convolution(input=4, output=256)" }, evidence[1]]
    await engine.observe("a", next)
    await until(async () => !!(await engine.get("a")).updateError)
    assert.deepEqual((await engine.get("a")).views, good.views)
    assert.equal((await engine.get("a")).phase, "ready")
    assert.equal((await engine.get("a")).updatedAt, good.updatedAt)
    await engine.observe("a", next.map((item) => ({ ...item, at: 999 })))
    await delay(20)
    assert.equal(calls, 2)
    await engine.dispose()
    engine = new DiagramEngine(h.deps)
    await engine.observe("a", next)
    await delay(20)
    assert.equal(calls, 2, "reload cannot retry the same failed input implicitly")
    assert.deepEqual((await engine.get("a")).views, good.views)
    fail = false
    await engine.control("a", undefined, true)
    await until(async () => (await engine.get("a")).views[0].graph.nodes[0].label === "Conv 256")
    assert.equal((await engine.get("a")).updateError, null)
    await engine.observe("a", [])
    assert.equal((await engine.get("a")).views.length, 2, "temporary empty context cannot erase working diagrams")
  } finally { await engine.dispose() }
})

test("cache keys ignore ordering/time but include content, depth and author namespace; main-agent publication need not start automatic work", async () => {
  assert.equal(evidenceKey(evidence, "overview"), evidenceKey([...evidence].reverse().map((item) => ({ ...item, at: 777 })), "overview"))
  assert.notEqual(evidenceKey(evidence, "overview"), evidenceKey(evidence, "granular"))
  assert.notEqual(evidenceKey(evidence, "overview", "old"), evidenceKey(evidence, "overview", "new"))
  let calls = 0
  const h = fixture(async () => { calls++; return analysis() })
  const engine = new DiagramEngine(h.deps)
  try {
    await engine.observe("a", evidence, false)
    const snapshot = await engine.snapshot("a")
    await engine.submit("a", snapshot.token, { relevant: true, reason: "Main agent published", views })
    await engine.observe("a", evidence)
    await engine.control("a", undefined, true)
    await delay(20)
    assert.equal(calls, 0, "main-agent authoring path avoids duplicate secondary generation")
    const packet = authorRequest([evidence[0]], views[0].graph, false, "granular", { views: [views[0]] })
    assert.match(packet.request.instruction, /Incremental update/)
    assert.match(packet.request.instruction, /Unselected views are cached/)
    assert.doesNotMatch(JSON.stringify(packet.request.input), /train_source/)
  } finally { await engine.dispose() }
})
