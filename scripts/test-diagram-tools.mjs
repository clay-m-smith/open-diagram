import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { withV2Runtime, waitForPlugin } from "./v2-runtime.mjs"

// Entirely isolated host, credentials and provider. Exercises native tool dispatch.
for (const key of Object.keys(process.env)) if (!["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"].includes(key)) delete process.env[key]
let failure
let diagramCalls = 0
const invoked = []
let complete
const finished = new Promise((resolve) => { complete = resolve })
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (body.model === "diagram-secondary") { diagramCalls++; throw new Error("Duplicate secondary generation during main-agent authoring") }
    const results = body.messages.filter((message) => message.role === "tool")
    let delta = { content: "Published diagram." }; let finish = "stop"
    if (results.length < 2) {
      const name = results.length ? "open_diagram_publish" : "open_diagram_snapshot"
      const catalog = JSON.stringify(body.messages)
      assert.ok(body.tools.some((tool) => tool.function.name === "execute"))
      assert.ok(catalog.includes(`tools.${name}(`), `native Code Mode catalog exposes exact path tools.${name}`)
      let args = {}
      if (results.length) {
        // Real tool-completion/context hooks run while primary author is held.
        // Wait beyond collection, debounce and rate-limit windows.
        await delay(2500)
        assert.equal(diagramCalls, 0)
        const content = results[0].content
        const raw = JSON.parse(typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""))
        const snapshot = typeof raw.content === "string" ? JSON.parse(raw.content) : raw
        assert.ok(snapshot.token && snapshot.evidence.length)
        args = { token: snapshot.token, analysis: { relevant: true, reason: "External author", views: [{ id: "workflow", label: "Workflow", graph: {
          title: "Tool-authored workflow", summary: "", nodes: [{ id: "queue", label: "Queue", kind: "service", detail: "Accept messages", status: "planned", evidence: [snapshot.evidence[0].id] }], edges: [],
        } }] } }
      }
      invoked.push(name)
      delta = { tool_calls: [{ index: 0, id: `call_${results.length}`, type: "function", function: { name: "execute", arguments: JSON.stringify({ code: `return await tools.${name}(${JSON.stringify(args)})` }) } }] }
      finish = "tool_calls"
    } else complete()
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "author", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "author", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
  } catch (error) { failure = error; complete(); res.writeHead(500).end("fixture error") }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
try {
  await withV2Runtime(async (client, { temporary }) => {
    const project = join(temporary, "tools"); await mkdir(join(project, "provider"), { recursive: true })
    await writeFile(join(project, "provider/index.ts"), `import {Plugin,Provider,Model} from ${JSON.stringify(import.meta.resolve("@opencode/plugin"))};
      export default Plugin.define({id:"open-diagram-author-fixture",async setup(ctx){ const id=Provider.ID.make("diagram-author");
      await ctx.provider.transform(e=>e.add({info:{...Provider.Info.empty(id),activation:"enabled",package:"@opencode/ai/providers/openai-compatible",settings:{baseURL:"http://127.0.0.1:${server.address().port}/v1"}},models:[Model.Info.default(id,Model.ID.make("author")),Model.Info.default(id,Model.ID.make("diagram-secondary"))]}));
      await ctx.session.hook("title",e=>{e.result="Author fixture"});await ctx.session.hook("retry",e=>{e.decision={retry:false}});
      }})`)
    await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: [{ package: resolve(import.meta.dirname, ".."), options: { backend: "opencode", providerID: "diagram-author", model: "diagram-secondary", intervalMs: 1000, debounceMs: 1000 } }, "./provider"],
      model: "diagram-author/author", permissions: [{ action: "*", resource: "*", effect: "allow" }] }))
    const location = { directory: project }; await waitForPlugin(client, location)
    const session = await client.session.create({ location, title: "Queue workflow" })
    const signal = AbortSignal.timeout(15000)
    await client.session.prompt({ sessionID: session.id, text: "Map Gateway -> Queue -> Worker as a block diagram." }, { signal })
    await Promise.race([finished, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Native tool execution deadline")), { once: true }))])
    if (failure) throw failure
    assert.deepEqual(invoked, ["open_diagram_snapshot", "open_diagram_publish"])
    const { output } = await client.rpc.call({ location, rpcID: "open-diagram", method: "get", input: { sessionID: session.id } })
    assert.equal(output.graph?.title, "Tool-authored workflow")
    assert.equal(output.views[0].id, "workflow")
    await delay(1400)
    assert.equal(diagramCalls, 0)
    console.log("OK: native host exposes and executes snapshot -> publish tools; accepted view reaches production RPC")
    console.log("OK: auto-enabled native Code Mode snapshot reserves new evidence through delayed publication with zero secondary calls")
  })
} finally { await new Promise((resolve) => server.close(resolve)) }
