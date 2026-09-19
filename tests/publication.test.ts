import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { DiagramEngine } from "../src/diagram/engine.js"
import { ConfigSchema } from "../src/diagram/config.js"
import { createDiagramClient } from "../src/diagram/client.js"
import type { DiagramAnalysis, DiagramState } from "../src/diagram/schema.js"

const evidence = [{ id: "e_source", label: "workflow.ts", text: "Gateway -> Queue -> Worker" }]
const output = (label = "Gateway") => ({ relevant: true, reason: "Implementation", views: [{ id: "system", label: "System", graph: {
  title: label, summary: "", nodes: [{ id: "gateway", label, kind: "service", detail: "Accept orders", status: "observed", evidence: ["e_source"] }], edges: [],
} }] })
const deps = () => {
  const saved = new Map<string, DiagramState>()
  return { saved, intervalMs: 1, debounceMs: 1, load: async (id: string) => saved.get(id),
    save: async (id: string, state: DiagramState) => { saved.set(id, state) }, publish: async () => {} }
}

test("manual snapshots publish atomically, persist views, reject stale evidence/mode/publication and foreign tokens", async () => {
  const d = deps()
  const engine = new DiagramEngine(d)
  try {
    await engine.observe("a", evidence)
    const first = await engine.snapshot("a")
    assert.equal(first.state.phase, "watching")
    const accepted = await engine.submit("a", first.token, output())
    assert.equal(accepted.views[0].graph.title, "Gateway")
    assert.deepEqual(accepted.changedViews.system, ["gateway"])
    assert.deepEqual(d.saved.get("a")?.views, accepted.views)
    await assert.rejects(engine.submit("a", first.token, output("Old")), /snapshot changed/)
    const changed = await engine.snapshot("a")
    await engine.observe("a", [{ ...evidence[0], text: "New workflow" }])
    await assert.rejects(engine.submit("a", changed.token, output()), /snapshot changed/)
    const mode = await engine.snapshot("a")
    await engine.control("a", "off")
    await assert.rejects(engine.submit("a", mode.token, output()), /snapshot changed/)
    const fresh = await engine.snapshot("a")
    await engine.observe("b", evidence)
    await assert.rejects(engine.submit("b", fresh.token, output()), /snapshot changed/)
    assert.equal((await engine.submit("a", fresh.token, output("Paused publication"))).phase, "paused")
    const next = await engine.snapshot("a")
    const bad = output(); bad.views[0].graph.nodes[0].evidence = ["outside"]
    await assert.rejects(engine.submit("a", next.token, bad), /outside current snapshot/)
    assert.equal((await engine.snapshot("a")).token, next.token, "invalid input cannot consume token")
    const abort = new AbortController(); abort.abort()
    await assert.rejects(engine.submit("a", next.token, output(), abort.signal))
    assert.equal((await engine.snapshot("a")).token, next.token)
  } finally { await engine.dispose() }
  const restored = new DiagramEngine(d)
  try {
    assert.equal((await restored.get("a")).views[0].graph.title, "Paused publication")
    assert.equal((await restored.get("a")).mode, "off")
  } finally { await restored.dispose() }
})

test("external publication cancels obsolete automatic analysis and late output cannot overwrite it", async () => {
  let release!: (value: DiagramAnalysis) => void
  let signal: AbortSignal | undefined
  const engine = new DiagramEngine({ ...deps(), analyze: async (_data, _previous, _forced, abort) => {
    signal = abort
    return new Promise((resolve) => { release = resolve })
  } })
  try {
    await engine.observe("a", evidence)
    for (let n = 0; !signal && n < 100; n++) await delay(2)
    assert.ok(signal)
    const snapshot = await engine.snapshot("a")
    await engine.submit("a", snapshot.token, output("External"))
    assert.equal(signal.aborted, true)
    release({ relevant: true, reason: "Late", graph: null })
    await delay(10)
    assert.equal((await engine.get("a")).graph?.title, "External")
  } finally { await engine.dispose() }
})

test("native adapter uses explicit model and shared prompt/schema without endpoint transport", async () => {
  assert.equal(ConfigSchema.parse({}).backend, "manual")
  assert.throws(() => ConfigSchema.parse({ backend: "opencode" }), /requires/)
  const config = ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram", variant: "fast" })
  const client = createDiagramClient(config, async () => assert.fail("no HTTP adapter call"), async (request, options) => {
    assert.deepEqual(request.model, { providerID: "test", id: "diagram", variant: "fast" })
    assert.match(request.prompt, /Any domain/)
    assert.match(request.prompt, /Output JSON Schema/)
    assert.match(request.prompt, /Gateway -> Queue -> Worker/)
    assert.equal(options.signal.aborted, false)
    const authored = output(); authored.views[0].graph.nodes[0].evidence = ["e1"]
    return { text: JSON.stringify(authored) }
  })
  assert.equal((await client(evidence, null, false, new AbortController().signal)).views?.[0].id, "system")
  const fail = createDiagramClient(config, fetch, async () => { throw new Error("PRIVATE PROVIDER DETAIL") })
  await assert.rejects(fail(evidence, null, false, new AbortController().signal), (error: Error) =>
    /Configured OpenCode diagram model unavailable/.test(error.message) && !error.message.includes("PRIVATE"))
})

test("native validation repair is bounded to one retry and never repairs transport failure", async () => {
  const config = ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" })
  let calls = 0
  const client = createDiagramClient(config, fetch, async (request) => {
    if (++calls === 1) return { text: "MALFORMED" }
    assert.match(request.prompt, /failed json validation/)
    const value = output(); value.views[0].graph.nodes[0].evidence = ["e1"]
    return { text: JSON.stringify(value) }
  })
  assert.equal((await client(evidence, null, false, new AbortController().signal)).graph?.title, "Gateway")
  assert.equal(calls, 2)
  calls = 0
  const invalid = createDiagramClient(config, fetch, async () => { calls++; return { text: "MALFORMED" } })
  await assert.rejects(invalid(evidence, null, false, new AbortController().signal), /not valid JSON/)
  assert.equal(calls, 2)
  calls = 0
  const fail = createDiagramClient(config, fetch, async () => { calls++; throw new Error("network") })
  await assert.rejects(fail(evidence, null, false, new AbortController().signal), /unavailable/)
  assert.equal(calls, 1)
})
