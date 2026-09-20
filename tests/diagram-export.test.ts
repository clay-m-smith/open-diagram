import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { renderDiagramPNG, renderDiagramSVG } from "../src/diagram/export.js"
import { createDiagramExportActions, type ExportHost } from "../src/diagram/export-actions.js"
import { saveDiagramFile, copyDiagramImage } from "../src/diagram/export-platform.js"
import type { DiagramGraph } from "../src/diagram/schema.js"
import { layoutDiagram } from "../src/diagram/layout.js"
import { diagramArrowColor } from "../src/diagram/arrow-colors.js"
import { notationFixtures } from "./fixtures/notations.js"
import { sceneMarkerSVG } from "../src/diagram/scene-export.js"

const graph: DiagramGraph = { title: "Model <SVG> & image", summary: "Not displayed",
  nodes: [
    { id: "a", label: 'Input <script>alert("x")</script>', kind: "input", status: "observed", detail: "Expanded details", behavior: "Functional explanation", evidence: ["PRIVATE_CITATION"] },
    { id: "b", label: "モデル × 128", kind: "model", status: "planned", detail: "Unselected details", evidence: ["PRIVATE_CITATION"] },
  ], edges: [{ from: "a", to: "b", label: "branch & join" }, { from: "b", to: "a", label: "feedback" }, { from: "b", to: "b", label: "self" }] }

test("SVG exports full graph with safe labels and only displayed details, no chrome", async () => {
  const original = structuredClone(graph)
  const svg = await renderDiagramSVG(graph, { selected: "a" })
  assert.equal(svg, await renderDiagramSVG(graph, { selected: "a" }))
  assert.deepEqual(graph, original)
  for (const value of ["&lt;script&gt;", "&amp;", "Expanded details", "Functional explanation", "モデル × 128", "branch &amp; join", "feedback", "self"]) assert.ok(svg.includes(value), value)
  assert.doesNotMatch(svg, /<script>|PRIVATE_CITATION|Unselected details|Not displayed|\[Sources\]|\[Refresh\]|\[Pause\]|\[Expand\]|stale|foreignObject|href=/)
  assert.equal((svg.match(/rx="10"/g) ?? []).length, graph.nodes.length)
  assert.equal((svg.match(/marker-end="url\(#arrow-\d+\)"/g) ?? []).length, graph.edges.length)
  for (const edge of (await layoutDiagram(graph)).edges) {
    const color = diagramArrowColor(edge.tone)
    assert.ok(svg.includes(`stroke="${color}" stroke-width="2" stroke-linejoin="round" marker-end="url(#arrow-${edge.tone})"`), "exported route uses same hue identity as terminal")
    assert.match(svg, new RegExp(`<marker id="arrow-${edge.tone}"[^>]*><path[^>]*fill="${color}"`))
    const label = edge.label === "branch & join" ? "branch &amp; join" : edge.cycle ? `↺ ${edge.label}` : edge.label
    assert.match(svg, new RegExp(`<text[^>]*fill="${color}"[^>]*>${label}</text>`), "label and arrow match")
  }
  assert.doesNotMatch(svg, /\[1\]|\[2\]/)
  for (const match of svg.matchAll(/<rect[^>]*width="(\d+)"[^>]*rx="10"/g)) assert.ok(Number(match[1]) < 600, "content-sized cards, not full-width rectangles")
  assert.doesNotMatch(await renderDiagramSVG(graph), /Expanded details|Functional explanation/)
  const dark = await renderDiagramSVG(graph, { selected: "a", colorMode: "dark" })
  assert.match(dark, /<rect width="100%" height="100%" fill="#111827"/)
  assert.match(dark, /rx="10" fill="#1e293b" stroke="#94a3b8"/)
  assert.match(dark, /fill="#e5e7eb"[^>]*>Expanded details<\/text>/)
  assert.match(dark, /fill="#b6c2d2"[^>]*>input · observed<\/text>/)
  for (const edge of (await layoutDiagram(graph)).edges) {
    const color = diagramArrowColor(edge.tone, true)
    assert.ok(dark.includes(`stroke="${color}" stroke-width="2" stroke-linejoin="round" marker-end="url(#arrow-${edge.tone})"`))
    assert.match(dark, new RegExp(`<marker id="arrow-${edge.tone}"[^>]*><path[^>]*fill="${color}"`))
  }
  assert.equal(await renderDiagramSVG(graph, { colorMode: "light" }), await renderDiagramSVG(graph), "standalone default remains deterministic without host context")
})

