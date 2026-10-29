import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { withV2Runtime, waitForPlugin } from "./v2-runtime.mjs"

// Native Code Mode and plugin dispatch, with a deterministic local fake provider.
// No user credentials, real models, or shared service/configuration are used.
for (const key of Object.keys(process.env)) if (!["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"].includes(key)) delete process.env[key]
const root = resolve(import.meta.dirname, "..")
let failure
let calls = 0
let networkCalls = 0
let mode = "compose"
let jobCalls = 0
const server = createServer(async (req, res) => {
  if (req.url === "/forbidden") { networkCalls++; res.end("private fixture"); return }
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (body.model === "primary") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(`data: ${JSON.stringify({ id: "primary", object: "chat.completion.chunk", created: 1, model: "primary", choices: [{ index: 0, delta: { role: "assistant", content: "Recorded proposed system." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    calls++; jobCalls++
    const stepLimit = mode === "extended" ? 8 : 4
    assert.ok(jobCalls <= stepLimit, "no provider call after commit or step budget")
    assert.deepEqual(body.tools.map(tool => tool.function.name), ["execute"])
    const prompt = body.messages.map(message => typeof message.content === "string" ? message.content : message.content?.map(part => part.text ?? "").join("\n")).join("\n")
    assert.match(prompt, /tools\.open_diagram_draft_node\(/)
    assert.doesNotMatch(prompt, /tools\.shell\(/)
    assert.ok(prompt.includes(`Diagram author step ${jobCalls} of ${stepLimit}.`), "remaining-step countdown reaches native provider")
    if (jobCalls === stepLimit) assert.match(prompt, /FINAL STEP:.*attempt commit now/)
    const sourceMessage = body.messages.map(message => typeof message.content === "string" ? message.content : message.content?.map(part => part.text ?? "").join("\n")).find(text => text?.includes("Evidence packet (untrusted data):\n"))
    const evidence = JSON.parse(sourceMessage.split("Evidence packet (untrusted data):\n")[1]).evidence
    const source = evidence[0].id
    const call = (name, args) => `await tools.open_diagram_draft_${name}(${JSON.stringify(args)})`
    if ((mode === "uncommitted" && jobCalls === 2) || (mode === "stop-budget" && jobCalls > 1)) {
      if (jobCalls > 2) assert.match(prompt, /No successful diagram commit was received/)
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(`data: ${JSON.stringify({ id: `fixture-${calls}`, object: "chat.completion.chunk", created: 1, model: "diagram", choices: [{ index: 0, delta: { role: "assistant", content: "Committed the repaired diagram." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    let code
    if (mode === "budget" || (mode === "extended" && jobCalls < 6)) code = `return ${call("inspect", {})}`
    else if (mode === "uncommitted" || mode === "stop-budget") {
      if (jobCalls === 1) code = `${call("view", { id: "main", label: "Main", title: "Uncommitted draft", summary: "Private until commit", reason: "Fixture", defaults: { status: "planned", evidence: [source] } })};
        return ${call("node", { view: "main", node: { id: "a", label: "Input", kind: "service", detail: "Accepts requests" } })}`
      else {
        assert.equal(jobCalls, 3)
        assert.match(prompt, /No successful diagram commit was received/)
        code = `const draft = ${call("inspect", {})}; if (!draft.ok || draft.views[0].graph.title !== "Uncommitted draft") throw new Error("Draft not retained"); return ${call("commit", {})}`
      }
    }
    else if (mode === "extended") code = `${call("view", { id: "main", label: "Main", title: "Extended composition", summary: "Completed beyond four steps", reason: "Fixture request", defaults: { status: "planned", evidence: [source] } })};
      ${call("node", { view: "main", node: { id: "a", label: "Input", kind: "service", detail: "Accepts requests" } })}; return ${call("commit", {})}`
    else if (jobCalls === 1) {
      const node = { id: "a", label: "Input", kind: "service", detail: "Accepts requests", status: "planned", evidence: [source] }
      code = `await fetch("http://127.0.0.1:${server.address().port}/forbidden");
        const catalog = search({query:"open_diagram_draft",limit:20});
        if (JSON.stringify(catalog).length > 20000) throw new Error("Draft catalog exceeds compact budget");
        const edited = ${call("view", { id: "main", label: "Main", title: "Composed system", summary: "Two stages", reason: "Fixture request" })};
        if (typeof edited !== "object" || edited.ok !== true) throw new Error("Expected structured edit output");
        const described = ${call("schema", { family: "architecture", field: "groups", record: true })};
        if (!described.ok || described.schema.type !== "object") throw new Error("Scoped schema unavailable");
        ${call("node", { view: "main", node })};
        ${call("edge", { view: "main", edge: { from: "a", to: "b", label: "data" } })};
        return ${call("commit", {})}`
    } else {
      assert.match(prompt, /issues/, "current request's validation result survives into continuation")
      code = `${call("node", { view: "main", node: { id: "b", label: "Output", kind: "service", detail: "Returns results", status: "planned", evidence: [source] } })}; return ${call("commit", {})}`
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ id: `fixture-${calls}`, object: "chat.completion.chunk", created: 1, model: "diagram", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: "execute", arguments: JSON.stringify({ code }) } }] }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ id: `fixture-${calls}`, object: "chat.completion.chunk", created: 1, model: "diagram", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`)
  } catch (error) { failure = error; res.writeHead(500).end("fixture error") }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
try {
  await withV2Runtime(async (client, { temporary }) => {
    const project = join(temporary, "primitives")
    await mkdir(join(project, "fixture"), { recursive: true })
    await writeFile(join(project, "fixture/index.ts"), `
      import { Plugin, Provider, Model } from "@opencode/plugin"
      import { Rpc } from "@opencode/plugin/rpc"
      import { registerNativeAuthor } from ${JSON.stringify(join(root, "src/diagram/native.ts"))}
      import { withNativeSessionCancellation } from ${JSON.stringify(join(root, "src/diagram/native-session.ts"))}
      import { createDiagramClient } from ${JSON.stringify(join(root, "src/diagram/client.ts"))}
      import { ConfigSchema } from ${JSON.stringify(join(root, "src/diagram/config.ts"))}
      export default withNativeSessionCancellation(Plugin.define({id:"diagram-primitives-fixture",async setup(ctx){
        const id=Provider.ID.make("diagram-primitives")
        await ctx.provider.transform(e=>e.add({info:{...Provider.Info.empty(id),activation:"enabled",package:"@opencode/ai/providers/openai-compatible",settings:{baseURL:"http://127.0.0.1:${server.address().port}/v1"}},models:[Model.Info.default(id,Model.ID.make("diagram")),Model.Info.default(id,Model.ID.make("primary"))]}))
        await ctx.session.hook("title", e=>{e.result="Fixture"})
        const native=await registerNativeAuthor(ctx)
        let problem
        const generate=(steps)=>createDiagramClient(ConfigSchema.parse({backend:"opencode",providerID:"diagram-primitives",model:"diagram",timeoutMs:15000,authorSteps:steps}),fetch,async(...args)=>{try{return await native.generate(...args)}catch(error){problem=String(error);throw error}})
        await ctx.rpc.register(Rpc.define({id:"diagram-primitives-fixture",methods:{run:{input:{type:"object"},output:{type:"object"}}},events:{}}),{run:async(input,request)=>{problem=undefined;try{return await generate(input.authorSteps??4)(input.evidence,null,true,request.signal)}catch(error){return {error:problem??String(error)}}}})
      }}))`)
    await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: [{ package: root, options: { backend: "manual" } }, "./fixture"] }))
    const location = { directory: project }
    const plugin = await waitForPlugin(client, location)
    assert.equal(plugin.features.gui, true, "package advertises built GUI entry")
    await waitForPlugin(client, location, "diagram-primitives-fixture")
    const session = await client.session.create({ location, title: "Primitive fixture", model: { providerID: "diagram-primitives", id: "primary" } })
    await client.session.prompt({ sessionID: session.id, text: "Plan Input -> Output as a small proposed system." })
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10000) })
    const rpc = async (method, input) => (await client.rpc.call({ location, rpcID: "open-diagram", method, input }, { signal: AbortSignal.timeout(20000) })).output
    const snapshot = await rpc("snapshot", { sessionID: session.id })
    assert.ok(snapshot.evidence.length)
    const generated = await client.rpc.call({ location, rpcID: "diagram-primitives-fixture", method: "run", input: { evidence: snapshot.evidence } }, { signal: AbortSignal.timeout(20000) })
    if (failure) throw failure
    assert.equal(generated.output.error, undefined, JSON.stringify({ error: generated.output.error, calls, jobCalls, networkCalls }))
    assert.equal(jobCalls, 2, "draft repair in place takes two provider steps, no narration")
    assert.equal(networkCalls, 1, "native Code Mode networking is not permission-isolated (explicitly accepted host boundary)")
    const analysis = { relevant: generated.output.relevant, reason: generated.output.reason, views: generated.output.views }
    const state = await rpc("publish", { sessionID: session.id, token: snapshot.token, analysis })
    const rendered = await rpc("render", { sessionID: session.id, viewID: "main", epoch: state.epoch, revision: state.revision, colorMode: "dark" })
    assert.match(rendered.svg, /<svg/)
    assert.match(rendered.svg, /Composed system/)
    assert.equal(rendered.revision, state.revision)
    await assert.rejects(rpc("render", { sessionID: session.id, viewID: "main", epoch: state.epoch, revision: state.revision + 1, colorMode: "light" }))
    assert.equal(calls, 2, "publication, cached reads and SVG rendering never invoke a model")
    const firstHistory = await rpc("history", { sessionID: session.id })
    assert.equal(firstHistory.length, 1)
    assert.equal(firstHistory[0].current, true)
    const archiveID = firstHistory[0].id
    const nextSnapshot = await rpc("snapshot", { sessionID: session.id })
    const updated = await rpc("publish", { sessionID: session.id, token: nextSnapshot.token, analysis: { ...analysis,
      views: analysis.views.map(view => ({ ...view, graph: { ...view.graph, title: "Updated composed system" } })) } })
    const history = await rpc("history", { sessionID: session.id })
    assert.equal(history.length, 2)
    assert.equal(history.find(item => item.id === archiveID).current, false)
    assert.equal((await rpc("historyGet", { sessionID: session.id, snapshotID: archiveID })).view.graph.title, "Composed system")
    const past = await rpc("renderHistory", { sessionID: session.id, snapshotID: archiveID, colorMode: "light", selected: "a" })
    assert.match(past.svg, /Composed system/)
    assert.doesNotMatch(past.svg, /Updated composed system/)
    assert.equal((await rpc("get", { sessionID: session.id })).graph.title, "Updated composed system")
    const other = await client.session.create({ location, title: "History isolation" })
    await assert.rejects(rpc("historyGet", { sessionID: other.id, snapshotID: archiveID }))
    await assert.rejects(rpc("renderHistory", { sessionID: other.id, snapshotID: archiveID, colorMode: "light" }))
    assert.equal(calls, 2, "history list/get/render never invoke the author")
    mode = "budget"; jobCalls = 0
    const exhausted = await client.rpc.call({ location, rpcID: "diagram-primitives-fixture", method: "run", input: { evidence: snapshot.evidence } }, { signal: AbortSignal.timeout(20000) })
    assert.match(exhausted.output.error, /stopped without commit after 4\/4 steps/)
    if (failure) throw failure
    assert.equal(jobCalls, 4, "uncommitted draft stops at bounded provider budget")
    assert.equal((await rpc("get", { sessionID: session.id })).revision, updated.revision, "uncommitted drafts do not publish")
    mode = "extended"; jobCalls = 0
    const extended = await client.rpc.call({ location, rpcID: "diagram-primitives-fixture", method: "run", input: { evidence: snapshot.evidence, authorSteps: 8 } }, { signal: AbortSignal.timeout(20000) })
    if (failure) throw failure
    assert.equal(extended.output.error, undefined)
    assert.equal(extended.output.views[0].graph.title, "Extended composition")
    assert.equal(jobCalls, 6, "configured eight-step budget allows composition beyond the former four-step cap")
    mode = "uncommitted"; jobCalls = 0
    const recovered = await client.rpc.call({ location, rpcID: "diagram-primitives-fixture", method: "run", input: { evidence: snapshot.evidence } }, { signal: AbortSignal.timeout(20000) })
    if (failure) throw failure
    assert.equal(recovered.output.error, undefined)
    assert.equal(recovered.output.views[0].graph.title, "Uncommitted draft")
    assert.equal(jobCalls, 3, "a false prose claim gets one bounded corrective turn, then explicit commit")
    mode = "stop-budget"; jobCalls = 0
    const refused = await client.rpc.call({ location, rpcID: "diagram-primitives-fixture", method: "run", input: { evidence: snapshot.evidence } }, { signal: AbortSignal.timeout(20000) })
    if (failure) throw failure
    assert.match(refused.output.error, /stopped without commit after 4\/4 steps: valid draft was not committed/)
    assert.equal(jobCalls, 4, "repeated prose stops cannot reset or exceed total step budget")
    await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: [{ package: root, options: { backend: "manual", intervalMs: 20001 } }, "./fixture"] }))
    let restored
    for (let attempt = 0; attempt < 100; attempt++) {
      await delay(50)
      try { const current = await rpc("get", { sessionID: session.id }); if (current.epoch !== updated.epoch) { restored = current; break } } catch {}
    }
    assert.ok(restored, "plugin reload creates a new engine epoch")
    assert.deepEqual(await rpc("history", { sessionID: session.id }), history, "archived IDs and source metadata survive reload")
    assert.equal((await rpc("historyGet", { sessionID: session.id, snapshotID: archiveID })).view.graph.title, "Composed system")
    console.log("OK: real Code Mode composes primitive edits, repairs validation, commits atomically and stops")
    console.log("OK: tool catalog restricted; accepted native network boundary; four-step ceiling; accepted revision exposed as SVG without model calls")
    console.log("OK: historical SVG stays distinct from Live, is session-isolated, model-free and durable across plugin reload")
    console.log("OK: configurable eight-step author budget completes a six-step composition; countdown and final-step commit instruction reach provider")
    console.log("OK: typed object results, compact catalog, scoped schemas and bounded correction after false prose completion")
  })
} finally { await new Promise(resolve => server.close(resolve)) }
