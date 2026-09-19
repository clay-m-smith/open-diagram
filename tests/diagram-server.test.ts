import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import type { Plugin } from "@opencode/plugin"
import { defineDiagramPlugin } from "../src/diagram/server.js"
import { initialState, type DiagramMode, type DiagramState, type DiagramGranularity } from "../src/diagram/schema.js"
import type { z } from "zod"
import type { SnapshotSchema } from "../src/diagram/schema.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000
  while (!predicate()) { assert.ok(Date.now() < end, "collector deadline"); await delay(5) }
}
async function harness() {
  let methods!: {
    get(input: { sessionID: string }): Promise<DiagramState>
    control(input: { sessionID: string; mode?: DiagramMode; refresh?: boolean; granularity?: DiagramGranularity }, request: { signal: AbortSignal; error?: (type: string, message: string, data: unknown) => Error }): Promise<DiagramState>
    snapshot(input: { sessionID: string }, request: { signal: AbortSignal }): Promise<z.output<typeof SnapshotSchema>>
    publish(input: { sessionID: string; token: string; analysis: unknown }, request: { signal: AbortSignal }): Promise<DiagramState>
  }
  const state = {
    get: async () => ({ id: "a", projectID: "project", location: { directory: "/project" } }),
    context: async () => [] as unknown[],
    load: async (_key: string): Promise<unknown> => undefined,
  }
  const hooks = new Map<string, (event: { sessionID: string }) => void>()
  const storage = new Map<string, unknown>()
  const updates: DiagramState[] = []
  const tools = new Map<string, { name: string; execute(input: unknown, context: { sessionID: string }): Promise<{ content: string }> }>()
  state.load = async (key) => storage.get(key)
  const ctx = {
    options: {}, location: { directory: "/project", project: { id: "project" } },
    session: { get: () => state.get(), context: () => state.context(), hook: async (name: string, callback: (event: { sessionID: string }) => void) => { hooks.set(name, callback) } },
    tool: { transform: async (fn: Function) => fn({ get: (name: string) => tools.get(name), add: (tool: any) => tools.set(tool.name, tool) }),
      hook: async (name: string, callback: (event: { sessionID: string }) => void) => { hooks.set(name, callback) } },
    rpc: { register: async (_rpc: unknown, input: typeof methods) => {
      methods = { ...input, control: (args, request) => input.control(args, { ...request,
        error: (type, message, data) => Object.assign(new Error(message), { type, data }),
      }) }
      return { events: { emit: async (_name: string, state: DiagramState) => { updates.push(state) } } }
    } },
    storage: { get: async (key: string) => state.load(key), set: async (key: string, value: unknown) => { storage.set(key, value) } },
    event: { async *subscribe() {} },
  }
  const cleanup = await defineDiagramPlugin({ baseURL: "http://127.0.0.1:1/v1", model: "fixture" }).setup(ctx as unknown as Plugin.Context)
  return { methods, state, hooks, tools, updates, cleanup: cleanup!, control: (mode?: DiagramMode, refresh = false, signal = new AbortController().signal) => methods.control({ sessionID: "a", mode, refresh }, { signal }) }
}

test("slow or cancelled enable cannot overwrite a newer acknowledged pause", async () => {
  const h = await harness()
  const get = h.state.get
  const held = deferred<Awaited<ReturnType<typeof get>>>()
  h.state.get = () => held.promise
  const older = h.control("on")
  h.state.get = get
  assert.equal((await h.control("off")).mode, "off")
  held.resolve(await get())
  assert.equal((await older).mode, "off")
  const cancelled = deferred<Awaited<ReturnType<typeof get>>>()
  h.state.get = () => cancelled.promise
  const abort = new AbortController()
  const enabling = h.control("on", false, abort.signal)
  abort.abort()
  cancelled.resolve(await get())
  await assert.rejects(enabling, /cancelled/)
  h.state.get = get
  assert.equal((await h.methods.get({ sessionID: "a" })).mode, "off")
  await h.cleanup()
})

