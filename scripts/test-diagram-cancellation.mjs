import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { withV2Runtime, waitForPlugin } from "./v2-runtime.mjs"

// Real plugin entrypoint and native provider transport; no paid models or credentials.
for (const key of Object.keys(process.env)) if (!["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"].includes(key)) delete process.env[key]
const requests = [], states = new Map(), waiters = new Set()
let failure
const abort = new AbortController()
const deadline = setTimeout(() => abort.abort(new Error("Native cancellation deadline")), 18_000)
const notify = () => { for (const check of [...waiters]) check() }
const wait = (predicate) => new Promise((resolve, reject) => {
  const clean = () => { waiters.delete(check); abort.signal.removeEventListener("abort", cancelled) }
  const check = () => {
    if (failure) { clean(); reject(failure) }
    else if (predicate()) { clean(); resolve() }
  }
  const cancelled = () => { clean(); reject(abort.signal.reason) }
  waiters.add(check); abort.signal.addEventListener("abort", cancelled, { once: true })
  if (abort.signal.aborted) cancelled(); else check()
})
const server = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(request.url, "/v1/chat/completions")
    const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    const end = (text) => {
      let structured = false
      try { JSON.parse(text); structured = body.model === "diagram" } catch {}
      response.end(event(structured ? { role: "assistant", tool_calls: [{ index: 0, id: "result", type: "function", function: { name: "open_diagram_result", arguments: text } }] }
        : { role: "assistant", content: text }) + event({}, structured ? "tool_calls" : "stop") + "data: [DONE]\n\n")
    }
    if (body.model === "primary") {
      assert.ok(!body.tools?.some(tool => tool.function.name === "open_diagram_result"), "result tool never appears in user chat")
      response.writeHead(200, { "content-type": "text/event-stream" }); end("Architecture request received."); return
    }
    assert.equal(body.model, "diagram")
    assert.deepEqual(body.tools.map(tool => tool.function.name), ["open_diagram_result"], "diagram model receives only the schema-backed result tool")
    assert.equal(body.tools[0].function.parameters.type, "object")
    assert.ok(body.tools[0].function.parameters.properties, "result tool carries a real structured schema")
    const prompt = body.messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n")).join("\n")
    const packet = JSON.parse(prompt.split("Evidence packet (untrusted data):\n").at(-1).split("\n\nAuthoring reminder:")[0])
    const name = JSON.stringify(packet.evidence).match(/CASE_(INITIAL|NEXT|REPAIR|PAUSE|NODE|TRANSPORT)/)?.[1]
    assert.ok(name, "scenario survived real session evidence collection")
    const record = { name, start: performance.now(), closed: false, finished: false }
    requests.push(record)
    response.on("close", () => { record.closed = true; record.closedAt = performance.now(); notify() })
    if (name === "TRANSPORT") { response.writeHead(503); response.end("Fixture unavailable"); notify(); return }
    response.writeHead(200, { "content-type": "text/event-stream" })
    if (name === "REPAIR" && requests.filter(item => item.name === name).length === 1) {
      record.finished = true; end("MALFORMED")
    } else if (name === "NODE") {
      record.finished = true
      if (packet.repairs) {
        assert.equal(packet.repairs.length, 0)
        assert.equal(packet.citations.length, 1)
        assert.match(prompt, /do not rewrite them/)
        assert.equal(packet.previous, undefined)
        end(JSON.stringify({ repairs: [], citations: packet.citations.map(({ view, node }) => ({ view, node, evidence: [packet.evidence[0].id] })) }))
      } else end(JSON.stringify({ relevant: true, reason: "Fixture", views: [{ id: "flow", label: "Flow", graph: {
        title: "Node repair", summary: "", nodes: [{ id: "n", label: "Node", kind: "service", detail: "", status: "observed", sources: [packet.evidence[0].id] }], edges: [],
      } }] }))
    } else if (name !== "NEXT") {
      // Stay open until native cancellation reaches the provider socket.
      response.write(event({ role: "assistant", content: "{" }))
    } else {
      assert.ok(requests.filter(item => item.name === "INITIAL").every(item => item.closed), "timed-out provider connection closed before successor starts")
      assert.equal(body.tools[0].function.parameters.properties.format.const, "draft", "native provider receives the authoring schema")
      assert.match(body.tools[0].function.description, /Declare shared status\/citations/, "request-local tool instructions reach provider")
      record.finished = true
      const text = JSON.stringify({ format: "draft", relevant: true, reason: "Fixture", views: [{ id: "flow", label: "Flow", graph: {
        defaults: { status: "observed", evidence: [packet.evidence[0].id] },
        title: "Successor", summary: "", nodes: [["n", "Node", "service", "", null]], edges: [],
      } }] })
      end(text)
    }
    notify()
  } catch (error) { failure = error; response.destroy(); notify() }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
