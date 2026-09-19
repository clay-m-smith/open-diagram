import assert from "node:assert/strict"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"

import { ConfigSchema } from "../src/diagram/config.js"
import { createDiagramClient } from "../src/diagram/client.js"
import { collectEvidence, candidateWork, mergeEvidence, type Evidence } from "../src/diagram/evidence.js"
import { DiagramEngine } from "../src/diagram/engine.js"
import { GraphSchema, type DiagramAnalysis, type DiagramState } from "../src/diagram/schema.js"

const evidence: Evidence[] = [{ id: "e_test", label: "User request", text: "Train a PyTorch neural model with encoder and classifier layers" }]
const analysis = (label = "Encoder"): DiagramAnalysis => ({ relevant: true, reason: "Model development", graph: {
  title: "Classifier", summary: "Proposed encoder architecture", nodes: [
    { id: "input", label: "Images", kind: "input", detail: "Input batch", status: "planned", evidence: ["e_test"] },
    { id: "encoder", label, kind: "model", detail: "Convolutional encoder", status: "planned", evidence: ["e_test"] },
  ], edges: [{ from: "input", to: "encoder", label: "batch" }],
} })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function until(predicate: () => boolean, timeout = 2000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > end) throw new Error("State transition deadline exceeded")
    await delay(5)
  }
}

test("evidence excludes reasoning, media and private tool state; bounded current text retains code", () => {
  const messages = [
    { type: "system", id: "sys", text: "SYSTEM_PRIVATE" },
    { type: "user", id: "u", text: evidence[0].text },
    { type: "assistant", id: "a", content: [
      { type: "reasoning", text: "PRIVATE_REASONING" },
      { type: "text", text: "Propose a classifier" },
      { type: "tool", id: "read", name: "read", state: { status: "completed", input: { path: "model.py" }, content: [{ type: "text", text: "class Encoder(nn.Module): pass" }, { type: "file", url: "MEDIA_PRIVATE" }] } },
      { type: "tool", id: "secret", name: "read", state: { status: "completed", input: { path: "/app/.env" }, content: [{ type: "text", text: "SECRET_CONTENT" }] } },
      { type: "tool", id: "other", name: "tooling_memory_list", state: { status: "completed", input: {}, content: [{ type: "text", text: "MEMORY_PRIVATE" }] } },
    ] },
  ] as unknown as SessionMessageInfo[]
  const result = collectEvidence(messages)
  assert.ok(candidateWork(result))
  assert.match(JSON.stringify(result), /class Encoder/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET_CONTENT/)
  const huge = collectEvidence(Array.from({ length: 100 }, (_, i) => ({ type: "user", id: String(i), text: "x".repeat(10_000), time: { created: i } })))
  assert.ok(huge.length <= 32)
  assert.ok(huge.reduce((sum, item) => sum + item.id.length + item.label.length + item.text.length, 0) <= 36_000)
  assert.equal(candidateWork([{ id: "x", label: "request", text: "Fix CSS sidebar colors and tab labels" }]), true)
})

test("graph validation permits branches and cycles but rejects dangling edges, duplicate IDs and terminal controls", () => {
  const graph = analysis().graph!
  assert.ok(GraphSchema.safeParse({ ...graph, edges: [...graph.edges, { from: "encoder", to: "input", label: "feedback" }] }).success)
  assert.equal(GraphSchema.safeParse({ ...graph, edges: [{ from: "input", to: "missing", label: "" }] }).success, false)
  assert.equal(GraphSchema.safeParse({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }).success, false)
  assert.equal(GraphSchema.safeParse({ ...graph, title: "\x1b]52;c;clipboard" }).success, false)
  assert.throws(() => ConfigSchema.parse({ baseURL: "https://remote.example/v1", model: "free" }), /allowRemote/)
  assert.throws(() => ConfigSchema.parse({ baseURL: "http://name:password@localhost/v1", model: "x" }))
})