test("controls and hooks share one collector; pause never waits for blocked context", async () => {
  const h = await harness()
  const held = deferred<unknown[]>()
  let active = 0
  let maximum = 0
  let calls = 0
  h.state.context = async () => {
    active++; maximum = Math.max(maximum, active); calls++
    try { return calls === 1 ? await held.promise : [] } finally { active-- }
  }
  h.hooks.get("prompt")!({ sessionID: "a" })
  await until(() => calls === 1)
  await h.control(undefined, true)
  h.hooks.get("context")!({ sessionID: "a" })
  assert.equal((await h.control("off")).mode, "off")
  assert.equal(calls, 1, "RPC refresh does not bypass the active collector")
  held.resolve([])
  await until(() => calls === 2)
  assert.equal(maximum, 1)
  assert.equal((await h.methods.get({ sessionID: "a" })).mode, "off")
  await h.cleanup()
})

test("cancellation and newer pause remain authoritative across cold storage hydration", async () => {
  for (const cancel of [true, false]) {
    const h = await harness()
    const held = deferred<unknown>()
    let loading = false
    h.state.load = async () => { loading = true; return held.promise }
    const abort = new AbortController()
    const older = h.control("on", false, abort.signal)
    await until(() => loading)
    const newer = cancel ? undefined : h.control("off")
    if (cancel) abort.abort()
    held.resolve({ ...initialState("a"), mode: "off", phase: "paused" })
    if (cancel) await assert.rejects(older, /cancelled/)
    else { await Promise.all([older, newer]); assert.equal((await newer)?.mode, "off") }
    assert.equal((await h.methods.get({ sessionID: "a" })).mode, "off")
    await h.cleanup()
  }
})

test("public project identity also rejects foreign sessions at a matching directory", async () => {
  const h = await harness()
  let loads = 0
  h.state.load = async () => { loads++; return undefined }
  h.state.get = async () => ({ id: "a", projectID: "foreign", location: { directory: "/project" } })
  await assert.rejects(h.methods.get({ sessionID: "a" }), /another location/)
  await assert.rejects(h.control("on"), /another location/)
  await assert.rejects(h.methods.publish({ sessionID: "a", token: "foreign", analysis: { relevant: false, reason: "", views: [] } },
    { signal: new AbortController().signal }), /another location/)
  assert.equal(loads, 0, "rejected foreign publication cannot hydrate cache through recovery")
  await h.cleanup()
})

test("refresh-only requests cannot supersede pause during admission or hydration", async () => {
  for (const hydration of [false, true]) {
    const h = await harness()
    try {
      const get = h.state.get
      const gate = deferred<unknown>()
      let loading = false
      if (hydration) h.state.load = async () => { loading = true; return gate.promise }
      else h.state.get = async () => { await gate.promise; return get() }
      const pausing = h.control("off")
      if (hydration) await until(() => loading)
      else h.state.get = get
      const refresh = h.control(undefined, true)
      if (!hydration) await refresh
      gate.resolve(undefined)
      assert.equal((await pausing).mode, "off")
      await refresh
      assert.equal((await h.methods.get({ sessionID: "a" })).mode, "off")
    } finally { await h.cleanup() }
  }
})

