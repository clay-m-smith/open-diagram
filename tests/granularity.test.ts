import assert from "node:assert/strict"
import { StoredDiagramSchema } from "../src/diagram/cache.js"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { DiagramEngine } from "../src/diagram/engine.js"
import { diagramRequest } from "../src/diagram/harness.js"
import { createDiagramClient } from "../src/diagram/client.js"
import { ConfigSchema } from "../src/diagram/config.js"
import { initialState, StateSchema, type DiagramAnalysis, type DiagramGranularity } from "../src/diagram/schema.js"

const evidence = [{ id: "e", label: "encoder.py", text: "Conv1d(32, 64, kernel_size=3, stride=2) followed by GELU" }]
const analysis = (width: number): DiagramAnalysis => ({ relevant: true, reason: "Layers", graph: {
  title: "Encoder layers", summary: "", nodes: [{ id: "conv", label: `Conv 32 → ${width}`, kind: "conv1d", detail: "k=3, stride=2", status: "observed", evidence: ["e"] }], edges: [],
} })
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) { assert.ok(Date.now() < deadline, "granularity deadline"); await delay(2) }
}

test("granular author request carries layer/parameter instructions through native generation", async () => {
  assert.doesNotMatch(diagramRequest(evidence, null, false).instruction, /Granularity: granular/)
  const request = diagramRequest(evidence, null, false, "granular")
  assert.equal(request.input.granularity, "granular")
  assert.match(request.instruction, /neural networks show specified convolution/)
  assert.match(request.instruction, /kernels, widths, strides, padding, head\/repeat counts/)
  assert.match(request.instruction, /Expand configured stages individually/)
  assert.match(request.instruction, /evidence is an array of 1-6 CURRENT IDs/)
  const client = createDiagramClient(ConfigSchema.parse({ backend: "opencode", providerID: "fixture", model: "fixture" }), fetch,
    async (input) => {
      assert.match(input.prompt, /Granularity: granular/)
      assert.match(input.prompt, /"granularity":"granular"/)
      assert.match(input.prompt, /Authoring reminder: requested depth is granular/)
      return { text: JSON.stringify({ relevant: false, reason: "Fixture", views: [] }) }
    })
  await client(evidence, null, false, new AbortController().signal, "granular")
})

test("depth is durable, preserves pause, invalidates author tokens and defaults old records to overview", async () => {
  const saved = new Map<string, unknown>()
  const deps = { intervalMs: 1, debounceMs: 1, load: async (id: string) => saved.get(id),
    save: async (id: string, state: unknown) => { saved.set(id, state) }, publish: async () => {} }
  const engine = new DiagramEngine(deps)
  await engine.observe("a", evidence)
  await engine.control("a", "off")
  const old = await engine.snapshot("a")
  const state = await engine.control("a", undefined, false, undefined, "granular")
  assert.equal(state.mode, "off")
  assert.equal(state.phase, "paused")
  assert.equal(state.granularity, "granular")
  await assert.rejects(engine.submit("a", old.token, { relevant: false, reason: "", views: [] }), /snapshot changed/)
  await engine.dispose()
  const reload = new DiagramEngine(deps)
  try {
    assert.equal((await reload.get("a")).granularity, "granular")
    assert.equal((await reload.get("a")).mode, "off")
  } finally { await reload.dispose() }
  const { granularity: _oldMissing, ...legacy } = initialState("legacy")
  assert.equal(StateSchema.parse(legacy).granularity, "overview")
})

test("depth change cancels obsolete inference and parameter changes highlight stable layer IDs", async () => {
  const calls: { granularity: DiagramGranularity; signal: AbortSignal; resolve(value: DiagramAnalysis): void }[] = []
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, load: async () => undefined, save: async () => {}, publish: async () => {},
    analyze: async (_evidence, _previous, _forced, signal, granularity) => new Promise((resolve) => calls.push({ granularity, signal, resolve })),
  })
  try {
    await engine.observe("a", evidence)
    await until(() => calls.length === 1)
    await engine.control("a", undefined, true, undefined, "granular")
    assert.equal(calls[0].signal.aborted, true)
    calls[0].resolve(analysis(16))
    await until(() => calls.length === 2)
    assert.equal(calls[1].granularity, "granular")
    assert.equal((await engine.get("a")).graph, null, "obsolete overview cannot overwrite requested depth")
    calls[1].resolve(analysis(64))
    await until(() => !calls[1].signal.aborted && calls.length === 2)
    await delay(2)
    const snapshot = await engine.snapshot("a")
    const changed = await engine.submit("a", snapshot.token, analysis(128))
    assert.equal(changed.graph?.nodes[0].id, "conv")
    assert.deepEqual(changed.changed, ["conv"])
    assert.equal(changed.granularity, "granular")
  } finally { for (const call of calls) call.resolve(analysis(64)); await engine.dispose() }
})

test("empty collection preserves active granular preference before and after reload", async () => {
  let saved: unknown
  const deps = { intervalMs: 1, debounceMs: 1, load: async () => saved,
    save: async (_id: string, value: unknown) => { saved = structuredClone(value) }, publish: async () => {} }
  for (const fresh of [true, false]) {
    const engine = new DiagramEngine(deps)
    try {
      if (fresh) await engine.control("a", undefined, false, undefined, "granular")
      await engine.observe("a", [])
      const state = await engine.get("a")
      assert.equal(state.mode, "auto")
      assert.equal(state.granularity, "granular")
    } finally { await engine.dispose() }
    assert.equal(StoredDiagramSchema.parse(saved).granularity, "granular")
  }
})
