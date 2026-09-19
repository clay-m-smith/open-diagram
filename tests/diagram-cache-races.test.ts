import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { SessionMessageInfo } from "@opencode/client"
import { DiagramEngine } from "../src/diagram/engine.js"
import { collectEvidence, mergeEvidence, type Evidence } from "../src/diagram/evidence.js"
import { affectedViews, evidenceFingerprints, evidenceKey } from "../src/diagram/cache.js"
import { generationNamespace } from "../src/diagram/server.js"
import { ConfigSchema } from "../src/diagram/config.js"
import type { DiagramAnalysis, DiagramView } from "../src/diagram/schema.js"

const source = (text: string): Evidence[] => [{ id: "source", label: "model.py", text: `${text}: encoder -> classifier`, category: "source" }]
const analysis = (label: string, id = "source"): DiagramAnalysis => ({ relevant: true, reason: "Observed model", graph: {
  title: "Model", summary: "", nodes: [{ id: "model", label, kind: "model", detail: "", status: "observed", evidence: [id] }], edges: [],
} })
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 1000
  while (!await predicate()) { assert.ok(Date.now() < end, "transition deadline"); await delay(2) }
}
function fixture() {
  const calls: { text: string; signal: AbortSignal; resolve(value: DiagramAnalysis): void; reject(error: Error): void }[] = []
  const engine = new DiagramEngine({ intervalMs: 2, debounceMs: 8, load: async () => undefined, save: async () => {}, publish: async () => {},
    analyze: (data, _p, _f, signal) => new Promise((resolve, reject) => {
      calls.push({ text: data[0]?.text ?? "EMPTY", signal, resolve, reject })
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
    }),
  })
  const accept = async () => {
    await engine.observe("a", source("Architecture A"))
    await until(() => calls.length === 1)
    calls[0].resolve(analysis("A"))
    await until(async () => (await engine.get("a")).phase === "ready")
  }
  const dispose = async () => { for (const call of calls) call.resolve(analysis("cleanup")); await engine.dispose() }
  return { engine, calls, accept, dispose }
}

test("cache-hit cancellation does not suppress an uncompleted input", async () => {
  const h = fixture()
  try {
    await h.accept()
    await h.engine.observe("a", source("Architecture B"))
    await until(() => h.calls.length === 2)
    await h.engine.observe("a", source("Architecture A"))
    assert.equal(h.calls[1].signal.aborted, true)
    await delay(2)
    await h.engine.observe("a", source("Architecture B"))
    await until(() => h.calls.length === 3)
    h.calls[2].resolve(analysis("B"))
    await until(async () => (await h.engine.get("a")).graph?.nodes[0].label === "B")
  } finally { await h.dispose() }
})

test("empty observation cancels queued and active updates without empty model calls", async () => {
  for (const active of [false, true]) {
    const h = fixture()
    try {
      await h.accept()
      await h.engine.observe("a", source("Architecture B"))
      if (active) await until(() => h.calls.length === 2)
      await h.engine.observe("a", [])
      await delay(20)
      assert.equal(h.calls.length, active ? 2 : 1)
      if (active) assert.equal(h.calls[1].signal.aborted, true)
      assert.equal((await h.engine.get("a")).graph?.nodes[0].label, "A")
      assert.equal((await h.engine.get("a")).updateError, null)
      await h.engine.observe("a", source("Architecture B"))
      await until(() => h.calls.length === (active ? 3 : 2))
    } finally { await h.dispose() }
  }
})

test("failed-input suppression survives collection recovery and superseded successor reservation", async () => {
  const h = fixture()
  try {
    await h.accept()
    await h.engine.observe("a", source("Architecture B"))
    await until(() => h.calls.length === 2)
    await h.engine.observe("a", source("Architecture C"))
    await h.engine.observe("a", source("Architecture B"))
    h.calls[1].reject(new Error("offline"))
    await until(async () => !!(await h.engine.get("a")).updateError)
    await delay(30)
    assert.equal(h.calls.length, 2, "B -> C -> B must not leave redundant successor")
    h.engine.collectionFailed("a")
    await h.engine.observe("a", source("Architecture B"))
    await delay(30)
    assert.equal(h.calls.length, 2, "successful recollection is not explicit retry")
    await h.engine.control("a", undefined, true)
    await until(() => h.calls.length === 3)
  } finally { await h.dispose() }
})

