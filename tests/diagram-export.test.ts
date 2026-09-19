import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { renderDiagramPNG, renderDiagramSVG } from "../src/diagram/export.js"
import { createDiagramExportActions, type ExportHost } from "../src/diagram/export-actions.js"
import { saveDiagramFile, copyDiagramImage } from "../src/diagram/export-platform.js"
import type { DiagramGraph } from "../src/diagram/schema.js"

const graph: DiagramGraph = { title: "Model <SVG> & image", summary: "Not displayed",
  nodes: [
    { id: "a", label: 'Input <script>alert("x")</script>', kind: "input", status: "observed", detail: "Expanded details", behavior: "Functional explanation", evidence: ["PRIVATE_CITATION"] },
    { id: "b", label: "モデル × 128", kind: "model", status: "planned", detail: "Unselected details", evidence: ["PRIVATE_CITATION"] },
  ], edges: [{ from: "a", to: "b", label: "branch & join" }, { from: "b", to: "a", label: "feedback" }, { from: "b", to: "b", label: "self" }] }

test("SVG exports full graph with safe labels and only displayed details, no chrome", () => {
  const original = structuredClone(graph)
  const svg = renderDiagramSVG(graph, { selected: "a" })
  assert.equal(svg, renderDiagramSVG(graph, { selected: "a" }))
  assert.deepEqual(graph, original)
  for (const value of ["&lt;script&gt;", "&amp;", "Expanded details", "Functional explanation", "モデル × 128", "branch &amp; join", "feedback", "self"]) assert.ok(svg.includes(value), value)
  assert.doesNotMatch(svg, /<script>|PRIVATE_CITATION|Unselected details|Not displayed|\[Sources\]|\[Refresh\]|\[Pause\]|\[Expand\]|stale|foreignObject|href=/)
  assert.equal((svg.match(/rx="10"/g) ?? []).length, graph.nodes.length)
  assert.doesNotMatch(renderDiagramSVG(graph), /Expanded details|Functional explanation/)
})

test("PNG rasterizes full tall SVG with bounded nonempty dimensions", async () => {
  const tall = { ...graph, nodes: Array.from({ length: 24 }, (_, i) => ({ ...graph.nodes[0], id: `n${i}`, label: `Layer ${i}` })),
    edges: Array.from({ length: 23 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, label: `edge ${i}` })) }
  const svg = renderDiagramSVG(tall)
  assert.match(svg, /Layer 23/)
  const png = Buffer.from(await renderDiagramPNG(tall))
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const width = png.readUInt32BE(16); const height = png.readUInt32BE(20)
  assert.equal(width, 960); assert.ok(height > 1500); assert.ok(width * height <= 16_000_000)
  assert.ok(png.byteLength > 5000)
  assert.match(svg, new RegExp(`height="${height}"`))
})

