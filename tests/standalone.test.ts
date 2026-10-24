import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { DiagramStore } from "../src/standalone/store.js"

const publication = {
  diagramID: "example", expectedRevision: 0,
  sources: [{ id: "design", label: "Client-supplied design" }],
  analysis: { relevant: true, reason: "Client-authored system", views: [{ id: "overview", label: "Overview", graph: {
    title: "Client <diagram>", summary: "",
    nodes: [{ id: "app", label: "App", kind: "service", detail: "Handles requests", status: "planned", evidence: ["design"] }], edges: [],
  } }] },
}

test("standalone publications are bounded, validated, isolated and revision-guarded", async () => {
  const store = new DiagramStore()
  const first = store.publish(publication)
  assert.equal(first.revision, 1)
  first.analysis.views[0].graph.title = "Changed clone"
  assert.equal(store.get("example").analysis.views[0].graph.title, "Client <diagram>")
  assert.throws(() => store.publish(publication), /Revision conflict/)
  const invalid = structuredClone(publication)
  invalid.expectedRevision = 1
  invalid.analysis.views[0].graph.nodes[0].evidence = ["not_supplied"]
  assert.throws(() => store.publish(invalid), /outside current snapshot/)
  assert.equal(store.get("example").revision, 1)
  assert.throws(() => store.publish({ ...publication, diagramID: "duplicate", sources: [...publication.sources, ...publication.sources] }), /Invalid publication/)
  assert.throws(() => store.publish({ ...publication, expectedRevision: 1, analysis: { relevant: false, reason: "", views: [] } }), /at least one view/)
  assert.throws(() => store.remove({ diagramID: "example", expectedRevision: 0 }), /Revision conflict/)
  store.remove({ diagramID: "example", expectedRevision: 1 })
  assert.throws(() => store.get("example"), /not found/)
  const recreated = store.publish(publication)
  assert.ok(recreated.revision > first.revision, "delete/recreate cannot reuse an old revision")
  assert.throws(() => store.publish({ ...publication, expectedRevision: 1 }), /Revision conflict/)
  assert.deepEqual(new DiagramStore().list(), [], "server instances never share diagrams")
  for (let i = 1; i < 32; i++) store.publish({ ...publication, diagramID: `diagram_${i}` })
  assert.throws(() => store.publish({ ...publication, diagramID: "overflow" }), /capacity/)
  assert.equal(store.list().length, 32)
  await assert.rejects(store.render({ diagramID: "example", viewID: "missing", format: "svg" }), /View not found/)
})

test("render captures accepted revision, bounds concurrency and retains accepted data", async () => {
  const store = new DiagramStore()
  const first = store.publish(publication)
  const request = { diagramID: "example", viewID: "overview", format: "svg" }
  const oldRender = store.render(request)
  const parallelRender = store.render(request)
  await assert.rejects(store.render(request), /busy/)
  const changed = structuredClone(publication)
  changed.expectedRevision = first.revision
  changed.analysis.views[0].graph.title = "New diagram"
  const second = store.publish(changed)
  const [old] = await Promise.all([oldRender, parallelRender])
  assert.equal(old.revision, first.revision)
  assert.match(old.data, /Client &lt;diagram&gt;/)
  const current = await store.render(request)
  assert.equal(current.revision, second.revision)
  assert.match(current.data, /New diagram/)
  await assert.rejects(store.render({ ...request, selected: "missing" }), /Selected node not found/)
})

// Exercise the public executable with both host packages and network fetch denied.
const guardLoader = `export function resolve(specifier, context, next) {
  if (/^(@opencode\\/|@opentui\\/|solid-js(?:\\/|$)|effect(?:\\/|$))/.test(specifier)) throw new Error("Forbidden host import: " + specifier);
  return next(specifier, context);
}`
const dataURL = (text: string) => `data:text/javascript,${encodeURIComponent(text)}`
const guard = dataURL(`import { register } from "node:module";
  register(${JSON.stringify(dataURL(guardLoader))}, import.meta.url);
  globalThis.fetch = () => { throw new Error("Standalone network access forbidden"); };`)
