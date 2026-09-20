import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { GraphSchema } from "../src/diagram/schema.ts"
import { validateDiagramOutput } from "../src/diagram/harness.ts"
import { renderDiagramPNG, renderDiagramSVG } from "../src/diagram/export.ts"

// Hand-authored views of this repository, not inferred source analysis. Keep
// these source links and summaries in sync when the production flow changes.
const root = fileURLToPath(new URL("../", import.meta.url))
const output = resolve(root, "docs/images")
const check = process.argv.includes("--check")
assert.ok(process.argv.slice(2).every((arg) => arg === "--check"), "Usage: npm run docs:images [-- --check]")
const sources = [
  { id: "server", label: "src/diagram/server.ts", text: "Registers scoped RPC, session hooks, public-context collection and native storage callbacks." },
  { id: "evidence", label: "src/diagram/evidence.ts", text: "Collects bounded public session evidence; selection.ts supplies bounded excerpts." },
  { id: "engine", label: "src/diagram/engine.ts", text: "Owns snapshots, model scheduling, accepted diagrams and durable cache reuse." },
  { id: "author", label: "src/diagram/author.ts", text: "Builds the canonical author request and remaps current citations after validation." },
  { id: "client", label: "src/diagram/client.ts", text: "Calls the explicitly configured automatic backend. Manual publications use native tools or RPC instead." },
  { id: "tui", label: "src/diagram/tui.tsx", text: "Loads scoped snapshots, listens for updates and presents native controls and views." },
  { id: "view", label: "src/diagram/view.tsx", text: "Renders shared layout geometry and selectable native cards; viewing does not call a model." },
  { id: "export", label: "src/diagram/export.ts", text: "Renders the active graph through shared layout to SVG and PNG, without model calls." },
]
for (const source of sources) await readFile(resolve(root, source.label), "utf8")
const node = (id, label, detail, evidence) => ({ id, label, detail, kind: "module", status: "observed", evidence })

const architecture = GraphSchema.parse({
  title: "Open Diagram · from session to structure",
  summary: "High-level data flow with an explicitly configured automatic diagram author. Manual tools use the same validation and publication path.",
  nodes: [
    node("context", "Public session evidence", "server.ts, evidence.ts and selection.ts bound current requests, source reads and related-session work.", ["server", "evidence"]),
    node("engine", "Diagram engine", "engine.ts owns accepted views, change detection and per-depth cache reuse.", ["engine"]),
    node("author", "Configured diagram model", "client.ts and author.ts request schema-constrained views using an explicitly selected backend.", ["client", "author"]),
    node("storage", "Location-scoped storage", "Native plugin storage persists graph snapshots, tracking preferences and accepted caches.", ["server", "engine"]),
    node("tui", "Native OpenCode TUI", "tui.tsx and view.tsx show cached views with local shared layout, selection and Sources.", ["tui", "view"]),
    node("images", "PNG / SVG / Save", "export.ts reuses accepted graph data and shared layout. Exports never invoke a model.", ["export"]),
  ],
  edges: [
    { from: "context", to: "engine", label: "bounded evidence" },
    { from: "engine", to: "author", label: "changed input" },
    { from: "author", to: "engine", label: "validated views" },
    { from: "engine", to: "storage", label: "persist" },
    { from: "engine", to: "tui", label: "RPC snapshots" },
    { from: "tui", to: "images", label: "active graph" },
  ],
})

const cachedView = GraphSchema.parse({
  title: "Reopen a diagram · no model request",
  summary: "Cold TUI cache, warm engine cache. The server checks session ownership, then returns the accepted snapshot without collecting evidence or running inference.",
  nodes: [
    node("tui", "TUI monitor", "createDiagramMonitor reads once when this session is not in its local cache.", ["tui"]),
    node("rpc", "Server RPC", "The get handler checks session location before reading cached state.", ["server"]),
    node("engine", "DiagramEngine", "get returns the accepted snapshot; a cold engine can hydrate it from native storage.", ["engine"]),
  ],
  edges: [],
  notation: {
    version: 2, family: "sequence", participants: ["tui", "rpc", "engine"],
    messages: [
      { id: "get", from: "tui", to: "rpc", label: "get(sessionID)", kind: "sync", evidence: ["tui", "server"] },
      { id: "admit", from: "rpc", to: "rpc", label: "check location", kind: "sync", evidence: ["server"] },
      { id: "read", from: "rpc", to: "engine", label: "engine.get()", kind: "sync", evidence: ["server", "engine"] },
      { id: "snapshot", from: "engine", to: "rpc", label: "cached snapshot", kind: "return", evidence: ["engine"] },
      { id: "state", from: "rpc", to: "tui", label: "accepted views", kind: "return", evidence: ["server"] },
      { id: "render", from: "tui", to: "tui", label: "layout + render", kind: "sync", evidence: ["view"] },
    ],
    activations: [], fragments: [],
  },
})

const views = [{ id: "architecture", label: "Architecture", graph: architecture }, { id: "cached-view", label: "Cached view", graph: cachedView }]
validateDiagramOutput({ relevant: true, reason: "Source-linked views of this repository", views }, sources)
if (!check) await mkdir(output, { recursive: true })
for (const { id, graph } of views) for (const colorMode of ["light", "dark"]) {
  const stem = resolve(output, `${id}-${colorMode}`)
  const svg = await renderDiagramSVG(graph, { colorMode })
  if (check) {
    assert.equal(await readFile(`${stem}.svg`, "utf8"), svg, `${id}-${colorMode}.svg is stale; run npm run docs:images`)
    const png = await readFile(`${stem}.png`)
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    const dimensions = svg.match(/<svg[^>]* width="(\d+)" height="(\d+)"/)
    assert.ok(dimensions)
    assert.equal(png.readUInt32BE(16), Number(dimensions[1]))
    assert.equal(png.readUInt32BE(20), Number(dimensions[2]))
  } else {
    await writeFile(`${stem}.svg`, svg)
    await writeFile(`${stem}.png`, await renderDiagramPNG(graph, { colorMode }))
  }
  console.log(`${check ? "Checked" : "Rendered"} docs/images/${id}-${colorMode}.{svg,png}`)
}