test("exclusive save never replaces files/symlinks and removes temporary staging", async () => {
  const directory = await mkdtemp("/tmp/opencode/diagram-save-")
  const signal = new AbortController().signal
  try {
    const target = join(directory, "diagram.svg")
    await saveDiagramFile(target, "new", signal)
    await assert.rejects(saveDiagramFile(target, "overwrite", signal), { code: "EEXIST" })
    await symlink(target, join(directory, "link.svg"))
    await assert.rejects(saveDiagramFile(join(directory, "link.svg"), "overwrite", signal), { code: "EEXIST" })
    assert.equal(await readFile(target, "utf8"), "new")
    assert.deepEqual((await readdir(directory)).sort(), ["diagram.svg", "link.svg"])
    const abort = new AbortController(); abort.abort()
    await assert.rejects(saveDiagramFile(join(directory, "aborted.svg"), "no", abort.signal))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("PNG and SVG image MIME clipboards honor forwarded X11 over SSH without invoking a shell", async () => {
  const directory = await mkdtemp("/tmp/opencode/diagram-clipboard-")
  const previous = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, SSH_TTY: process.env.SSH_TTY }
  try {
    const target = join(directory, "clipboard.png")
    await writeFile(join(directory, "xclip"), `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('TARGETS')) {
  if(fs.existsSync(${JSON.stringify(target + ".lost")})) process.exit(1);
  const args=JSON.parse(fs.readFileSync(${JSON.stringify(target + ".args")},'utf8'));
  process.stdout.write('TARGETS\\n'+args[3]+'\\n');
} else {
  fs.writeFileSync(${JSON.stringify(target)},fs.readFileSync(0));
  fs.writeFileSync(${JSON.stringify(target + ".args")},JSON.stringify(process.argv.slice(2)));
}`)
    await chmod(join(directory, "xclip"), 0o700)
    process.env.PATH = `${directory}:${previous.PATH}`; process.env.DISPLAY = "localhost:10.0"; process.env.SSH_TTY = "/dev/pts/fixture"
    const png = await renderDiagramPNG(graph)
    assert.deepEqual(await copyDiagramImage(png, "image/png", new AbortController().signal, true), { copied: true })
    assert.deepEqual(await readFile(target), Buffer.from(png))
    assert.deepEqual(JSON.parse(await readFile(target + ".args", "utf8")), ["-selection", "clipboard", "-t", "image/png", "-i"])
    const svg = renderDiagramSVG(graph)
    assert.deepEqual(await copyDiagramImage(Buffer.from(svg), "image/svg+xml", new AbortController().signal, true), { copied: true })
    assert.equal(await readFile(target, "utf8"), svg)
    assert.deepEqual(JSON.parse(await readFile(target + ".args", "utf8")), ["-selection", "clipboard", "-t", "image/svg+xml", "-i"])
    // xclip's parent can exit zero before its forked selection owner fails.
    // The former exit-only assertion could report success with no image offered.
    await writeFile(target + ".lost", "fixture")
    const lost = await copyDiagramImage(png, "image/png", new AbortController().signal, true)
    assert.equal(lost.copied, false)
    assert.match(!lost.copied ? lost.reason : "", /image\/png.*localhost:10\.0/)
    delete process.env.DISPLAY
    assert.deepEqual(await copyDiagramImage(png, "image/png", new AbortController().signal, true), {
      copied: false, reason: "TUI has no forwarded DISPLAY. Start OpenCode from an ssh -X session, or save the diagram.",
    })
    process.env.DISPLAY = "localhost:10.0"; process.env.PATH = join(directory, "missing")
    const missing = await copyDiagramImage(png, "image/png", new AbortController().signal, true)
    assert.equal(missing.copied, false)
    assert.match(!missing.copied ? missing.reason : "", /xclip is not installed or not on the TUI PATH/)
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(directory, { recursive: true, force: true })
  }
})

test("copy/save actions capture graph at click, coalesce, cancel, and fall back without model calls", async () => {
  const directory = await mkdtemp("/tmp/opencode/diagram-actions-")
  const notices: string[] = []; const copies: string[] = []; const prompts: boolean[] = []
  let format: "png" | "svg" = "svg"; let path: string | undefined = join(directory, "saved.svg")
  let choose!: (value: "svg") => void; let delayed = false; let copied = true
  const host: ExportHost = { directory, chooseFormat: () => delayed ? new Promise((resolve) => { choose = resolve }) : Promise.resolve(format),
    choosePath: async (_value, _format, fallback) => { prompts.push(fallback); return path },
    copySVG: async (svg) => { copies.push(svg); return copied ? { copied: true } : { copied: false, reason: "Fixture clipboard failure" } },
    copyPNG: async () => ({ copied: false, reason: "Fixture image clipboard unavailable" }),
    notify: (message) => { notices.push(message) } }
  const abort = new AbortController()
  const run = createDiagramExportActions(host, abort.signal)
  try {
    await run("svg", graph, "a")
    assert.equal(copies.length, 1); assert.equal(prompts.length, 0)
    assert.match(notices.at(-1)!, /SVG copied to image clipboard/)
    delayed = true
    const input = structuredClone(graph)
    const saving = run("save", input); input.title = "Changed after click"
    await run("svg", graph); assert.equal(copies.length, 1)
    choose("svg"); await saving
    assert.match(await readFile(path!, "utf8"), /Model &lt;SVG&gt;/)
    assert.doesNotMatch(await readFile(path!, "utf8"), /Changed after click/)
    delayed = false
    await run("save", graph); assert.match(notices.at(-1)!, /already exists/)
    path = join(directory, "fallback.png"); format = "png"
    await run("png", graph)
    assert.equal(prompts.at(-1), true); assert.equal((await readFile(path))[0], 137)
    path = undefined; copied = false
    await run("svg", graph)
    assert.equal(prompts.at(-1), true)
    delayed = true; path = join(directory, "cancelled.svg")
    const cancelled = run("save", graph); abort.abort(); choose("svg"); await cancelled
    await assert.rejects(readFile(path), { code: "ENOENT" })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
