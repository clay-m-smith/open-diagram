import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { defineDiagramPlugin } from "../src/diagram/server.js"

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate()) { assert.ok(Date.now() < deadline, "capacity-path deadline"); await delay(5) }
}

for (const action of ["snapshot", "refresh", "hook"] as const) for (const phase of ["pending", "active"] as const) {
  test(`${action} capacity rejection blocks ${phase} authoring until fresh collection`, async () => {
    let methods: any; let collected = false; let blocked = 0; let completed = 0; let width = 128
    let release!: () => void
    const held = new Promise<void>((done) => { release = done })
    const calls: { signal: AbortSignal; finish(value: { text: string }): void; prompt: string }[] = []
    const hooks = new Map<string, Function>()
    const ctx = {
      options: {}, location: { directory: "/project", project: { id: "project" } },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: "project", location: { directory: "/project" } }),
        context: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID !== "a") { blocked++; await held; completed++; return [] }
          collected = true
          return [{ type: "assistant", id: "m", time: { created: 1 }, content: [{ type: "tool", id: "read", name: "read", state: {
            status: "completed", input: { path: "/project/model.py" }, content: [{ type: "text", text: `class Model: Convolution(${width})` }] } }] }]
        }, hook: async (name: string, fn: Function) => { hooks.set(name, fn) },
      },
      generate: { text: (input: { prompt: string }, options: { signal: AbortSignal }) => new Promise<{ text: string }>((finish) => { calls.push({ ...options, finish, prompt: input.prompt }) }) },
      tool: { transform: async () => {}, hook: async () => {} },
      rpc: { register: async (_rpc: unknown, handlers: unknown) => { methods = handlers; return { events: { emit: async () => {} } } } },
      storage: { get: async () => undefined, set: async () => {} }, event: { async *subscribe() {} },
    }
    const cleanup = await defineDiagramPlugin({ backend: "opencode", providerID: "fixture", model: "fixture", intervalMs: 1000,
      debounceMs: phase === "pending" ? 500 : 100 }, async () => ({ generate: ctx.generate.text, owns: () => false })).setup(ctx as unknown as Plugin.Context)
    const request = { signal: new AbortController().signal, error: (_type: string, message: string) => Error(message) }
    const output = { text: '{"relevant":false,"reason":"fixture","views":[]}' }
    try {
      hooks.get("context")!({ sessionID: "a" }); await until(() => collected)
      if (phase === "active") await until(() => calls.length === 1)
      for (let i = 0; i < 64; i++) hooks.get("context")!({ sessionID: `blocked${i}` })
      await until(() => blocked === 64)
      width = 256
      if (action === "hook") hooks.get("context")!({ sessionID: "a" })
      else await assert.rejects(action === "snapshot" ? methods.snapshot({ sessionID: "a" }, request)
        : methods.control({ sessionID: "a", refresh: true }, request), /capacity/)
      assert.match((await methods.get({ sessionID: "a" })).collectionError, /evidence unavailable/)
      if (phase === "active") { assert.equal(calls[0].signal.aborted, true); calls[0].finish(output) }
      await delay(550)
      assert.equal(calls.length, phase === "active" ? 1 : 0)
      assert.equal((await methods.get({ sessionID: "a" })).updatedAt, null)
      release(); await until(() => completed === 64)
      hooks.get("context")!({ sessionID: "a" })
      await until(() => calls.length === (phase === "active" ? 2 : 1))
      assert.match(calls.at(-1)!.prompt, /Convolution\(256\)/)
      calls.at(-1)!.finish(output)
    } finally { release(); for (const call of calls) call.finish(output); await cleanup!() }
  })
}