test("empty external publication cannot destroy last-good cache", async () => {
  const h = fixture()
  try {
    await h.accept()
    const before = await h.engine.get("a")
    const snapshot = await h.engine.snapshot("a")
    await assert.rejects(h.engine.submit("a", snapshot.token, { relevant: false, reason: "No structure", views: [] }), /cached|retained|empty/i)
    await h.engine.control("a", undefined, true)
    assert.deepEqual((await h.engine.get("a")).views, before.views)
    assert.equal(h.calls.length, 1)
  } finally { await h.dispose() }
})

function readMessages(count = 32): SessionMessageInfo[] {
  return Array.from({ length: count }, (_, i) => ({ type: "assistant", id: `m${i}`, time: { created: i + 1 }, content: [
    { type: "tool", id: `read${i}`, name: "read", state: { status: "completed", input: { path: `/project/model${i}.py` },
      content: [{ type: "text", text: `class Model${i}:\n    width = 128\n${"    layer = Convolution(128, 256)\n".repeat(180)}` }] } },
  ] })) as unknown as SessionMessageInfo[]
}

test("crowded real collection keeps material keys stable across chat, logs and failed mutations", async () => {
  const messages = readMessages()
  const before = mergeEvidence(collectEvidence(messages), [])
  const noise = [
    { type: "user", id: "chat", text: "Thanks, continue checking. ".repeat(300), time: { created: 100 } },
    { type: "assistant", id: "log", time: { created: 101 }, content: [
      { type: "tool", id: "shell", name: "shell", state: { status: "completed", input: { command: "test" }, content: [{ type: "text", text: "Passing tests\n".repeat(200) }] } },
      { type: "tool", id: "bad-edit", name: "edit", state: { status: "error", input: { path: "/project/model31.py", oldString: "missing", newString: "new" }, content: [{ type: "text", text: "No matching text" }] } },
    ] },
  ] as unknown as SessionMessageInfo[]
  const after = mergeEvidence(collectEvidence([...messages, ...noise]), [])
  assert.equal(evidenceKey(after, "overview"), evidenceKey(before, "overview"))
  const longChat = Array.from({ length: 150 }, (_, i) => ({ ...noise[0], id: `chat${i}`, time: { created: 200 + i } })) as SessionMessageInfo[]
  assert.equal(evidenceKey(mergeEvidence(collectEvidence([...messages, ...longChat]), []), "overview"), evidenceKey(before, "overview"))
  const onlyRead = collectEvidence(readMessages(1))
  const bad = structuredClone(noise[1]) as any
  bad.content[1].state.input.path = "/project/model0.py"
  const failed = collectEvidence([...readMessages(1), bad])
  assert.deepEqual(failed.filter((item) => item.category === "source"), onlyRead)
  let calls = 0
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, load: async () => undefined, save: async () => {}, publish: async () => {},
    analyze: async (data) => { calls++; return analysis("Model", data[0].id) },
  })
  try {
    await engine.observe("a", before)
    await until(async () => (await engine.get("a")).phase === "ready")
    await engine.observe("a", after)
    await delay(20)
    assert.equal(calls, 1)
  } finally { await engine.dispose() }
})

test("author namespace change cannot carry untouched views into new namespace", async () => {
  let saved: unknown
  const data = [...source("Architecture A"), { id: "training", label: "train.py", text: "batch = 16", category: "source" as const }]
  const views: DiagramView[] = data.map((item) => ({ id: item.id, label: item.id, graph: analysis(item.id, item.id).graph! }))
  const deps = { intervalMs: 1, debounceMs: 1, load: async () => saved, save: async (_id: string, state: unknown) => { saved = structuredClone(state) }, publish: async () => {} }
  let engine = new DiagramEngine({ ...deps, cacheNamespace: "old", analyze: async () => ({ relevant: true, reason: "old", graph: views[0].graph, views }) })
  try {
    await engine.observe("a", data)
    await until(() => !!saved)
    await engine.dispose()
    let calls = 0
    let subset: { views: DiagramView[] } | undefined
    engine = new DiagramEngine({ ...deps, cacheNamespace: "new", analyze: async (_e, _p, _f, _s, _d, update) => {
      calls++; subset = update
      return { relevant: true, reason: "new", graph: views[0].graph, views }
    } })
    await engine.observe("a", [{ ...data[0], text: "Architecture changed" }, data[1]])
    await until(() => calls === 1)
    assert.equal(subset, undefined, "namespace changes require all views, even alongside one changed dependency")
  } finally { await engine.dispose() }
})