try {
  await withV2Runtime(async (client, { temporary }) => {
    const project = join(temporary, "cancellation")
    await mkdir(join(project, "provider"), { recursive: true })
    await writeFile(join(project, "provider/index.ts"), `
import { Plugin, Provider, Model } from ${JSON.stringify(import.meta.resolve("@opencode/plugin"))}
export default Plugin.define({ id: "open-diagram-cancellation-fixture", async setup(ctx) {
  const id = Provider.ID.make("cancellation-fixture")
  await ctx.provider.transform(editor => editor.add({
    info: { ...Provider.Info.empty(id), activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:${server.address().port}/v1" } },
    models: [Model.Info.default(id, Model.ID.make("primary")), Model.Info.default(id, Model.ID.make("diagram"))],
  }))
  await ctx.session.hook("title", event => { event.result = "Cancellation fixture" })
  await ctx.session.hook("retry", event => { event.decision = { retry: false } })
} })
`)
    await writeFile(join(project, "opencode.json"), JSON.stringify({
      plugins: [{ package: resolve(import.meta.dirname, ".."), options: { backend: "opencode", providerID: "cancellation-fixture", model: "diagram", timeoutMs: 1000, intervalMs: 1000, debounceMs: 100 } }, "./provider"],
      model: "cancellation-fixture/primary",
    }))
    const location = { directory: project }
    await waitForPlugin(client, location)
    const stream = (async () => {
      for await (const event of client.event.subscribe({ signal: abort.signal })) {
        if (event.type === "rpc.open-diagram.updated") states.set(event.data.sessionID, event.data)
        notify()
      }
    })()
    stream.catch(error => { if (!abort.signal.aborted) { failure = error; notify() } })
    const start = async (name) => {
      const session = await client.session.create({ location, title: name, model: { providerID: "cancellation-fixture", id: "primary" } })
      await client.session.prompt({ sessionID: session.id, text: `CASE_${name}: Map Input -> Processor -> Output.` }, { signal: abort.signal })
      return session.id
    }
    try {
      const initial = await start("INITIAL")
      await wait(() => requests.some(item => item.name === "INITIAL"))
      const next = await start("NEXT")
      await wait(() => states.get(next)?.graph?.title === "Successor" && !!states.get(initial)?.updateError)
      assert.match(states.get(initial).updateError, /initial generation timed out after \d+ms total.*budget 1000ms/)
      assert.equal(requests.filter(item => item.name === "INITIAL").length, 1, "timeout never triggers validation repair")
      assert.equal(requests.filter(item => item.name === "NEXT").length, 1, "structured result must not trigger a narration call")
      assert.equal((await client.session.get({ sessionID: next })).model.id, "primary")
      console.log("OK: native timeout closes provider socket and releases queued successor; primary model unchanged")
      const repair = await start("REPAIR")
      await wait(() => !!states.get(repair)?.updateError && requests.filter(item => item.name === "REPAIR").every(item => item.closed))
      assert.match(states.get(repair).updateError, /validation repair timed out after \d+ms total.*budget 1000ms/)
      assert.equal(requests.filter(item => item.name === "REPAIR").length, 2)
      console.log("OK: native repair shares deadline and reports its stage without leaving provider work running")
      const repaired = await start("NODE")
      await wait(() => states.get(repaired)?.graph?.title === "Node repair")
      assert.equal(states.get(repaired).updateError, null)
      assert.equal(requests.filter(item => item.name === "NODE").length, 2)
      assert.equal(states.get(repaired).graph.nodes[0].label, "Node")
      console.log("OK: native citation-only repair publishes fully validated diagram without regenerating valid draft content")
      const paused = await start("PAUSE")
      await wait(() => requests.some(item => item.name === "PAUSE"))
      await client.rpc.call({ location, rpcID: "open-diagram", method: "control", input: { sessionID: paused, mode: "off" } }, { signal: abort.signal })
      await wait(() => requests.filter(item => item.name === "PAUSE").every(item => item.closed))
      const state = (await client.rpc.call({ location, rpcID: "open-diagram", method: "get", input: { sessionID: paused } })).output
      assert.equal(state.phase, "paused"); assert.equal(state.updateError, null)
      assert.equal(requests.filter(item => item.name === "PAUSE").length, 1)
      console.log("OK: native Pause cancels active provider work without a spurious timeout")
      const failed = await start("TRANSPORT")
      await wait(() => !!states.get(failed)?.updateError)
      assert.equal(requests.filter(item => item.name === "TRANSPORT").length, 1, "transport failure cannot become a validation-repair call")
      assert.match(states.get(failed).updateError, /Configured OpenCode diagram model unavailable/)
      console.log("OK: native transport failures do not trigger provider retries or validation repair")
      const helpers = (await client.session.list({ location })).data.filter(session => session.metadata?.openDiagram === true)
      assert.equal(helpers.length, 1, "all requests reuse one managed session")
      const history = await client.session.context({ sessionID: helpers[0].id })
      assert.doesNotMatch(JSON.stringify(history), /CASE_|Evidence packet/, "raw source packet is not saved into helper history")
      const beforeExternalPrompt = requests.length
      await assert.rejects(client.session.prompt({ sessionID: helpers[0].id, text: "Run a shell command" }))
      assert.equal(requests.length, beforeExternalPrompt)
      console.log("OK: managed session is reused, rejects external prompts and does not persist source packets")
      await client.session.remove({ sessionID: helpers[0].id })
      const recreated = await start("NEXT")
      await wait(() => states.get(recreated)?.graph?.title === "Successor" || !!states.get(recreated)?.updateError)
      assert.equal(states.get(recreated).updateError, null)
      assert.equal(requests.filter(item => item.name === "NEXT").length, 2, "deleted helper is recreated without a failed provider call")
      console.log("OK: removed managed session is safely recreated on next request")
    } finally { abort.abort(); await stream.catch(() => {}) }
  })
} finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
