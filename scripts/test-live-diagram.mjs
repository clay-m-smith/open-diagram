import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { withV2Runtime, waitForPlugin } from "./v2-runtime.mjs"
import { bindDiagramMonitor, createDiagramMonitor } from "../src/diagram/tui.tsx"
import { DiagramRpc } from "../src/diagram/schema.ts"
import { mapDiagramEvidence } from "../src/diagram/notation.ts"
import { notationFixtures } from "../tests/fixtures/notations.ts"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

// Private fixture service + private OpenCode runtime. No real models or credentials.
for (const key of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"].includes(key)) delete process.env[key]
}
const root = resolve(import.meta.dirname, "..")
let project
let failure
let diagramRequests = 0
let invalidDiagram = false
let captionRepairs = 0
const observed = []
const server = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(request.url, "/v1/chat/completions")
    if (body.model === "diagram-fixture") {
      diagramRequests++
      assert.equal(body.stream, true, "native generate.text uses streaming provider transport")
      assert.ok(diagramRequests <= 12, "bounded diagram requests")
      assert.deepEqual(body.tools.map(tool => tool.function.name), ["open_diagram_result"])
      const prompt = body.messages.map((message) => typeof message.content === "string" ? message.content : message.content?.map((part) => part.text ?? "").join("\n")).join("\n")
      const packet = JSON.parse(prompt.split("Evidence packet (untrusted data):\n").at(-1).split("\n\nAuthoring reminder:")[0])
      const submit = (value) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(`data: ${JSON.stringify({ id: "diagram", object: "chat.completion.chunk", created: 1, model: "diagram-fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "result", type: "function", function: { name: "open_diagram_result", arguments: JSON.stringify(value) } }] }, finish_reason: null }] })}\n\n`)
        response.end(`data: ${JSON.stringify({ id: "diagram", object: "chat.completion.chunk", created: 1, model: "diagram-fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`)
      }
      if (packet.fields) {
        if (invalidDiagram) {
          assert.ok(packet.fields.every(field => field.path.at(-1) === "evidence"), "invalid-citation fixture uses narrow citation fields")
          submit(Object.fromEntries(packet.fields.map(field => [field.field, ["missing_source"]])))
          return
        }
        assert.equal(packet.fields.length, 1)
        assert.deepEqual(packet.fields[0].path, ["views", 0, "label"])
        assert.equal(packet.fields[0].original.length, 25)
        assert.equal(packet.evidence.length, 0, "caption repair does not resend source or graph content")
        captionRepairs++
        submit({ f0: "Encoder internals" })
        return
      }
      assert.match(prompt, /No repeated title, detail, provenance or progress narrative/)
      const code = [...packet.evidence].reverse().find((item) => item.category === "source" && item.text.includes("nn.Embedding"))
      const source = code ?? packet.evidence.find((item) => item.category === "source" && item.text.includes("nn.Linear")) ?? packet.evidence.at(-1)
      const training = packet.evidence.find((item) => item.text.includes("batch_size = 16"))
      const graph = { title: code ? "Embedding classifier" : "Image classifier", summary: "Observed model pipeline", nodes: [
        { id: "input", label: "Input", kind: "input", detail: "Batch", status: "observed", evidence: [source.id] },
        { id: "encoder", label: code ? "Embedding" : "Linear", kind: "model", detail: "Encoder layer",
          behavior: code ? "Maps token indices to learned eight-dimensional feature vectors." : "Projects 32 input features into eight learned output features.", status: "observed", evidence: [source.id] },
      ], edges: [{ from: "input", to: "encoder", label: "features" }] }
      const granular = packet.granularity === "granular"
      const vocabulary = code?.text.includes("nn.Embedding(64") ? 64 : 32
      if (granular) {
        assert.match(prompt, /Expand configured stages individually/)
        assert.ok(code?.text.includes("nn.GELU"), "activation exists in observed implementation")
        graph.title = "Encoder layers"
        graph.nodes[1].label = `Embedding ${vocabulary} × 8`
        graph.nodes[1].detail = `vocab=${vocabulary}, width=8`
        graph.nodes.push({ id: "gelu", label: "GELU", kind: "activation", detail: "Elementwise activation", behavior: "Transforms each embedded feature with the GELU nonlinearity.", status: "observed", evidence: [source.id] })
        graph.edges.push({ from: "encoder", to: "gelu", label: "8 features" })
      }
      if (invalidDiagram) for (const node of graph.nodes) node.evidence = ["missing_source"]
      observed.push(packet)
      const allViews = [
        { id: granular ? "layers" : "model", label: granular ? "Layers" : "Model", graph },
        { id: "repository", label: "Files", graph: { ...graph, title: "Repository", nodes: [{ ...graph.nodes[0], id: "file", label: "train.py", kind: "file", evidence: [training?.id ?? source.id] }], edges: [] } },
      ]
      if (packet.update && !packet.update.replaceAll) {
        assert.deepEqual(packet.update.views.map((view) => view.id), [granular ? "layers" : "model"])
        assert.equal(training, undefined, "unchanged training source excluded from incremental packet")
      }
      const content = packet.update && prompt.includes("Native incremental output")
        ? { reason: "Model architecture", updates: packet.update.views.map(view => {
          const next = allViews.find(item => item.id === view.id)
          assert.ok(next)
          return { id: next.id, ...(granular && vocabulary === 64 && !invalidDiagram && next.id === "layers" ? { label: "x".repeat(25) } : {}),
            graph: packet.update.replaceAll ? next.graph : { title: graph.title, nodes: ["input", ...graph.nodes.slice(1)], edges: graph.edges } }
        }) }
        : { relevant: true, reason: "Model architecture", views: packet.update
          ? allViews.filter((view) => packet.update.views.some((selected) => selected.id === view.id)) : allViews }
      submit(content)
      return
    }
    assert.equal(body.model, "primary-fixture")
    const userIndex = body.messages.findLastIndex((item) => item.role === "user")
    const user = JSON.stringify(body.messages[userIndex])
    const hasTool = body.messages.slice(userIndex + 1).some((item) => item.role === "tool")
    let delta = { content: "Model change inspected." }
    let finish = "stop"
    if (!hasTool && !user.includes("CHAT_ONLY")) {
      const vocabularyEdit = user.includes("CHANGE_VOCAB")
      const edit = user.includes("UPDATE_MODEL") || vocabularyEdit
      const tool = body.tools.find((tool) => tool.function.name === (edit ? "edit" : "read"))
      assert.ok(tool, `native ${edit ? "edit" : "read"} tool available; got ${body.tools.map((tool) => tool.function.name).join(", ")}`)
      const fields = tool.function.parameters.properties
      if (edit) assert.ok(fields.oldString && fields.newString && fields.path, JSON.stringify(tool.function.parameters))
      const args = edit ? { path: join(project, "model.py"),
        oldString: vocabularyEdit ? "encoder = nn.Embedding(32, 8)\nactivation = nn.GELU()" : "encoder = nn.Linear(32, 8)",
        newString: `encoder = nn.Embedding(${vocabularyEdit ? 64 : 32}, 8)\nactivation = nn.GELU()` } : { path: join(project, "model.py") }
      delta = { tool_calls: [{ index: 0, id: edit ? "call_edit" : "call_read", type: "function", function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }
      if (!edit) delta.tool_calls.push({ index: 1, id: "call_train", type: "function", function: { name: tool.function.name, arguments: JSON.stringify({ path: join(project, "train.py") }) } })
      finish = "tool_calls"
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const item of [{ role: "assistant" }, delta]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "primary-fixture", choices: [{ index: 0, delta: item, finish_reason: null }] })}\n\n`)
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "primary-fixture", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`)
  } catch (error) { failure = error; response.writeHead(500).end("fixture error") }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`
const abort = new AbortController()
const deadline = setTimeout(() => abort.abort(new Error("Live diagram runtime deadline")), 50_000)
try {
  await withV2Runtime(async (client, { temporary, endpoint }) => {
    project = join(temporary, "project")
    await mkdir(join(project, "fixture"), { recursive: true })
    await writeFile(join(project, "model.py"), "from torch import nn\nencoder = nn.Linear(32, 8)\n")
    await writeFile(join(project, "train.py"), "batch_size = 16\nobjective = 'squared_error'\n")
    await writeFile(join(project, "fixture/index.ts"), `
