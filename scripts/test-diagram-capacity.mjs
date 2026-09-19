import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { withV2Runtime, waitForPlugin } from "./v2-runtime.mjs"
import { diagramRpcProblem } from "../src/diagram/tui.tsx"

// Inject blocked public-context reads, but exercise the actual native RPC
// registration, transport, declared error serialization, and client decoder.
await withV2Runtime(async (client, { temporary }) => {
  const project = join(temporary, "project")
  await mkdir(join(project, "fixture"), { recursive: true })
  await writeFile(join(project, "fixture/index.ts"), `
import { Plugin } from ${JSON.stringify(import.meta.resolve("@opencode/plugin"))}
import { Rpc } from ${JSON.stringify(import.meta.resolve("@opencode/plugin/rpc"))}
import { z } from ${JSON.stringify(import.meta.resolve("zod"))}
import { defineDiagramPlugin } from ${JSON.stringify(new URL("../src/diagram/server.ts", import.meta.url).href)}
export default Plugin.define({ id: "open-diagram-capacity-fixture", async setup(ctx) {
  let release, ready, active = 0, failSave = false
  const held = new Promise(resolve => release = resolve)
  const saturated = new Promise(resolve => ready = resolve)
  const hooks = new Map()
  const cleanup = await defineDiagramPlugin({ backend: "manual" }).setup({ ...ctx,
    storage: { ...ctx.storage, set: async (...args) => {
      if (failSave) throw new Error("PRIVATE storage outage")
      return ctx.storage.set(...args)
    } }, session: { ...ctx.session,
    get: (input, options) => input.sessionID.startsWith("capacity-")
      ? Promise.resolve({ id: input.sessionID, projectID: ctx.location.project.id, location: { directory: ctx.location.directory } })
      : ctx.session.get(input, options),
    context: async (input, options) => {
      if (!input.sessionID.startsWith("capacity-")) return ctx.session.context(input, options)
      if (++active === 64) ready()
      await held
      return []
    },
    hook: async (name, callback) => { hooks.set(name, callback); return ctx.session.hook(name, callback) },
  } })
  await ctx.rpc.register(Rpc.define({ id: "open-diagram-capacity-fixture", methods: {
    hold: { input: z.object({}).strict(), output: z.object({}).strict() },
    release: { input: z.object({}).strict(), output: z.object({}).strict() },
    failSave: { input: z.object({}).strict(), output: z.object({}).strict() },
  }, events: {} }), {
    hold: async () => { for (let i = 0; i < 64; i++) hooks.get("prompt")({ sessionID: "capacity-" + i }); await saturated; return {} },
    release: async () => { release(); return {} },
    failSave: async () => { failSave = true; return {} },
  })
  return async () => { release(); await cleanup?.() }
} })
`)
  await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: ["./fixture"] }))
  const location = { directory: project }
  await waitForPlugin(client, location, "open-diagram-capacity-fixture")
  const signal = AbortSignal.timeout(15_000)
  const call = async (rpcID, method, input) => (await client.rpc.call({ location, rpcID, method, input }, { signal })).output
  const session = await client.session.create({ location, title: "Capacity transport fixture" })
  await call("open-diagram", "snapshot", { sessionID: session.id })
  try {
    await call("open-diagram-capacity-fixture", "hold", {})
    const capacity = (mode, saveFailed = false) => async () => {
      try { await call("open-diagram", "control", { sessionID: session.id, refresh: true, ...(mode ? { mode } : {}) }) }
      catch (error) {
        assert.equal(error.type, "capacity")
        assert.match(error.message, /collection capacity reached; refresh to retry/)
        assert.equal(error.data.mode, mode ?? "auto")
        const visible = diagramRpcProblem(error)
        assert.match(visible, /capacity reached; refresh to retry/)
        assert.doesNotMatch(visible, /server unavailable|PRIVATE/)
        if (saveFailed) {
          assert.match(error.data.cacheError, /cache write failed/)
          assert.match(error.message, /Tracking preference is not saved/)
          assert.doesNotMatch(JSON.stringify(error.data), /PRIVATE/)
          assert.match(visible, /preference is not saved.*cache write failed/)
        } else assert.equal(error.data.cacheError, null)
        return
      }
      assert.fail("Native RPC silently accepted saturated collection")
    }
    await capacity()()
    const paused = await call("open-diagram", "control", { sessionID: session.id, mode: "off" })
    assert.equal(paused.mode, "off")
    await capacity("on")()
    assert.equal((await call("open-diagram", "get", { sessionID: session.id })).mode, "on")
    await call("open-diagram", "control", { sessionID: session.id, mode: "off" })
    await call("open-diagram-capacity-fixture", "failSave", {})
    await capacity("on", true)()
    assert.match((await call("open-diagram", "get", { sessionID: session.id })).cacheError, /cache write failed/)
    console.log("OK: native RPC preserves capacity error type, retry message and saved mode; pause remains available")
    console.log("OK: simultaneous capacity and storage failure preserves both diagnostics without claiming durable mode")
  } finally { await call("open-diagram-capacity-fixture", "release", {}) }
})