test("native snapshot/publish tools bind session, share RPC validation and preserve paused mode", async () => {
  const h = await harness()
  try {
    await h.control("off")
    h.state.context = async () => [{ type: "user", id: "u", text: "Gateway sends messages to Queue", time: { created: 1 } }]
    const snapshotTool = h.tools.get("open_diagram_snapshot")!
    const publishTool = h.tools.get("open_diagram_publish")!
    const snapshot = JSON.parse((await snapshotTool.execute({}, { sessionID: "a" })).content)
    assert.equal(snapshot.sessionID, "a")
    assert.ok(snapshot.evidence.length)
    const analysis = { relevant: true, reason: "Workflow", views: [{ id: "flow", label: "Flow", graph: {
      title: "Messages", summary: "", nodes: [{ id: "gateway", label: "Gateway", kind: "service", detail: "", status: "planned", evidence: [snapshot.evidence[0].id] }], edges: [],
    } }] }
    const result = JSON.parse((await publishTool.execute({ token: snapshot.token, analysis }, { sessionID: "a" })).content)
    assert.deepEqual(result.views, [{ id: "flow", label: "Flow" }])
    assert.equal((await h.methods.get({ sessionID: "a" })).phase, "paused")
    await assert.rejects(publishTool.execute({ token: snapshot.token, analysis }, { sessionID: "a" }), /snapshot changed/)
    const signal = new AbortController().signal
    const fresh = await h.methods.snapshot({ sessionID: "a" }, { signal })
    h.state.context = async () => [{ type: "user", id: "u", text: "Different design", time: { created: 1 } }]
    await assert.rejects(h.methods.publish({ sessionID: "a", token: fresh.token, analysis }, { signal }), /snapshot changed/)
    h.state.get = async () => ({ id: "foreign", projectID: "other", location: { directory: "/elsewhere" } })
    await assert.rejects(snapshotTool.execute({}, { sessionID: "foreign" }), /another location/)
  } finally { await h.cleanup() }
})

test("background collection failures reach RPC status and clear only after successful recollection", async () => {
  const h = await harness()
  try {
    h.state.load = async () => ({ ...initialState("a"), mode: "off", phase: "paused", relevant: true,
      graph: { title: "Saved", summary: "", nodes: [{ id: "a", label: "A", kind: "service", detail: "", status: "observed", evidence: ["old"] }], edges: [] } })
    h.state.context = async () => { throw new Error("PRIVATE CONTEXT ERROR") }
    await h.methods.get({ sessionID: "a" })
    h.hooks.get("context")!({ sessionID: "a" })
    await until(() => h.updates.some((state) => !!state.collectionError))
    const failed = await h.methods.get({ sessionID: "a" })
    assert.equal(failed.graph?.title, "Saved")
    assert.equal(failed.stale, true)
    assert.equal(failed.mode, "off")
    assert.match(failed.collectionError!, /evidence unavailable/)
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/)
    h.state.context = async () => []
    await h.control(undefined, true)
    await until(() => h.updates.at(-1)?.collectionError === null)
    assert.equal((await h.methods.get({ sessionID: "a" })).collectionError, null)
    assert.equal((await h.methods.get({ sessionID: "a" })).mode, "off", "Refresh recovers evidence without resuming tracking")
  } finally { await h.cleanup() }
})

test("snapshot GET is cache-only; hooks and explicit Refresh still collect", async () => {
  const h = await harness()
  let reads = 0
  h.state.context = async () => { reads++; return [] }
  try {
    for (let i = 0; i < 5; i++) await h.methods.get({ sessionID: "a" })
    await delay(200)
    assert.equal(reads, 0, "viewing saved or empty state never collects")
    h.hooks.get("context")!({ sessionID: "a" })
    await until(() => reads === 1)
    for (let i = 0; i < 5; i++) await h.methods.get({ sessionID: "a" })
    await delay(200)
    assert.equal(reads, 1)
    await h.control(undefined, true)
    await until(() => reads === 2)
  } finally { await h.cleanup() }
})

