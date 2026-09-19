import assert from "node:assert/strict"
import test from "node:test"
import { DiagramEngine } from "../src/diagram/engine.js"
import { initialState } from "../src/diagram/schema.js"
import { createDiagramClient } from "../src/diagram/client.js"
import { ConfigSchema } from "../src/diagram/config.js"
import { setTimeout as delay } from "node:timers/promises"

test("transient storage read failure cannot erase a persisted pause or admit inference", async () => {
  const saved = { ...initialState("a"), mode: "off" as const, phase: "paused" as const }
  let loads = 0; let writes = 0; let calls = 0
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1,
    load: async () => { if (++loads === 1) throw new Error("temporary read outage"); return saved },
    save: async () => { writes++ }, publish: async () => {},
    analyze: async () => { calls++; return { relevant: false, reason: "", graph: null } },
  })
  try {
    await assert.rejects(engine.get("a"), /cache.*read|read.*cache/i)
    assert.equal((await engine.get("a")).mode, "off", "next access retries hydration")
    await engine.observe("a", [])
    assert.equal(writes, 0)
    assert.equal(calls, 0)
  } finally { await engine.dispose() }
})

test("collection outage marks graph stale and blocks refresh until successful evidence", async () => {
  const evidence = [{ id: "e", label: "source", text: "Gateway -> Queue" }]
  const graph = { title: "Flow", summary: "", nodes: [{ id: "gateway", label: "Gateway", kind: "service", detail: "", status: "observed" as const, evidence: ["e"] }], edges: [] }
  let calls = 0
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, load: async () => undefined, save: async () => {}, publish: async () => {},
    analyze: async () => { calls++; return { relevant: true, reason: "Flow", graph } },
  })
  try {
    await engine.observe("a", evidence)
    for (let n = 0; !(await engine.get("a")).graph && n < 100; n++) await delay(2)
    assert.equal((await engine.get("a")).phase, "ready")
    engine.collectionFailed("a")
    const failed = await engine.get("a")
    assert.equal(failed.stale, true)
    assert.equal(failed.phase, "ready", "a collection outage does not make cached diagram unavailable")
    assert.match(failed.collectionError!, /evidence unavailable/)
    await engine.control("a", undefined, true)
    await delay(10)
    assert.equal(calls, 1, "cached evidence cannot mask an outage")
    await engine.observe("a", evidence)
    assert.equal((await engine.get("a")).collectionError, null)
    await delay(10)
    assert.equal(calls, 1, "same evidence recovers by reusing accepted diagram, without model call")
    assert.equal((await engine.get("a")).stale, false)
  } finally { await engine.dispose() }
})

test("endpoint body transport failure is not misclassified as malformed JSON", async () => {
  const config = ConfigSchema.parse({ baseURL: "http://127.0.0.1:1/v1", model: "fixture" })
  const client = createDiagramClient(config, async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("private network details")) },
  })))
  await assert.rejects(client([{ id: "e", label: "source", text: "Gateway -> Queue" }], null, false, new AbortController().signal),
    /^Error: Diagram endpoint unavailable$/)
})