test("large edits retain replacement architecture and saturated parent context retains child updates", () => {
  const messages = [{ type: "assistant", id: "a", content: [{ type: "tool", id: "edit", name: "edit", state: {
    status: "completed", input: { path: "model.py", oldString: "old layer\n".repeat(1000), newString: "encoder = nn.Embedding(32, 8)\n" + "new layer\n".repeat(1000) },
    content: [{ type: "text", text: "File edited" }],
  } }] }] as unknown as SessionMessageInfo[]
  const result = collectEvidence(messages)
  assert.match(result[0].text, /replacement text:\nencoder = nn.Embedding/)
  assert.match(result[0].text, /excerpt truncated/)
  assert.ok(result[0].text.length <= 3000)
  const parent = Array.from({ length: 32 }, (_, n) => ({ id: `parent_${n}`, label: "parent", text: "p".repeat(3000) }))
  const child = [{ id: "child", label: "child", text: "NEW_CHILD_ARCHITECTURE" }]
  const combined = mergeEvidence(parent, child)
  assert.ok(combined.some((item) => item.id === "child"))
  assert.equal(combined.at(-1)?.id, "parent_31")
  assert.ok(combined.length <= 32)
  assert.ok(combined.reduce((sum, item) => sum + item.text.length, 0) <= 20_000)
})

test("HTTP adapter sends independent bounded request and rejects invalid citations/oversize responses", async (t) => {
  let mode = "valid"
  const requests: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    if (mode === "http") { response.writeHead(503).end("PRIVATE_BACKEND_BODY"); return }
    if (mode === "large") { response.end("x".repeat(150_000)); return }
    const result = analysis()
    const packet = JSON.parse((requests.at(-1)!.messages as Array<{ content: string }>)[1].content)
    for (const node of result.graph!.nodes) node.evidence = [packet.evidence[0].id]
    if (mode === "citation") result.graph!.nodes[0].evidence = ["invented"]
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address() as { port: number }
  const config = ConfigSchema.parse({ baseURL: `http://127.0.0.1:${address.port}/v1`, model: "test-local", cachePrompt: false, thinkingBudget: 0, enableThinking: false })
  const client = createDiagramClient(config)
  assert.equal((await client(evidence, null, false, new AbortController().signal)).graph!.title, "Classifier")
  assert.equal(requests[0].model, "test-local")
  assert.equal(requests[0].stream, false)
  assert.equal(requests[0].tools, undefined)
  assert.equal(requests[0].cache_prompt, false)
  assert.deepEqual(requests[0].chat_template_kwargs, { enable_thinking: false })
  const strictSchema = (requests[0].response_format as any).json_schema.schema
  const nodeSchema = strictSchema.properties.views.items.properties.graph.properties.nodes.items
  assert.ok(nodeSchema.required.includes("behavior"), "actual endpoint request uses strict-compatible schema")
  assert.match((requests[0].messages as Array<{ content: string }>)[0].content, /empty string/)
  mode = "citation"
  await assert.rejects(client(evidence, null, false, new AbortController().signal), /outside current snapshot/)
  mode = "http"
  await assert.rejects(client(evidence, null, false, new AbortController().signal), /^Error: Diagram service HTTP 503$/)
  mode = "large"
  await assert.rejects(client(evidence, null, false, new AbortController().signal), /128 KiB/)
})

test("queue coalesces bursts, never overlaps requests, marks stale snapshots and persists pause over late output", async () => {
  const calls: Array<{ evidence: readonly Evidence[]; done: ReturnType<typeof deferred<DiagramAnalysis>>; signal: AbortSignal }> = []
  const saved = new Map<string, DiagramState>()
  const updates: DiagramState[] = []
  const engine = new DiagramEngine({
    intervalMs: 10, debounceMs: 5,
    load: async (id) => saved.get(id), save: async (id, state) => { saved.set(id, state) },
    publish: async (state) => { updates.push(state) },
    analyze: async (data, _previous, _forced, signal) => {
      const done = deferred<DiagramAnalysis>(); calls.push({ evidence: data, done, signal }); return done.promise
    },
  })
  try {
    await engine.observe("a", evidence)
    await until(() => calls.length === 1)
    for (let n = 1; n <= 10; n++) await engine.observe("a", [{ ...evidence[0], text: `${evidence[0].text} revision ${n}` }])
    await engine.observe("b", evidence)
    assert.equal(calls.length, 1)
    calls[0].done.resolve(analysis())
    await until(() => calls.length === 2)
    assert.ok(updates.some((state) => state.graph && state.stale), "old valid graph exposed as stale during continued development")
    calls[1].done.resolve(analysis("Updated encoder"))
    await until(() => calls.length === 3)
    assert.match(calls[1].evidence[0].text, /revision 10/, "latest input replaces intermediate snapshots")
    const paused = await engine.control("b", "off")
    assert.equal(paused.phase, "paused")
    assert.equal(calls[2].signal.aborted, true)
    calls[2].done.resolve(analysis("Late result"))
    await delay(20)
    assert.equal((await engine.get("b")).graph, null)
    assert.equal(saved.get("b")?.mode, "off")
    assert.deepEqual((await engine.get("a")).changed, ["encoder"])
    const revisions = updates.filter((state) => state.sessionID === "a").map((state) => state.revision)
    assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b))
  } finally { await engine.dispose() }
})

