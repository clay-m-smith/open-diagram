import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { defineDiagramPlugin } from "../src/diagram/server.js"

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 4000
  while (!predicate()) { assert.ok(Date.now() < end, "admission deadline"); await delay(5) }
}
async function fixture() {
  let methods: any; let calls = 0; let width = 128
  let held: ReturnType<typeof deferred<{ text: string }>> | undefined
  let context: ReturnType<typeof deferred<void>> | undefined
  let collecting = false
  const updates: any[] = []
  const hooks = new Map<string, (event: { sessionID: string }) => void>()
  const output = () => ({ relevant: true, reason: "fixture", views: [{ id: "model", label: "Model", graph: {
    title: "Model", summary: "", nodes: [{ id: "conv", label: `Conv ${width}`, kind: "layer", detail: "", status: "observed", evidence: ["e1"] }], edges: [],
  } }] })
  const ctx = {
    options: {}, location: { directory: "/project", project: { id: "project" } },
    session: { get: async () => ({ id: "a", projectID: "project", location: { directory: "/project" } }),
      context: async () => { if (context) { collecting = true; await context.promise }
        return [{ type: "assistant", id: "m", time: { created: 1 }, content: [{ type: "tool", id: "read", name: "read", state: {
          status: "completed", input: { path: "/project/model.py" }, content: [{ type: "text", text: `class Model: Convolution(${width})` }] } }] }] },
      hook: async (name: string, fn: (event: { sessionID: string }) => void) => { hooks.set(name, fn) },
    },
    generate: { text: async () => { calls++; return held ? held.promise : { text: JSON.stringify(output()) } } },
    tool: { transform: async () => {}, hook: async () => {} },
    rpc: { register: async (_rpc: unknown, handlers: unknown) => { methods = handlers; return { events: { emit: async (_n: string, value: unknown) => { updates.push(value) } } } } },
    storage: { get: async () => undefined, set: async () => {} }, event: { async *subscribe() {} },
  }
  const cleanup = await defineDiagramPlugin({ backend: "opencode", providerID: "fixture", model: "fixture", intervalMs: 1000, debounceMs: 100 }).setup(ctx as unknown as Plugin.Context)
  const request = { signal: new AbortController().signal }
  return { methods, updates, hooks, request, calls: () => calls, change: () => { width = 256 },
    hold: () => { held = deferred(); return held }, release: () => { held = undefined },
    holdContext: () => { context = deferred(); return context }, collecting: () => collecting,
    refresh: () => methods.control({ sessionID: "a", refresh: true }, request),
    cleanup: async () => { context?.resolve(); held?.reject(new Error("cleanup")); await cleanup!() },
  }
}

test("Refresh admitted during active attempt cannot retry its later failure", async () => {
  const h = await fixture()
  try {
    await h.refresh(); await until(() => h.updates.at(-1)?.phase === "ready")
    h.change(); const held = h.hold()
    await h.refresh(); await until(() => h.calls() === 2)
    const context = h.holdContext()
    await h.refresh(); await until(h.collecting)
    held.reject(new Error("offline")); h.release()
    await until(() => !!h.updates.at(-1)?.updateError)
    context.resolve()
    await delay(2300)
    assert.equal(h.calls(), 2, "deferred duplicate Refresh coalesces across failure")
    await h.refresh(); await until(() => h.calls() === 3 && !h.updates.at(-1)?.updateError)
  } finally { await h.cleanup() }
})

test("rejected publication releases source change consumed by authoring collector", async () => {
  const h = await fixture()
  try {
    await h.refresh(); await until(() => h.updates.at(-1)?.phase === "ready")
    const snapshot = await h.methods.snapshot({ sessionID: "a" }, h.request)
    const previous = h.updates.at(-1)
    h.change()
    h.hooks.get("prompt")!({ sessionID: "a" })
    await assert.rejects(h.methods.publish({ sessionID: "a", token: snapshot.token,
      analysis: { relevant: true, reason: "previous", views: previous.views } }, h.request), /snapshot changed/)
    await until(() => h.updates.at(-1)?.graph?.nodes[0].label === "Conv 256" && !h.updates.at(-1)?.stale)
    assert.equal(h.calls(), 2)
  } finally { await h.cleanup() }
})
