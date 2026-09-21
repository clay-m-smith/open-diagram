import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { defineDiagramPlugin } from "../src/diagram/server.js"

async function until(predicate: () => boolean) {
  const end = Date.now() + 2000
  while (!predicate()) { assert.ok(Date.now() < end, "reservation release deadline"); await delay(5) }
}
async function fixture() {
  let methods: any; let calls = 0; let failContext = false; let rejectLocation = false; let loads = 0; let width = 128
  let held = false; let resolve!: (value: { text: string }) => void; let activeSignal: AbortSignal | undefined
  const hooks = new Map<string, Function>(); const tools = new Map<string, any>(); const updates: any[] = []
  const output = { text: JSON.stringify({ relevant: true, reason: "fixture", views: [{ id: "model", label: "Model", graph: {
    title: "Model", summary: "", nodes: [{ id: "conv", label: "Conv", kind: "layer", detail: "", status: "observed", evidence: ["e1"] }], edges: [],
  } }] }) }
  const ctx = {
    options: {}, location: { directory: "/project", project: { id: "project" } },
    session: { get: async () => ({ id: "a", projectID: rejectLocation ? "foreign" : "project", location: { directory: "/project" } }),
      context: async () => { if (failContext) throw new Error("context offline"); return [{ type: "assistant", id: "m", time: { created: 1 }, content: [{ type: "tool", id: "read", name: "read", state: {
        status: "completed", input: { path: "/project/model.py" }, content: [{ type: "text", text: `class Model: Convolution(${width})` }] } }] }] },
      hook: async (name: string, fn: Function) => { hooks.set(name, fn) },
    },
    generate: { text: async (_input: unknown, options: { signal: AbortSignal }) => { calls++; activeSignal = options.signal; return held ? new Promise<{ text: string }>((done) => { resolve = done }) : output } },
    tool: { transform: async (fn: Function) => fn({ get: (name: string) => tools.get(name), add: (tool: any) => tools.set(tool.name, tool) }), hook: async (name: string, fn: Function) => { hooks.set(name, fn) } },
    rpc: { register: async (_rpc: unknown, handlers: unknown) => { methods = handlers; return { events: { emit: async (_n: string, value: unknown) => { updates.push(value) } } } } },
    storage: { get: async () => { loads++; return undefined }, set: async () => {} }, event: { async *subscribe() {} },
  }
  const cleanup = await defineDiagramPlugin({ backend: "opencode", providerID: "fixture", model: "fixture", intervalMs: 1000, debounceMs: 100 },
    async () => ({ generate: ctx.generate.text, owns: () => false })).setup(ctx as unknown as Plugin.Context)
  const request = { signal: new AbortController().signal }
  return { methods, hooks, tools, updates, request, calls: () => calls, loads: () => loads, signal: () => activeSignal,
    failContext: (value: boolean) => { failContext = value }, foreign: () => { rejectLocation = true },
    change: () => { width = 256 },
    hold: () => { held = true }, release: () => { held = false; resolve?.(output) },
    snapshot: () => methods.snapshot({ sessionID: "a" }, request),
    cleanup: async () => { resolve?.(output); await cleanup!() },
  }
}

test("explicit Refresh claims automatic active request before a snapshot can cancel it", async () => {
  const h = await fixture()
  try {
    h.hold(); h.hooks.get("prompt")!({ sessionID: "a" }); await until(() => h.calls() === 1)
    await h.methods.control({ sessionID: "a", refresh: true }, h.request)
    await h.snapshot()
    assert.equal(h.signal()!.aborted, false)
    h.release(); await until(() => h.updates.at(-1)?.phase === "ready")
    assert.equal(h.calls(), 1)
  } finally { await h.cleanup() }
})

test("rejected older publisher cannot release newer material snapshot reservation", async () => {
  const h = await fixture()
  try {
    const first = await h.snapshot()
    h.change()
    const second = await h.snapshot()
    assert.notEqual(first.token, second.token)
    await assert.rejects(h.methods.publish({ sessionID: "a", token: first.token,
      analysis: { relevant: false, reason: "old", views: [] } }, h.request), /snapshot changed/)
    h.hooks.get("context")!({ sessionID: "a" })
    await delay(350)
    assert.equal(h.calls(), 0)
    const current = await h.methods.publish({ sessionID: "a", token: second.token,
      analysis: { relevant: false, reason: "current", views: [] } }, h.request)
    assert.equal(current.reason, "current")
  } finally { await h.cleanup() }
})

test("admitted publication collection failure releases reservation for recovered hooks", async () => {
  const h = await fixture()
  try {
    const snapshot = await h.snapshot()
    h.failContext(true)
    await assert.rejects(h.methods.publish({ sessionID: "a", token: snapshot.token, analysis: {} }, h.request), /evidence unavailable/)
    h.failContext(false); h.hooks.get("context")!({ sessionID: "a" })
    await until(() => h.calls() === 1)
  } finally { await h.cleanup() }
})

test("native tool schema rejection releases existing local reservation without accepting output", async () => {
  const h = await fixture()
  try {
    const snapshot = await h.snapshot()
    await assert.rejects(h.tools.get("open_diagram_publish").execute({ token: snapshot.token, analysis: { relevant: true, reason: "bad", views: [] } }, { sessionID: "a" }))
    h.hooks.get("execute.after")!({ sessionID: "a" })
    await until(() => h.calls() === 1)
    assert.equal(h.updates.some((item) => item.reason === "bad"), false)
  } finally { await h.cleanup() }
})

test("unadmitted failed publication does not hydrate a foreign session", async () => {
  const h = await fixture()
  try {
    h.foreign()
    await assert.rejects(h.methods.publish({ sessionID: "a", token: "bad", analysis: {} }, h.request), /another location/)
    assert.equal(h.loads(), 0)
  } finally { await h.cleanup() }
})