test("failures retain graph, unchanged snapshots do not retry; reload restores graph and explicit mode", async () => {
  const saved = new Map<string, DiagramState>()
  let calls = 0
  const dependencies = {
    intervalMs: 10, debounceMs: 5, load: async (id: string) => saved.get(id),
    save: async (id: string, state: DiagramState) => { saved.set(id, state) }, publish: async () => {},
    analyze: async () => { if (++calls > 1) throw new Error("Service unavailable"); return analysis() },
  }
  const engine = new DiagramEngine(dependencies)
  await engine.observe("a", evidence)
  await until(() => saved.has("a"))
  await engine.control("a", undefined, true)
  await delay(15)
  assert.equal(calls, 1, "Refresh reuses unchanged accepted diagram")
  const changedEvidence = [{ ...evidence[0], text: `${evidence[0].text} with a changed layer` }]
  await engine.observe("a", changedEvidence)
  await until(() => calls === 2)
  await delay(10)
  assert.equal((await engine.get("a")).phase, "ready")
  assert.match((await engine.get("a")).updateError!, /Service unavailable/)
  assert.equal((await engine.get("a")).graph?.title, "Classifier")
  await engine.observe("a", changedEvidence)
  await delay(30)
  assert.equal(calls, 2)
  await engine.control("a", "off")
  await engine.dispose()
  // Earlier snapshots predate cacheError; hydration must preserve their graph/mode.
  const restored = new DiagramEngine({ ...dependencies, load: async (id) => {
    const { cacheError: _cacheError, ...legacy } = saved.get(id)!
    return legacy
  } })
  assert.equal((await restored.get("a")).mode, "off")
  assert.equal((await restored.get("a")).graph?.title, "Classifier")
  assert.equal((await restored.get("a")).stale, true)
  assert.equal((await restored.get("a")).cacheError, null)
  await restored.dispose()
})

test("slow event delivery is bounded and cannot block durable pause acknowledgement", async () => {
  const held = deferred<void>()
  const publications: DiagramState[] = []
  const saved: DiagramState[] = []
  const engine = new DiagramEngine({
    intervalMs: 10, debounceMs: 5, load: async () => undefined,
    save: async (_id, state) => { saved.push(state) },
    publish: async (state) => { publications.push(state); if (publications.length === 1) await held.promise },
    analyze: async () => assert.fail("unrelated text never invokes inference"),
  })
  for (let n = 0; n < 1000; n++) await engine.observe("a", [{ id: "e", label: "text", text: `unrelated ${n}` }])
  const paused = await engine.control("a", "off")
  assert.equal(paused.mode, "off")
  assert.equal(saved.at(-1)?.mode, "off")
  assert.equal(publications.length, 1)
  held.resolve()
  await until(() => publications.length === 2)
  assert.equal(publications[1].mode, "off", "intermediate states coalesce to latest publication")
  await engine.dispose()
})

test("shutdown drains accepted pause writes behind a pending save", async () => {
  const heldSave = deferred<void>()
  const heldEvent = deferred<void>()
  const saved: DiagramState[] = []
  const engine = new DiagramEngine({
    intervalMs: 10, debounceMs: 5, load: async () => undefined,
    save: async (_id, state) => { saved.push(state); if (saved.length === 1) await heldSave.promise },
    publish: async () => heldEvent.promise,
    analyze: async () => analysis(),
  })
  const enable = engine.control("a", "on")
  await until(() => saved.length === 1)
  const pause = engine.control("a", "off")
  while ((await engine.get("a")).mode !== "off") await delay(0)
  const dispose = engine.dispose()
  heldSave.resolve()
  await Promise.all([enable, pause, dispose])
  assert.equal(saved.at(-1)?.mode, "off")
  heldEvent.resolve()
})