const executable = fileURLToPath(new URL("../mcp.mjs", import.meta.url))

test("public core imports, validates and renders without host runtime", () => {
  const code = `import { GraphSchema, renderDiagramSVG, diagramOutputSchema } from "open-diagram/core";
    const graph = GraphSchema.parse(${JSON.stringify(publication.analysis.views[0].graph)});
    if (!(await renderDiagramSVG(graph)).includes("<svg") || !diagramOutputSchema().properties) throw new Error("Core output missing");`
  const run = spawnSync(process.execPath, ["--import", guard, "--import", "tsx", "--input-type=module", "-e", code], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 15_000,
  })
  assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stdout}\n${run.stderr}`)
})

for (const mode of ["legacy", "auto"] as const) test(`stdio MCP ${mode}: discover, publish, read resources, render, reject stale update and remove`, { timeout: 25_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "open-diagram-mcp-"))
  const client = new Client({ name: "open-diagram-test", version: "1.0.0" }, { versionNegotiation: { mode } })
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", guard, executable],
    cwd, stderr: "pipe" })
  let stderr = ""
  transport.stderr?.on("data", chunk => { stderr += String(chunk) })
  try {
    await client.connect(transport)
    if (mode === "auto") assert.ok(client.getDiscoverResult(), "current protocol discovery")
    assert.equal(client.getServerVersion()?.name, "open-diagram")
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["diagram_get", "diagram_list", "diagram_publish", "diagram_remove", "diagram_render", "diagram_schema"])
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args })
    const contract = await call("diagram_schema")
    assert.ok(contract.structuredContent && typeof contract.structuredContent === "object" && "outputSchema" in contract.structuredContent)
    const accepted = await call("diagram_publish", publication)
    assert.ok(!accepted.isError, JSON.stringify(accepted))
    assert.equal((accepted.structuredContent as { revision: number }).revision, 1)
    assert.deepEqual((await call("diagram_get", { diagramID: "example" })).structuredContent, accepted.structuredContent)
    const listed = await client.listResources()
    assert.equal(listed.resources[0].uri, "diagram://local/example")
    const resource = await client.readResource({ uri: listed.resources[0].uri })
    assert.ok("text" in resource.contents[0])
    assert.deepEqual(JSON.parse(String(resource.contents[0].text)), accepted.structuredContent)
    const stale = await call("diagram_publish", publication)
    assert.equal(stale.isError, true)
    const invalid = structuredClone(publication)
    invalid.expectedRevision = 1
    invalid.analysis.views[0].graph.nodes[0].evidence = ["not_supplied"]
    assert.equal((await call("diagram_publish", invalid)).isError, true)
    assert.deepEqual((await call("diagram_get", { diagramID: "example" })).structuredContent, accepted.structuredContent)
    const svg = await call("diagram_render", { diagramID: "example", viewID: "overview", format: "svg", selected: "app" })
    assert.ok(!svg.isError, JSON.stringify(svg))
    const embedded = svg.content.find(item => item.type === "resource")
    assert.ok(embedded?.type === "resource" && "text" in embedded.resource)
    assert.match(embedded.resource.text as string, /<svg/)
    assert.match(embedded.resource.text as string, /Handles requests/)
    const png = await call("diagram_render", { diagramID: "example", viewID: "overview", format: "png" })
    assert.ok(!png.isError, JSON.stringify(png))
    const image = png.content.find(item => item.type === "image")
    assert.ok(image?.type === "image")
    assert.equal(image.mimeType, "image/png")
    assert.deepEqual([...Buffer.from(image.data, "base64").subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal((await call("diagram_remove", { diagramID: "example", expectedRevision: 1 })).isError, undefined)
    assert.equal((await client.listResources()).resources.length, 0)
    assert.equal((await call("diagram_get", { diagramID: "example" })).isError, true)
  } catch (error) { throw new Error(`${String(error)}\nServer stderr: ${stderr}`, { cause: error }) }
  finally {
    try { await client.close() } finally { await rm(cwd, { recursive: true, force: true }) }
  }
})