test("saturated collectors reject explicit refresh and enable, preserve pause, and permit retry", async () => {
  const h = await harness()
  const held = deferred<unknown[]>()
  let active = 0
  let reads = 0
  try {
    await h.methods.snapshot({ sessionID: "a" }, { signal: new AbortController().signal })
    h.state.context = async () => {
      active++; reads++
      try { return await held.promise } finally { active-- }
    }
    for (let index = 0; index < 64; index++) h.hooks.get("prompt")!({ sessionID: `busy-${index}` })
    await until(() => active === 64)
    await assert.rejects(h.control(undefined, true), /collection capacity reached/)
    assert.equal((await h.control("off")).mode, "off", "pause never waits for collector capacity")
    await assert.rejects(h.control("on"), /collection capacity reached/)
    assert.equal((await h.methods.get({ sessionID: "a" })).mode, "on", "mode is saved even when collection must be retried")
    assert.equal(reads, 64, "explicit controls never bypass fresh-evidence admission")
    held.resolve([])
    await until(() => active === 0)
    await h.control(undefined, true)
    await until(() => reads === 65)
  } finally { held.resolve([]); await h.cleanup() }
})

test("newer depth wins admission while depth-only requests cannot supersede pending pause", async () => {
  const h = await harness()
  const get = h.state.get
  const signal = new AbortController().signal
  const held = deferred<Awaited<ReturnType<typeof get>>>()
  try {
    h.state.get = () => held.promise
    const older = h.methods.control({ sessionID: "a", granularity: "granular" }, { signal })
    h.state.get = get
    assert.equal((await h.methods.control({ sessionID: "a", granularity: "overview" }, { signal })).granularity, "overview")
    held.resolve(await get())
    assert.equal((await older).granularity, "overview")
    const gate = deferred<Awaited<ReturnType<typeof get>>>()
    h.state.get = () => gate.promise
    const pausing = h.control("off")
    h.state.get = get
    await h.methods.control({ sessionID: "a", granularity: "granular" }, { signal })
    gate.resolve(await get())
    const paused = await pausing
    assert.equal(paused.mode, "off")
    assert.equal(paused.granularity, "granular")
    const snapshot = await h.methods.snapshot({ sessionID: "a" }, { signal })
    assert.equal(snapshot.granularity, "granular")
    assert.match(snapshot.instruction, /Granularity: granular/)
  } finally { held.resolve(await get()); h.state.get = get; await h.cleanup() }
})

test("combined controls retain each unsuperseded field across admission and hydration", async () => {
  for (const hydration of [false, true]) for (const newerField of ["mode", "granularity"] as const) {
    const h = await harness()
    const gate = deferred<unknown>()
    const get = h.state.get
    const signal = new AbortController().signal
    let loading = false
    try {
      if (hydration) h.state.load = async () => { loading = true; return gate.promise }
      else h.state.get = async () => { await gate.promise; return get() }
      const older = h.methods.control({ sessionID: "a", mode: "off", granularity: "granular" }, { signal })
      if (hydration) await until(() => loading)
      else h.state.get = get
      const newer = h.methods.control({ sessionID: "a", ...(newerField === "mode" ? { mode: "on" as const } : { granularity: "overview" as const }) }, { signal })
      if (!hydration) await newer
      gate.resolve(undefined)
      await Promise.all([older, newer])
      const state = await h.methods.get({ sessionID: "a" })
      assert.equal(state.mode, newerField === "mode" ? "on" : "off")
      assert.equal(state.granularity, newerField === "mode" ? "granular" : "overview")
    } finally { gate.resolve(undefined); h.state.get = get; await h.cleanup() }
  }
})

test("late empty collector cannot revert acknowledged granular depth", async () => {
  const h = await harness()
  const gate = deferred<unknown[]>()
  let collecting = false
  try {
    h.state.context = async () => { collecting = true; return gate.promise }
    h.hooks.get("prompt")!({ sessionID: "a" })
    await until(() => collecting)
    await h.methods.control({ sessionID: "a", granularity: "granular" }, { signal: new AbortController().signal })
    gate.resolve([])
    await h.methods.snapshot({ sessionID: "a" }, { signal: new AbortController().signal })
    assert.equal((await h.methods.get({ sessionID: "a" })).granularity, "granular")
  } finally { gate.resolve([]); await h.cleanup() }
})