test("failed mode writes survive transient revisions and inference failure; same-mode control retries", async () => {
  const saved = new Map<string, DiagramState>()
  let failSave = false
  let calls = 0
  const dependencies = {
    intervalMs: 10, debounceMs: 5, load: async (id: string) => saved.get(id),
    save: async (id: string, state: DiagramState) => {
      if (failSave) throw new Error("disk unavailable")
      saved.set(id, state)
    },
    publish: async () => {},
    analyze: async () => { calls++; throw new Error("inference unavailable") },
  }
  const engine = new DiagramEngine(dependencies)
  try {
    await engine.control("a", "off")
    await engine.observe("a", evidence)
    failSave = true
    const enabled = await engine.control("a", "on")
    assert.equal(enabled.mode, "on")
    assert.match(enabled.cacheError!, /cache write failed/)
    assert.equal(saved.get("a")!.mode, "off")
    await until(() => calls === 1)
    await delay(0)
    const failed = await engine.get("a")
    assert.equal(failed.phase, "unavailable")
    assert.match(failed.reason, /inference unavailable/)
    assert.match(failed.cacheError!, /cache write failed/, "model status cannot hide failed persistence")
    for (let n = 0; n < 65; n++) await engine.get(`other_${n}`)
    assert.equal((await engine.get("a")).epoch, enabled.epoch, "unsaved mode cannot be evicted")
    failSave = false
    assert.equal((await engine.control("a", "on")).cacheError, null)
    assert.equal(saved.get("a")!.mode, "on")
    assert.equal(saved.get("a")!.cacheError, null)
  } finally { await engine.dispose() }
  const restored = new DiagramEngine(dependencies)
  try { assert.equal((await restored.get("a")).mode, "on") } finally { await restored.dispose() }
})

test("a successful superseding durable write covers an earlier save failure", async () => {
  const gate = deferred<void>()
  const saved: DiagramState[] = []
  let writes = 0
  const engine = new DiagramEngine({
    intervalMs: 10, debounceMs: 5, load: async () => undefined,
    save: async (_id, state) => {
      if (++writes === 1) { await gate.promise; throw new Error("first write failed") }
      saved.push(state)
    },
    publish: async () => {}, analyze: async () => analysis(),
  })
  try {
    const enabling = engine.control("a", "on")
    await until(() => writes === 1)
    const pausing = engine.control("a", "off")
    while ((await engine.get("a")).mode !== "off") await delay(0)
    gate.resolve()
    const results = await Promise.all([enabling, pausing])
    assert.ok(results.every((state) => state.mode === "off" && state.cacheError === null))
    assert.equal(saved.at(-1)!.mode, "off")
  } finally { gate.resolve(); await engine.dispose() }
})

test("evicted session gets a fresh epoch; busy writes pin its state", async () => {
  const saved = new Map<string, DiagramState>()
  let fail = false
  let blockSave = false
  const held = deferred<void>()
  const engine = new DiagramEngine({
    intervalMs: 10, debounceMs: 5, load: async (id) => saved.get(id),
    save: async (id, state) => { if (blockSave && id === "a") await held.promise; saved.set(id, state) },
    publish: async () => {}, analyze: async () => { if (fail) throw new Error("offline"); return analysis() },
  })
  await engine.observe("a", evidence)
  await until(() => saved.has("a"))
  const before = await engine.get("a")
  fail = true
  await engine.observe("a", [{ ...evidence[0], text: `${evidence[0].text} changed` }])
  await delay(30)
  assert.ok((await engine.get("a")).revision > before.revision)
  assert.match(saved.get("a")!.updateError!, /offline/, "failed input is persisted without replacing accepted graph")
  blockSave = true
  const pausing = engine.control("a", "off")
  await delay(0)
  for (let n = 0; n < 64; n++) await engine.get(`other_${n}`)
  assert.equal((await engine.get("a")).epoch, before.epoch, "pending durable write pins entry against eviction")
  held.resolve()
  await pausing
  await delay(0)
  await engine.get("evict")
  const restored = await engine.get("a")
  assert.notEqual(restored.epoch, before.epoch)
  assert.equal(restored.mode, "off")
  assert.deepEqual(restored.graph, before.graph)
  await engine.dispose()
})
