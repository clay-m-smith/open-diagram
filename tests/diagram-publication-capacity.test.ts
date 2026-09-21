import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { defineDiagramPlugin } from "../src/diagram/server.js"

test("publication collector-capacity rejection blocks old evidence fallback until recollection", async () => {
  let methods: any; let calls = 0; let blocked = 0; let finished = 0; let release!: () => void
  const callCount = () => calls
  const pending = new Promise<void>((resolve) => { release = resolve })
  const hooks = new Map<string, Function>()
  const ctx = {
    options: {}, location: { directory: "/project", project: { id: "project" } },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: "project", location: { directory: "/project" } }),
      context: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID !== "a") { blocked++; await pending; finished++; return [] }
        return [{ type: "assistant", id: "m", time: { created: 1 }, content: [{ type: "tool", id: "read", name: "read", state: {
          status: "completed", input: { path: "/project/model.py" }, content: [{ type: "text", text: "class Model: Convolution(128)" }] } }] }]
      }, hook: async (name: string, fn: Function) => { hooks.set(name, fn) },
    },
    generate: { text: async () => { calls++; return { text: '{"relevant":false,"reason":"fixture","views":[]}' } } },
    tool: { transform: async () => {}, hook: async () => {} },
    rpc: { register: async (_rpc: unknown, handlers: unknown) => { methods = handlers; return { events: { emit: async () => {} } } } },
    storage: { get: async () => undefined, set: async () => {} }, event: { async *subscribe() {} },
  }
  const cleanup = await defineDiagramPlugin({ backend: "opencode", providerID: "fixture", model: "fixture", intervalMs: 1000, debounceMs: 100 },
    async () => ({ generate: ctx.generate.text, owns: () => false })).setup(ctx as unknown as Plugin.Context)
  const request = { signal: new AbortController().signal }
  try {
    const snapshot = await methods.snapshot({ sessionID: "a" }, request)
    for (let i = 0; i < 64; i++) hooks.get("context")!({ sessionID: `blocked${i}` })
    const deadline = Date.now() + 2000
    while (blocked !== 64) { assert.ok(Date.now() < deadline); await delay(5) }
    await assert.rejects(methods.publish({ sessionID: "a", token: snapshot.token, analysis: { relevant: false, reason: "old", views: [] } }, request), /capacity/)
    assert.match((await methods.get({ sessionID: "a" })).collectionError, /evidence unavailable/)
    await delay(350)
    assert.equal(callCount(), 0, "failure before context read cannot author from prior evidence")
    release()
    while (finished !== 64) { assert.ok(Date.now() < deadline); await delay(5) }
    hooks.get("context")!({ sessionID: "a" })
    const recovered = Date.now() + 2000
    while (callCount() !== 1) { assert.ok(Date.now() < recovered, "healthy recollection releases fallback"); await delay(5) }
  } finally { release(); await cleanup!() }
})
