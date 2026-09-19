import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { DiagramEngine } from "../src/diagram/engine.js"
import type { DiagramAnalysis } from "../src/diagram/schema.js"

test("publication cancels explicit queue markers before later main-agent reservation", async () => {
  let calls = 0
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 50,
    load: async () => undefined, save: async () => {}, publish: async () => {},
    analyze: async () => { calls++; return { relevant: false, reason: "auto", views: [], graph: null } },
  })
  const data = [{ id: "source", label: "model.py", text: "class Encoder: width = 128", category: "source" as const }]
  try {
    await engine.observe("a", data, false)
    await engine.control("a", undefined, true)
    const snapshot = await engine.snapshot("a")
    await engine.submit("a", snapshot.token, { relevant: false, reason: "primary", views: [] })
    const changed = [{ ...data[0], text: "class Encoder: width = 256" }]
    await engine.observe("a", changed, false)
    await engine.snapshot("a")
    await engine.observe("a", changed)
    await delay(100)
    assert.equal(calls, 0)
  } finally { await engine.dispose() }
})

test("failed-input revisit cancels different active work and retains its warning", async () => {
  const calls: { resolve(value: DiagramAnalysis): void; reject(error: Error): void; signal: AbortSignal }[] = []
  const data = (text: string) => [{ id: "source", label: "model.py", text: `class Encoder: width = ${text}`, category: "source" as const }]
  const analysis: DiagramAnalysis = { relevant: true, reason: "fixture", graph: { title: "Model", summary: "", nodes: [
    { id: "node", label: "Encoder", kind: "model", detail: "", status: "observed", evidence: ["source"] },
  ], edges: [] } }
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, load: async () => undefined, save: async () => {}, publish: async () => {},
    analyze: async (_e, _p, _f, signal) => new Promise((resolve, reject) => { calls.push({ resolve, reject, signal }) }),
  })
  const until = async (fn: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 1000
    while (!await fn()) { assert.ok(Date.now() < deadline); await delay(2) }
  }
  try {
    await engine.observe("a", data("128")); await until(() => calls.length === 1); calls[0].resolve(analysis)
    await until(async () => (await engine.get("a")).phase === "ready")
    await engine.observe("a", data("256")); await until(() => calls.length === 2); calls[1].reject(Error("failed B"))
    await until(async () => !!(await engine.get("a")).updateError)
    await engine.observe("a", data("512")); await until(() => calls.length === 3)
    await engine.observe("a", data("256")); assert.equal(calls[2].signal.aborted, true)
    calls[2].resolve(analysis); await delay(10)
    assert.equal((await engine.get("a")).updateError, "failed B")
    assert.equal(calls.length, 3)
  } finally { for (const call of calls) call.resolve(analysis); await engine.dispose() }
})