test("PNG rasterizes full tall SVG with bounded nonempty dimensions", async () => {
  const tall = { ...graph, nodes: Array.from({ length: 24 }, (_, i) => ({ ...graph.nodes[0], id: `n${i}`, label: `Layer ${i}` })),
    edges: Array.from({ length: 23 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, label: `edge ${i}` })) }
  const svg = await renderDiagramSVG(tall, { colorMode: "dark" })
  assert.match(svg, /Layer 23/)
  const png = Buffer.from(await renderDiagramPNG(tall, { colorMode: "dark" }))
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const width = png.readUInt32BE(16); const height = png.readUInt32BE(20)
  assert.equal(width, 960); assert.ok(height > 1500); assert.ok(width * height <= 16_000_000)
  assert.ok(png.byteLength > 5000)
  assert.match(svg, new RegExp(`height="${height}"`))
})

test("specialized SVG and PNG expose shared notation geometry without citations", async () => {
  for (const [family, graph] of Object.entries(notationFixtures)) {
    const svg = await renderDiagramSVG(graph)
    assert.match(svg, new RegExp(`data-notation="${family}"`))
    assert.doesNotMatch(svg, /e_design|e_wiring/)
    if (family === "circuit") {
      assert.match(svg, /data-net="net:sda_net"/)
      assert.match(svg, /unassigned/)
      assert.doesNotMatch(svg, /marker-end=/, "electrical nets are not directed graph edges")
    }
    if (family === "sequence") {
      assert.match(svg, /data-owner="message:/)
      assert.doesNotMatch(svg, /orient="auto-start-reverse"/, "resvg 2.6.2 leaves these markers unrotated")
    }
    if (family === "timing") assert.match(svg, /not to scale/)
    const png = Buffer.from(await renderDiagramPNG(graph))
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.ok(png.readUInt32BE(16) * png.readUInt32BE(20) <= 16_000_000)
  }
})

test("PNG marker orientation points toward the endpoint for replies and source arrows", async () => {
  const { Resvg } = await import("@resvg/resvg-js")
  // A leftward reply and a start arrow on a rightward path both point left.
  // Count tip/wing pixels, not a font- or antialias-sensitive full-image golden.
  for (const start of [false, true]) {
    const marker = sceneMarkerSVG("arrow", "arrow", "#000000", "#ffffff", start)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="white"/><defs>${marker}</defs><path d="${start ? "M30,30 L90,30" : "M90,30 L30,30"}" stroke="black" stroke-width="2" marker-${start ? "start" : "end"}="url(#arrow)"/></svg>`
    const image = new Resvg(svg).render()
    const pixels = image.pixels
    const ink = (left: number, right: number) => {
      let count = 0
      for (let y = 20; y <= 40; y++) for (let x = left; x <= right; x++) if (pixels[(y * 100 + x) * 4] < 128) count++
      return count
    }
    assert.ok(ink(37, 43) > ink(27, 33), "left-pointing tip is narrower than right-side wings")
  }
})

test("ELK exports separate ports and preserves orthogonal border joins", async () => {
  const fork = { ...graph, nodes: ["a", "b", "c", "d"].map((id) => ({ ...graph.nodes[0], id, label: id })),
    edges: [{ from: "a", to: "b", label: "next" }, { from: "a", to: "d", label: "skip" }, { from: "b", to: "d", label: "join" }] }
  const svg = await renderDiagramSVG(fork)
  const routes = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="([^"]+)"[^>]*marker-end="url\(#arrow-([^)]*)\)"/g)]
  assert.equal(routes.length, 3)
  assert.ok(routes.every((route) => route[3] !== "shared"), "solver avoids merged arrowheads in this formerly overlapping fan-in")
  const points = routes.map((route) => [...route[1].matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((point) => [Number(point[1]), Number(point[2])]))
  assert.notDeepEqual(points[1].at(-1), points[2].at(-1), "distinct fan-in targets")
  assert.notDeepEqual(points[0][0], points[1][0], "distinct fork origins")
  const layout = await layoutDiagram(fork, { columns: 88 })
  const left = (960 - layout.width * 10) / 2
  const top = 28 + 2 * 24
  layout.edges.forEach((edge, i) => {
    const box = layout.nodes.find((node) => node.node.id === edge.to)!
    const tip = points[i].at(-1)!
    if (edge.targetSide === "top" || edge.targetSide === "bottom") assert.equal(tip[1], top + (box.y + (edge.targetSide === "bottom" ? box.height : 0)) * 24)
    else assert.equal(tip[0], left + (box.x + (edge.targetSide === "right" ? box.width : 0)) * 10)
  })
  assert.equal(new Set(routes.map((route) => route[2])).size, 3, "unshared route lengths retain distinct hues")
  const cyclic = { ...fork, nodes: ["Input", "Features", "Model", "Result"].map((label, i) => ({ ...fork.nodes[i], label,
    status: i < 2 ? "observed" as const : "planned" as const })), edges: [
    { from: "a", to: "b", label: "left" }, { from: "a", to: "c", label: "right" },
    { from: "b", to: "d", label: "features" }, { from: "c", to: "d", label: "predictions" },
    { from: "d", to: "b", label: "feedback" }, { from: "d", to: "d", label: "retry" },
  ] }
  for (const route of (await renderDiagramSVG(cyclic)).matchAll(/<path d="([^"]+)"[^>]*marker-end=/g)) {
    const points = [...route[1].matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((p) => [Number(p[1]), Number(p[2])])
    for (let i = 1; i < points.length; i++) assert.ok(points[i][0] === points[i - 1][0] || points[i][1] === points[i - 1][1], "border extension must not turn snapped bend into a diagonal")
  }
  const crowded = await renderDiagramSVG({ ...cyclic, edges: [...cyclic.edges,
    ...Array.from({ length: 30 }, (_, i) => ({ from: "d", to: "b", label: `return ${i}` }))] }, { colorMode: "dark" })
  assert.match(crowded, /marker-end="url\(#arrow-shared\)"/, "unavoidable cell-merged tips remain neutral")
  assert.match(crowded, /<marker id="arrow-shared"[^>]*><path[^>]*fill="#94a3b8"/)
  assert.ok(crowded.lastIndexOf('fill="none" stroke="#94a3b8"') > crowded.lastIndexOf('marker-end='), "neutral shared lengths overlay every colored route")
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
    const svg = await renderDiagramSVG(graph)
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
  let colorMode: "light" | "dark" = "dark"
  const host: ExportHost = { directory, colorMode: () => colorMode, chooseFormat: () => delayed ? new Promise((resolve) => { choose = resolve }) : Promise.resolve(format),
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
    assert.match(copies[0], /<rect width="100%" height="100%" fill="#111827"/)
    delayed = true
    const input = structuredClone(graph)
    const saving = run("save", input); input.title = "Changed after click"
    colorMode = "light"
    await run("svg", graph); assert.equal(copies.length, 1)
    choose("svg"); await saving
    assert.match(await readFile(path!, "utf8"), /Model &lt;SVG&gt;/)
    assert.doesNotMatch(await readFile(path!, "utf8"), /Changed after click/)
    assert.match(await readFile(path!, "utf8"), /<rect width="100%" height="100%" fill="#111827"/, "Save retains click-time mode while format dialog is open")
    await run("svg", graph)
    assert.match(copies.at(-1)!, /<rect width="100%" height="100%" fill="#ffffff"/, "next click resolves current mode")
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
