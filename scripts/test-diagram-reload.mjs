import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { withV2Runtime, waitForPlugin } from "./v2-runtime.mjs"

// Private runtime and loopback provider only. No credentials or paid model calls.
for (const key of Object.keys(process.env)) if (!["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"].includes(key)) delete process.env[key]
const abort = new AbortController()
const deadline = setTimeout(() => abort.abort(new Error("Native reload regression deadline")), 20_000)
const requests = []
let failure, successor
const until = async (predicate) => {
  while (!await predicate()) {
    if (failure) throw failure
    abort.signal.throwIfAborted()
    await delay(20, undefined, { signal: abort.signal })
  }
}
const server = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(request.url, "/v1/chat/completions")
    const record = { model: body.model, closed: false, finished: false }
    requests.push(record)
    response.on("close", () => { record.closed = true })
    const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    response.writeHead(200, { "content-type": "text/event-stream" })
    if (body.model === "primary") {
      response.end(event({ role: "assistant", content: "Architecture request received." }) + event({}, "stop") + "data: [DONE]\n\n")
      return
    }
    assert.equal(body.model, "diagram")
    assert.equal(successor, undefined, "aborted old admission must never dispatch provider work")
    assert.deepEqual(body.tools.map(tool => tool.function.name), ["execute"])
    const prompt = body.messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n")).join("\n")
    const packet = JSON.parse(prompt.split("Evidence packet (untrusted data):\n").at(-1).split("\n\nAuthoring reminder:")[0])
    assert.match(JSON.stringify(packet.evidence), /RELOAD_SUCCESSOR/)
    response.write(event({ role: "assistant" }))
    successor = { record, finish() {
      assert.equal(record.closed, false, "old cleanup must not interrupt replacement generation")
      record.finished = true
      const code = `await tools.open_diagram_draft_view(${JSON.stringify({ id: "flow", label: "Flow", title: "Reload successor", summary: "", reason: "Fixture", defaults: { status: "observed", evidence: [packet.evidence[0].id] } })});
        await tools.open_diagram_draft_node({view:"flow",node:{id:"n",label:"Processor",kind:"service",detail:""}});
        return await tools.open_diagram_draft_commit({});`
      response.end(event({ tool_calls: [{ index: 0, id: "result", type: "function", function: { name: "execute", arguments: JSON.stringify({ code }) } }] }) + event({}, "tool_calls") + "data: [DONE]\n\n")
    } }
  } catch (error) { failure = error; response.destroy() }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