test("file mutation invalidates every observed range, not unrelated files; generated logs remain noise", () => {
  const messages = readMessages(1) as any[]
  const later = structuredClone(messages[0])
  later.id = "later"; later.time.created = 2; later.content[0].id = "later-read"
  later.content[0].state.input.offset = 100
  messages.push(later)
  const training = structuredClone(messages[0])
  training.id = "training"; training.time.created = 3; training.content[0].id = "training-read"
  training.content[0].state.input.path = "/project/train.py"
  messages.push(training)
  const before = collectEvidence(messages)
  const views = before.map((item, i) => ({ id: `view${i}`, label: `View ${i}`, graph: analysis(`Part ${i}`, item.id).graph! }))
  const edit = { type: "assistant", id: "edit", time: { created: 4 }, content: [{ type: "tool", id: "edit", name: "edit", state: {
    status: "completed", input: { path: "/project/model0.py", oldString: "width = 128", newString: "width = 256" }, content: [{ type: "text", text: "Success" }],
  } }] }
  const after = collectEvidence([...messages, edit] as SessionMessageInfo[])
  const affected = affectedViews({ key: evidenceKey(before, "overview"), granularity: "overview", fingerprints: evidenceFingerprints(before),
    analysis: { relevant: true, reason: "fixture", views }, sources: before.map(({ id, label }) => ({ id, label })), updatedAt: 1 }, after)
  assert.deepEqual(affected.map((item) => item.id), views.slice(0, 2).map((item) => item.id))
  for (const name of ["write", "edit", "patch"]) {
    const noise = structuredClone(edit)
    noise.content[0].name = name
    noise.content[0].state.input = name === "patch" ? { patchText: "*** Begin Patch\n*** Add File: /project/logs/progress.txt\n+Done\n*** End Patch" } as any
      : { path: "/project/logs/progress.txt", content: "Done" } as any
    assert.equal(evidenceKey(collectEvidence([...messages, noise] as SessionMessageInfo[]), "overview"), evidenceKey(before, "overview"))
  }
})

test("generation namespace covers adapter output settings but not scheduling controls", () => {
  const base = ConfigSchema.parse({ baseURL: "http://localhost:8080/v1", model: "fixture" })
  for (const change of [{ maxTokens: 4096 }, { thinkingBudget: 0 }, { enableThinking: false }, { cachePrompt: true }]) {
    assert.notEqual(generationNamespace(base), generationNamespace({ ...base, ...change }))
  }
  assert.equal(generationNamespace(base), generationNamespace({ ...base, intervalMs: 1001, timeoutMs: 1001 }))
})

test("completed failures remain suppressed across alternating inputs, reload and collection recovery events", async () => {
  let saved: any
  let calls = 0
  const events: any[] = []
  const deps = { intervalMs: 1, debounceMs: 1, load: async () => saved,
    save: async (_id: string, value: unknown) => { saved = structuredClone(value) }, publish: async (state: unknown) => { events.push(state) },
    analyze: async (data: readonly Evidence[]) => { calls++; if (data[0].text.includes("Architecture A")) return analysis("A"); throw new Error("offline") },
  }
  let engine = new DiagramEngine(deps)
  try {
    await engine.observe("a", source("Architecture A"))
    await until(() => saved?.graph)
    await engine.observe("a", source("Architecture B"))
    await until(() => saved?.memo?.failed?.length === 1)
    await engine.observe("a", source("Architecture C"))
    await until(() => saved?.memo?.failed?.length === 2)
    await engine.dispose()
    engine = new DiagramEngine(deps)
    await engine.observe("a", source("Architecture B"))
    await delay(20)
    assert.equal(calls, 3)
    engine.collectionFailed("a")
    await until(() => !!events.at(-1)?.collectionError)
    await engine.observe("a", source("Architecture B"))
    await until(() => events.at(-1)?.collectionError === null)
    await delay(20)
    assert.equal(calls, 3, "recovered collection emits clearance, not another author request")
  } finally { await engine.dispose() }
})