import { Plugin, Provider, Model } from ${JSON.stringify(import.meta.resolve("@opencode/plugin"))}
export default Plugin.define({ id: "open-diagram-fixture", async setup(ctx) {
  const id = Provider.ID.make("open-diagram-fixture")
  await ctx.provider.transform(editor => editor.add({
    info: { ...Provider.Info.empty(id), activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: ${JSON.stringify(baseURL)} } },
    models: [Model.Info.default(id, Model.ID.make("primary-fixture")), Model.Info.default(id, Model.ID.make("diagram-fixture"))],
  }))
  await ctx.session.hook("title", event => { event.result = "Diagram fixture" })
  await ctx.session.hook("retry", event => { event.decision = { retry: false } })
} })
`)
    await writeFile(join(project, "opencode.json"), JSON.stringify({
      plugins: [{ package: root, options: { backend: "opencode", providerID: "open-diagram-fixture", model: "diagram-fixture", intervalMs: 1000, debounceMs: 100 } }, "./fixture"],
      model: "open-diagram-fixture/primary-fixture",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    }))
    const location = { directory: project }
    const plugin = await waitForPlugin(client, location, "open-diagram-server")
    assert.equal(plugin.features.tui, true, "standalone package advertises TUI entry")
    const events = []
    const lifecycle = new Map()
    const waiters = new Set()
    const wait = (predicate) => new Promise((resolve, reject) => {
      const clean = () => { waiters.delete(check); abort.signal.removeEventListener("abort", cancelled) }
      const check = () => {
        if (failure) { clean(); reject(failure) }
        else if (predicate()) { clean(); resolve() }
      }
      const cancelled = () => {
        console.error(JSON.stringify({ diagramRequests, lastDiagram: events.findLast((event) => event.type === "rpc.open-diagram.updated")?.data,
          executions: events.filter((event) => /session.execution\.(succeeded|failed)/.test(event.type)).map((event) => event.type) }))
        clean(); reject(abort.signal.reason)
      }
      waiters.add(check)
      abort.signal.addEventListener("abort", cancelled, { once: true })
      if (abort.signal.aborted) cancelled(); else check()
    })
    const stream = (async () => {
      for await (const event of client.event.subscribe({ signal: abort.signal })) {
        events.push(event)
        lifecycle.get(event.type)?.(event)
        for (const check of [...waiters]) check()
      }
    })()
    stream.catch(() => {})
    let monitorReads = 0
    const nativeRpc = client.rpc(DiagramRpc)
    const monitor = createDiagramMonitor({ ...nativeRpc, get: (...args) => { monitorReads++; return nativeRpc.get(...args) } })
    const unbind = bindDiagramMonitor(monitor, { on: (type, handler) => {
      lifecycle.set(type, handler)
      return () => lifecycle.delete(type)
    } })
    try {
      await wait(() => events.some((event) => event.type === "server.connected"))
      const session = await client.session.create({ location, title: "Classifier", model: { providerID: "open-diagram-fixture", id: "primary-fixture" } })
      monitor.select(session)
      const rpc = async (method, input) => (await client.rpc.call({ location, rpcID: "open-diagram", method, input }, { signal: abort.signal })).output
      assert.equal((await rpc("get", { sessionID: session.id })).phase, "watching")
      await client.session.prompt({ sessionID: session.id, text: "INITIAL_MODEL: inspect the PyTorch neural classifier architecture in model.py for this training pipeline." }, { signal: abort.signal })
      // Initial prompt/read hooks may publish an interim request-only graph.
      // Incremental proof requires an accepted baseline with BOTH actual file
      // dependencies, not merely the fixture's common title.
      await wait(() => events.some((event) => {
        if (event.type !== "rpc.open-diagram.updated" || event.data.phase !== "ready" || event.data.stale) return false
        const state = event.data
        const cites = (view, file) => view?.graph.nodes.some((node) => node.evidence.some((id) => state.sources.some((item) => item.id === id && item.label.includes(file))))
        return state.graph?.title === "Image classifier" && cites(state.views[0], "model.py") && cites(state.views[1], "train.py")
      }))
      await wait(() => events.some((event) => event.type === "session.execution.succeeded" && event.data.sessionID === session.id))
      const first = await rpc("get", { sessionID: session.id })
      assert.equal(first.graph.title, "Image classifier")
      assert.match(first.graph.nodes[1].behavior, /Projects 32 input features/)
      await monitor.refresh()
      assert.equal(monitor.state().graph.title, "Image classifier", "production TUI monitor reads actual server snapshot")
      const count = events.filter((event) => event.type === "session.execution.succeeded" && event.data.sessionID === session.id).length
      await client.session.prompt({ sessionID: session.id, text: "UPDATE_MODEL: change the encoder in model.py to nn.Embedding(32, 8) followed by nn.GELU(). Keep the classifier model training pipeline." }, { signal: abort.signal })
      await wait(() => events.filter((event) => event.type === "session.execution.succeeded" && event.data.sessionID === session.id).length > count)
      await wait(() => events.some((event) => event.type === "rpc.open-diagram.updated" && event.data.graph?.title === "Embedding classifier"))
      assert.match(await readFile(join(project, "model.py"), "utf8"), /encoder = nn.Embedding/)
      const updated = await rpc("get", { sessionID: session.id })
      assert.ok(updated.revision > first.revision)
      assert.equal(updated.graph.nodes[1].label, "Embedding")
      await monitor.refresh()
      assert.equal(monitor.state().graph.nodes[1].label, "Embedding", "actual hook outcome reaches production TUI state")
      assert.ok(observed.some((packet) => packet.evidence.some((item) => item.label.startsWith("edit") && item.text.includes("nn.Embedding"))), "native edit evidence reaches diagram model")
      assert.ok(observed.some((packet) => packet.update), "native generation receives targeted incremental packet")
      assert.deepEqual(updated.views[1], first.views[1], "native update preserves unrelated view byte-for-byte")
      console.log("OK: native source edit authors only dependent view with reduced evidence and preserves unrelated view")
      assert.equal((await client.session.get({ sessionID: session.id })).model.id, "primary-fixture", "diagram never reroutes main model")
      await new Promise((resolve, reject) => {
        execFile("python3", [join(root, "scripts/test-diagram-host.py"), project, session.id], { timeout: 25_000 }, (error, stdout, stderr) => {
          if (error) reject(new Error(`${error}\n${stderr}`))
          else { console.log(stdout.trim()); resolve() }
        })
      })
      const granular = await rpc("get", { sessionID: session.id })
      assert.equal(granular.granularity, "granular")
      assert.equal(granular.graph.nodes[1].detail, "vocab=32, width=8")
      assert.equal(granular.graph.nodes[2].label, "GELU")
      const exportCalls = diagramRequests
      await new Promise((resolve, reject) => {
        execFile("python3", [join(root, "scripts/test-diagram-export-host.py"), project, session.id], { timeout: 25_000 }, (error, stdout, stderr) => {
          if (error) reject(new Error(`${error}\n${stderr}`))
          else { console.log(stdout.trim()); resolve() }
        })
      })
      assert.equal(diagramRequests, exportCalls, "copy/save never collects or invokes a diagram model")
      console.log("OK: native PNG/SVG/Save exports cached view with zero diagram-model calls")
      await monitor.refresh()
      const cachedReads = monitorReads
      const cachedRequests = diagramRequests
      monitor.select(undefined)
      monitor.select(session)
      assert.equal(monitor.state().graph.nodes[2].label, "GELU", "session revisit renders cache synchronously")
      // Longer than the removed 15-second interval. Test observation only: no
      // application RPCs or event polling during this quiet window.
      await new Promise((resolve) => setTimeout(resolve, 16_000))
      assert.equal(monitorReads, cachedReads, "idle time and cached revisit issue no snapshot reads")
      assert.equal(diagramRequests, cachedRequests, "cached viewing never invokes the model")
      // A fresh native event connection supplies the real server.connected
      // envelope to the same public binding used by ctx.data.on in the TUI.
      // This tests connection-event recovery, not a physical host network outage.
      const connection = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
      for await (const event of connection.event.subscribe({ signal: abort.signal })) {
        if (event.type !== "server.connected") continue
        lifecycle.get(event.type)?.(event)
        break
      }
      assert.equal(await monitor.ensure(), true)
      assert.equal(monitorReads, cachedReads + 1, "one scoped read on reconnect")
      assert.equal(diagramRequests, cachedRequests, "reconnect GET cannot collect or regenerate")
      console.log("OK: native cache serves session revisits and 16 idle seconds without RPC/model calls; reconnect reads once")
      const memoCalls = diagramRequests
      await rpc("control", { sessionID: session.id, refresh: true })
      await new Promise((resolve) => setTimeout(resolve, 1400))
      assert.equal(diagramRequests, memoCalls, "Refresh after reload reuses accepted content fingerprint")
      assert.equal((await rpc("get", { sessionID: session.id })).updatedAt, granular.updatedAt)
      await rpc("control", { sessionID: session.id, granularity: "overview" })
      await new Promise((resolve) => setTimeout(resolve, 350))
      assert.equal((await rpc("get", { sessionID: session.id })).graph.nodes[1].label, "Embedding")
      await rpc("control", { sessionID: session.id, granularity: "granular" })
      await new Promise((resolve) => setTimeout(resolve, 1400))
      assert.equal((await rpc("get", { sessionID: session.id })).graph.nodes[2].label, "GELU")
      assert.equal(diagramRequests, memoCalls, "both accepted depths survive reload with zero regeneration")
      console.log("OK: native durable fingerprints make unchanged Refresh and cached depth switches zero-model operations")
      const completedBeforeChat = events.filter((event) => event.type === "session.execution.succeeded" && event.data.sessionID === session.id).length
      await client.session.prompt({ sessionID: session.id, text: "CHAT_ONLY: thanks, keep tracking the current implementation." }, { signal: abort.signal })
      await wait(() => events.filter((event) => event.type === "session.execution.succeeded" && event.data.sessionID === session.id).length > completedBeforeChat)
      await new Promise((resolve) => setTimeout(resolve, 1400))
      assert.equal(diagramRequests, memoCalls, "main-window chat without source change does not invoke diagram model")
      console.log("OK: main-agent chat and progress cause zero diagram-model calls")
      invalidDiagram = true
      await client.session.prompt({ sessionID: session.id, text: "CHANGE_VOCAB: change the model vocabulary to 64; retain its existing layers." }, { signal: abort.signal })
      await wait(() => events.some((event) => event.type === "rpc.open-diagram.updated" && event.data.sessionID === session.id && event.data.updateError))
      const failedUpdate = await rpc("get", { sessionID: session.id })
      assert.equal(failedUpdate.phase, "ready")
      assert.deepEqual(failedUpdate.views, granular.views, "invalid update never replaces last-good views")
      assert.equal(failedUpdate.updatedAt, granular.updatedAt)
      assert.ok(failedUpdate.updateError)
      await new Promise((resolve, reject) => {
        execFile("python3", [join(root, "scripts/test-diagram-host.py"), project, session.id, "failure"], { timeout: 15_000 }, (error, stdout, stderr) => {
          if (error) reject(new Error(`${error}\n${stderr}`))
          else { console.log(stdout.trim()); resolve() }
        })
      })
      invalidDiagram = false
      await rpc("control", { sessionID: session.id, refresh: true })
      await wait(() => events.some((event) => event.type === "rpc.open-diagram.updated" && event.data.sessionID === session.id && event.data.updatedAt > granular.updatedAt && !event.data.updateError && event.data.phase === "ready"))
      console.log("OK: native failed update preserves ready cached views; explicit changed-input retry recovers")
      const authorCalls = diagramRequests
      const snapshot = await rpc("snapshot", { sessionID: session.id })
      assert.ok(snapshot.instruction.includes("Any domain"))
      assert.equal(snapshot.granularity, "granular")
      const current = await rpc("get", { sessionID: session.id })
      assert.equal(current.views.find(view => view.id === "layers").label, "Encoder internals", "native incremental caption correction reaches RPC without changing view ID")
      assert.equal(captionRepairs, 1, "stock native tool admits the invalid caption for exactly one bounded field repair")
      const external = { relevant: true, reason: "External model publication", views: current.views.map((view) => ({ ...view,
        graph: { ...view.graph, nodes: view.graph.nodes.map((node) => ({ ...node, evidence: [snapshot.evidence[0].id] })) },
      })) }
      const submitted = await rpc("publish", { sessionID: session.id, token: snapshot.token, analysis: external })
      assert.equal(submitted.views.length, 2)
      assert.equal(submitted.phase, "ready")
      await new Promise((resolve) => setTimeout(resolve, 1400))
      assert.equal(diagramRequests, authorCalls, "auto-enabled snapshot/publication does not initiate duplicate authoring")
      console.log("OK: auto-enabled main-agent snapshot/publication adds zero secondary model calls")
      await assert.rejects(rpc("publish", { sessionID: session.id, token: snapshot.token, analysis: external }), "token cannot overwrite another accepted publication")
      console.log("OK: public snapshot -> external views -> validated publish -> stale token rejected")
      assert.equal((await rpc("control", { sessionID: session.id, mode: "off" })).phase, "paused")
      const hardwareSnapshot = await rpc("snapshot", { sessionID: session.id })
      assert.ok(hardwareSnapshot.evidence.length)
      const hardwareViews = ["circuit", "sequence", "timing", "architecture"].map((family) => ({
        id: family, label: family, graph: mapDiagramEvidence(notationFixtures[family], () => [hardwareSnapshot.evidence[0].id]),
      }))
      const hardware = await rpc("publish", { sessionID: session.id, token: hardwareSnapshot.token,
        analysis: { relevant: true, reason: "Synthetic hardware representation fixture", views: hardwareViews } })
      assert.deepEqual(hardware.views, hardwareViews, "actual native RPC validates and exposes notation payloads")
      assert.deepEqual((await rpc("get", { sessionID: session.id })).views, hardwareViews)
      assert.equal(diagramRequests, authorCalls, "manual notation publication is zero-call")
      const beforeReload = await rpc("get", { sessionID: session.id })
      const configPath = join(project, "opencode.json")
      const nextConfig = JSON.parse(await readFile(configPath, "utf8"))
      nextConfig.plugins[0].options.intervalMs = 1001
      await writeFile(configPath, JSON.stringify(nextConfig))
      let restored
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        try {
          const current = await rpc("get", { sessionID: session.id })
          if (current.epoch !== beforeReload.epoch) { restored = current; break }
        } catch { /* Registry replacement temporarily removes the old RPC. */ }
      }
      assert.ok(restored, "configuration change instantiates a new server engine epoch")
      assert.equal(restored.mode, "off")
      assert.equal(restored.granularity, "granular", "depth preference persists independently of pause")
      assert.equal(restored.phase, "paused")
      assert.equal(restored.stale, true)
      assert.deepEqual(restored.graph, beforeReload.graph, "native plugin storage restores exact graph")
      assert.deepEqual(restored.views, beforeReload.views, "all view tabs persist")
      assert.deepEqual(restored.views, hardwareViews, "specialized views survive native plugin storage/reload")
      assert.deepEqual(restored.sources, beforeReload.sources)
      assert.equal(restored.updatedAt, beforeReload.updatedAt)
      // Native plugin.updated flows through the very same public-event binding
      // installed by TUI setup. No manual monitor refresh may hide broken wiring.
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(monitor.state().epoch, restored.epoch, "native plugin.updated automatically reconciles production monitor")
      assert.equal(monitor.state().mode, "off")
      console.log("OK: native storage restored graph and paused mode across plugin reload; TUI accepted new epoch")
      const other = await client.session.create({ location, title: "Unrelated" })
      assert.equal((await rpc("get", { sessionID: other.id })).graph, null, "no cross-session graph reuse")
      const elsewhere = join(temporary, "elsewhere")
      await mkdir(elsewhere)
      const foreign = await client.session.create({ location: { directory: elsewhere } })
      await assert.rejects(rpc("get", { sessionID: foreign.id }), "foreign location rejected")
      console.log("OK: V2 separate plugin loads -> prompt/read/edit hooks -> local model request -> validated graph -> RPC events/get -> changed architecture; primary routing preserved; pause and location isolation")
    } finally { unbind(); monitor.dispose(); abort.abort(); await stream.catch(() => {}) }
  })
} finally {
  clearTimeout(deadline)
  abort.abort()
  await new Promise((resolve) => server.close(resolve))
}
