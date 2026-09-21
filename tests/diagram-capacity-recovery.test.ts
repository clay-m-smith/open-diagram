import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { DiagramEngine } from "../src/diagram/engine.js"
import { defineDiagramPlugin } from "../src/diagram/server.js"

async function until(predicate: () => boolean) {
  const end = Date.now() + 3000
  while (!predicate()) { assert.ok(Date.now() < end, "recovery deadline"); await delay(5) }
}

test("collection cancellation retains same-input work for bounded snapshot abandonment fallback", async () => {
  let calls = 0
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 40, authoringMs: 20,
    load: async () => undefined, save: async () => {}, publish: async () => {},
    analyze: async () => { calls++; return { relevant: false, reason: "fallback", graph: null, views: [] } },
  })
  const data = [{ id: "source", label: "model.py", text: "class Encoder: Convolution(128)", category: "source" as const }]
  try {
    await engine.observe("a", data)
    engine.collectionFailed("a")
    await engine.observe("a", data, false)
    const snapshot = await engine.snapshot("a")
    assert.equal(snapshot.state.collectionError, null)
    assert.equal(snapshot.state.reason, "Awaiting main-agent diagram publication")
    await engine.observe("a", data)
    assert.equal(calls, 0)
    await until(() => calls === 1)
  } finally { await engine.dispose() }
})

test("capacity admission delayed across healthy recollection cannot invalidate newer evidence", async () => {
  let methods: any; let blocked = 0; let finished = 0; let width = 128; let holdAdmission = false; let heldAdmission = false; let observed = 0
  let release!: () => void; let admit!: () => void
  const contexts = new Promise<void>((resolve) => { release = resolve })
  const admission = new Promise<void>((resolve) => { admit = resolve })
  const hooks = new Map<string, Function>()
  const ctx = {
    options: {}, location: { directory: "/project", project: { id: "project" } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === "a" && holdAdmission) { holdAdmission = false; heldAdmission = true; await admission }
        return { id: sessionID, projectID: "project", location: { directory: "/project" } }
      },
      context: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID !== "a") { blocked++; await contexts; finished++; return [] }
        observed++
        return [{ type: "assistant", id: "m", time: { created: 1 }, content: [{ type: "tool", id: "read", name: "read", state: {
          status: "completed", input: { path: "/project/model.py" }, content: [{ type: "text", text: `class Model: Convolution(${width})` }] } }] }]
      }, hook: async (name: string, fn: Function) => { hooks.set(name, fn) },
    },
    generate: { text: async () => ({ text: '{"relevant":false,"reason":"fixture","views":[]}' }) },
    tool: { transform: async () => {}, hook: async () => {} },
    rpc: { register: async (_rpc: unknown, handlers: unknown) => { methods = handlers; return { events: { emit: async () => {} } } } },
    storage: { get: async () => undefined, set: async () => {} }, event: { async *subscribe() {} },
  }
  const cleanup = await defineDiagramPlugin({ backend: "opencode", providerID: "fixture", model: "fixture", intervalMs: 1000, debounceMs: 500 },
    async () => ({ generate: ctx.generate.text, owns: () => false })).setup(ctx as unknown as Plugin.Context)
  const request = { signal: new AbortController().signal }
  try {
    await methods.snapshot({ sessionID: "a" }, request)
    for (let i = 0; i < 64; i++) hooks.get("context")!({ sessionID: `blocked${i}` })
    await until(() => blocked === 64)
    holdAdmission = true
    const delayed = methods.snapshot({ sessionID: "a" }, request).catch((error: Error) => error)
    await until(() => heldAdmission)
    release(); await until(() => finished === 64)
    width = 256; hooks.get("context")!({ sessionID: "a" }); await until(() => observed >= 2)
    admit()
    const snapshot = await delayed
    assert.equal((await methods.get({ sessionID: "a" })).collectionError, null)
    assert.ok(!(snapshot instanceof Error), "admission rechecks recovered capacity instead of rejecting obsolete saturation")
    assert.ok(snapshot.evidence.some((item: { text: string }) => item.text.includes("Convolution(256)")))
  } finally { release(); admit(); await cleanup!() }
})
