import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { DiagramEngine } from "../src/diagram/engine.js"
import type { DiagramAnalysis, DiagramState } from "../src/diagram/schema.js"

const evidence = (value: string) => [{ id: "source", label: "model.py", text: `Architecture ${value}: encoder -> classifier`, category: "source" as const }]
const analysis = (label: string): DiagramAnalysis => ({ relevant: true, reason: "Model", graph: {
  title: "Model", summary: "", nodes: [{ id: "model", label, kind: "model", detail: "", status: "observed", evidence: ["source"] }], edges: [],
} })
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 1000
  while (!await predicate()) { assert.ok(Date.now() < end, "late recovery deadline"); await delay(2) }
}

test("accepted irrelevant cache recovers collection status and push notification, including paused mode", async () => {
  for (const paused of [false, true]) {
    let calls = 0; let saved: unknown
    const events: DiagramState[] = []
    const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, load: async () => undefined,
      save: async (_id, state) => { saved = state }, publish: async (state) => { events.push(state) },
      analyze: async () => { calls++; return { relevant: false, reason: "No useful structure", graph: null, views: [] } },
    })
    try {
      await engine.observe("a", evidence("A")); await until(() => !!saved)
      if (paused) await engine.control("a", "off")
      engine.collectionFailed("a"); await until(() => !!events.at(-1)?.collectionError)
      await engine.observe("a", evidence("A"))
      await until(() => events.at(-1)?.collectionError === null)
      assert.equal((await engine.get("a")).phase, paused ? "paused" : "watching")
      await engine.control("a", undefined, true)
      assert.equal(calls, 1)
    } finally { await engine.dispose() }
  }
})

test("stale automatic success cannot erase newer unscheduled publication input", async () => {
  const calls: { resolve(value: DiagramAnalysis): void }[] = []
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, load: async () => undefined, save: async () => {}, publish: async () => {},
    analyze: () => new Promise<DiagramAnalysis>((resolve) => { calls.push({ resolve }) }),
  })
  try {
    await engine.observe("a", evidence("A")); await until(() => calls.length === 1)
    await engine.observe("a", evidence("B"), false)
    calls[0].resolve(analysis("A"))
    await until(async () => !!(await engine.get("a")).graph)
    assert.equal((await engine.get("a")).stale, true)
    await engine.resume("a")
    await until(() => calls.length === 2)
    calls[1].resolve(analysis("B"))
    await until(async () => (await engine.get("a")).graph?.nodes[0].label === "B")
    assert.equal((await engine.get("a")).stale, false)
  } finally { for (const call of calls) call.resolve(analysis("cleanup")); await engine.dispose() }
})
