import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { DiagramEngine } from "../src/diagram/engine.js"
import type { Evidence } from "../src/diagram/evidence.js"
import type { DiagramState } from "../src/diagram/schema.js"

const evidence = [{ id: "source", label: "model.py", text: "class Encoder: width = 128", category: "source" as const }]
const views = [{ id: "model", label: "Model", graph: { title: "Model", summary: "", nodes: [
  { id: "encoder", label: "Encoder", kind: "layer", detail: "", status: "observed" as const, evidence: ["source"] },
], edges: [] } }]
const analysis = { relevant: true, reason: "Observed model", views, graph: views[0].graph }
async function until(predicate: () => boolean) {
  const end = Date.now() + 1000
  while (!predicate()) { assert.ok(Date.now() < end, "reservation deadline"); await delay(2) }
}

test("main-agent reservation survives own hooks; successful publication cancels fallback", async () => {
  let calls = 0
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, authoringMs: 80,
    load: async () => undefined, save: async () => {}, publish: async () => {}, analyze: async () => { calls++; return analysis },
  })
  try {
    await engine.observe("a", evidence, false)
    const snapshot = await engine.snapshot("a")
    for (let i = 0; i < 10; i++) { await engine.observe("a", [...evidence, { id: `chat${i}`, label: "chat", text: "working", category: "assistant" }]); await delay(2) }
    assert.equal(calls, 0)
    // Harmless transcript changes neither regenerate nor invalidate authoring.
    const current = await engine.snapshot("a")
    assert.equal(current.token, snapshot.token)
    await engine.submit("a", snapshot.token, { relevant: true, reason: analysis.reason, views })
    await delay(100)
    assert.equal(calls, 0)
  } finally { await engine.dispose() }
})

test("abandoned authoring expires, while Pause cancels fallback", async () => {
  for (const pause of [false, true]) {
    let calls = 0
    const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, authoringMs: 10,
      load: async () => undefined, save: async () => {}, publish: async () => {}, analyze: async () => { calls++; return analysis },
    })
    try {
      await engine.observe("a", evidence, false); await engine.snapshot("a")
      if (pause) await engine.control("a", "off")
      if (pause) { await delay(30); assert.equal(calls, 0) }
      else await until(() => calls === 1)
    } finally { await engine.dispose() }
  }
})

test("suppressed failed input restores its own warning after cache reuse and reload", async () => {
  let saved: any; let calls = 0
  const events: DiagramState[] = []
  const changed = [{ ...evidence[0], text: "class Encoder: width = 256" }]
  const deps = { intervalMs: 1, debounceMs: 1, load: async () => saved, save: async (_id: string, value: unknown) => { saved = structuredClone(value) },
    publish: async (state: DiagramState) => { events.push(state) }, analyze: async (input: readonly Evidence[]) => {
      calls++; if (input[0].text.includes("256")) throw new Error("provider offline"); return analysis
    },
  }
  let engine = new DiagramEngine(deps)
  try {
    await engine.observe("a", evidence); await until(() => !!saved?.graph)
    await engine.observe("a", changed); await until(() => !!saved?.updateError)
    await engine.observe("a", evidence); assert.equal((await engine.get("a")).updateError, null)
    await engine.observe("a", changed); await until(() => events.at(-1)?.updateError === "provider offline")
    await engine.dispose(); engine = new DiagramEngine(deps)
    await engine.observe("a", changed); await delay(20)
    assert.equal(calls, 2)
    assert.equal((await engine.get("a")).updateError, "provider offline")
  } finally { await engine.dispose() }
})