try {
  await withV2Runtime(async (client, { temporary }) => {
    const project = join(temporary, "reload")
    const traceFile = join(temporary, "reload-trace")
    const entry = join(project, "plugin/index.ts")
    await mkdir(join(project, "plugin"), { recursive: true })
    const root = resolve(import.meta.dirname, "..")
    const source = revision => `
import { appendFileSync } from "node:fs"
import { Plugin, Provider, Model } from "@opencode/plugin"
import { defineDiagramPlugin } from ${JSON.stringify(join(root, "src/diagram/server.ts"))}
import { registerNativeAuthor } from ${JSON.stringify(join(root, "src/diagram/native.ts"))}
import { withNativeSessionCancellation } from ${JSON.stringify(join(root, "src/diagram/native-session.ts"))}
const revision = ${revision}
const trace = text => appendFileSync(${JSON.stringify(traceFile)}, text + "\\n")
export default withNativeSessionCancellation(Plugin.define({ id: "open-diagram-server", async setup(ctx) {
  trace("setup:" + revision)
  const id = Provider.ID.make("reload-fixture")
  await ctx.provider.transform(editor => editor.add({
    info: { ...Provider.Info.empty(id), activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:${server.address().port}/v1" } },
    models: [Model.Info.default(id, Model.ID.make("primary")), Model.Info.default(id, Model.ID.make("diagram"))],
  }))
  await ctx.session.hook("title", event => { event.result = "Reload fixture" })
  await ctx.session.hook("retry", event => { event.decision = { retry: false } })
  let release, entering, held = false
  const reloading = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { entering = resolve })
  const plugin = defineDiagramPlugin({ backend: "opencode", providerID: "reload-fixture", model: "diagram", timeoutMs: 10000, intervalMs: 1000, debounceMs: 100 }, async ctx => {
    const native = await registerNativeAuthor({ ...ctx, session: { ...ctx.session,
      async prompt(input, options) {
        if (revision === 1) {
          held = true
          trace("admission queued:1")
          await reloading
          options.signal.throwIfAborted()
          // Host activation gate is closed during cleanup. Enter with a live
          // signal, then let real engine.dispose abort and drain admission.
          const pending = ctx.session.prompt(input, options)
          trace("admission entered:1")
          entering()
          return pending
        }
        trace("admission entered:" + revision)
        return ctx.session.prompt(input, options)
      },
      async interrupt(input, options) {
        trace("interrupt:" + revision)
        return ctx.session.interrupt(input, options)
      },
    } })
    return { ...native, async generate(input, options) {
      try { return await native.generate(input, options) }
      finally { trace("generation drained:" + revision) }
    } }
  })
  const cleanup = await plugin.setup(ctx)
  return async () => {
    trace("cleanup begin:" + revision)
    if (held) { release(); await entered }
    await cleanup()
    trace("cleanup complete:" + revision)
  }
} }))
`
    await writeFile(entry, source(1))
    await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: ["./plugin"], model: "reload-fixture/primary" }))
    const location = { directory: project }
    const trace = () => readFile(traceFile, "utf8")
    await waitForPlugin(client, location)
    const start = async name => {
      const session = await client.session.create({ location, title: name, model: { providerID: "reload-fixture", id: "primary" } }, { signal: abort.signal })
      await client.session.prompt({ sessionID: session.id, text: `${name}: Map Input -> Processor -> Output architecture.` }, { signal: abort.signal })
      await client.session.wait({ sessionID: session.id }, { signal: abort.signal })
      return session
    }
    const old = await start("RELOAD_OLD")
    await until(async () => (await trace()).includes("admission queued:1"))
    assert.equal(requests.filter(item => item.model === "diagram").length, 0)
    await writeFile(entry, source(2))
    await until(async () => (await trace()).includes("cleanup complete:1"))
    await waitForPlugin(client, location)
    const log = await trace()
    assert.match(log, /cleanup begin:1\nadmission entered:1/)
    assert.ok(log.indexOf("generation drained:1") < log.indexOf("cleanup complete:1"))
    assert.ok(log.indexOf("cleanup complete:1") < log.indexOf("setup:2"))
    const rpc = sessionID => client.rpc.call({ location, rpcID: "open-diagram", method: "get", input: { sessionID } }, { signal: abort.signal })
    assert.equal((await rpc(old.id)).output.sessionID, old.id)
    assert.equal(requests.filter(item => item.model === "diagram").length, 0)
    console.log("OK: real engine cleanup drains pending native prompt admission; reload finishes and folder RPC recovers without provider dispatch")
    const replacement = await start("RELOAD_SUCCESSOR")
    await until(() => successor !== undefined)
    assert.equal((await rpc(replacement.id)).output.phase, "updating")
    assert.equal(successor.record.closed, false)
    successor.finish()
    await until(async () => (await rpc(replacement.id)).output.graph?.title === "Reload successor")
    const complete = await trace()
    assert.equal(complete.slice(complete.indexOf("setup:2")).includes("interrupt:1"), false)
    assert.equal(requests.filter(item => item.model === "diagram").length, 1)
    assert.equal((await client.session.get({ sessionID: replacement.id }, { signal: abort.signal })).model.id, "primary")
    const helpers = (await client.session.list({ location }, { signal: abort.signal })).data.filter(session => session.metadata?.openDiagram === true)
    assert.equal(helpers.length, 1, "replacement reuses managed helper only after old ownership drains")
    console.log("OK: aborted old generation cannot dispatch later or interrupt replacement; same managed helper completes new diagram and primary model stays unchanged")
  })
} finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
