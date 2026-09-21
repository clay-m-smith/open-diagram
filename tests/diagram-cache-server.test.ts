import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { defineDiagramPlugin } from "../src/diagram/server.js"

test("main-agent snapshot cannot swallow admitted Refresh or cold depth authoring", async () => {
  let methods: any
  let calls = 0
  let fail = false
  let width = 128
  const updates: any[] = []
  const ctx = {
    options: {}, location: { directory: "/project", project: { id: "project" } },
    session: { get: async () => ({ id: "a", projectID: "project", location: { directory: "/project" } }),
      context: async () => [{ type: "assistant", id: "m", time: { created: 1 }, content: [{ type: "tool", id: "read", name: "read",
        state: { status: "completed", input: { path: "/project/model.py" }, content: [{ type: "text", text: `class Model: encoder = Convolution(${width})` }] } }] }],
      hook: async () => {},
    },
    generate: { text: async () => {
      calls++
      if (fail) throw new Error("offline")
      return { text: JSON.stringify({ relevant: true, reason: "Fixture", views: [{ id: "model", label: "Model", graph: {
        title: "Model", summary: "", nodes: [{ id: "conv", label: `Conv ${width}`, kind: "layer", detail: "", status: "observed", evidence: ["e1"] }], edges: [],
      } }] }) }
    } },
    tool: { transform: async () => {}, hook: async () => {} },
    rpc: { register: async (_rpc: unknown, handlers: unknown) => { methods = handlers; return { events: { emit: async (_name: string, value: unknown) => { updates.push(value) } } } } },
    storage: { get: async () => undefined, set: async () => {} }, event: { async *subscribe() {} },
  }
  const cleanup = await defineDiagramPlugin({ backend: "opencode", providerID: "fixture", model: "model", intervalMs: 1000, debounceMs: 100 },
    async () => ({ generate: ctx.generate.text, owns: () => false })).setup(ctx as unknown as Plugin.Context)
  const request = { signal: new AbortController().signal }
  const wait = async (predicate: () => boolean) => {
    const end = Date.now() + 4000
    while (!predicate()) { assert.ok(Date.now() < end, "server cache deadline"); await delay(5) }
  }
  try {
    await methods.control({ sessionID: "a", refresh: true }, request)
    await methods.snapshot({ sessionID: "a" }, request)
    await wait(() => updates.some((item) => item.phase === "ready"))
    const initial = calls
    fail = true; width = 256
    await methods.control({ sessionID: "a", refresh: true }, request)
    await wait(() => updates.some((item) => item.updateError))
    assert.equal(calls, initial + 1)
    fail = false
    await methods.control({ sessionID: "a", refresh: true }, request)
    await methods.snapshot({ sessionID: "a" }, request)
    await wait(() => updates.some((item) => item.graph?.nodes[0].label === "Conv 256" && !item.updateError))
    assert.equal(calls, initial + 2)
    await methods.control({ sessionID: "a", granularity: "granular" }, request)
    await methods.snapshot({ sessionID: "a" }, request)
    await wait(() => updates.some((item) => item.granularity === "granular" && item.phase === "ready" && !item.stale))
    assert.equal(calls, initial + 3)
  } finally { await cleanup!() }
})
