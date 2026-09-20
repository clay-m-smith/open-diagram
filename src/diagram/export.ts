import type { DiagramGraph } from "./schema.js"
import { diagramTextWidth, layoutDiagram, wrapDiagramText } from "./layout.js"
import { diagramArrowColor } from "./arrow-colors.js"
import { renderSceneSVG, sceneMarkerSVG } from "./scene-export.js"

export type DiagramExportColorMode = "light" | "dark"
export type DiagramExportOptions = { selected?: string; colorMode?: DiagramExportColorMode }
const WIDTH = 960
const MARGIN = 28
const LINE = 24
const CELL = 10
const MAX_PIXELS = 16_000_000
const PALETTES = {
  light: { background: "#ffffff", card: "#eef2f8", text: "#172033", subdued: "#465166", border: "#64748b" },
  dark: { background: "#111827", card: "#1e293b", text: "#e5e7eb", subdued: "#b6c2d2", border: "#94a3b8" },
} as const
// Graph schema is intentionally broader than XML 1.0 (including lone UTF-16
// surrogates). Normalize only the exported representation, never saved graphs.
const escape = (text: string) => text.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "\uFFFD")
  .replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!))

/** Render accepted graph data only; never captures terminal UI or source text. */
export async function renderDiagramSVG(graph: DiagramGraph, options: DiagramExportOptions = {}): Promise<string> {
  if (!graph.nodes.length || graph.nodes.length > 24 || graph.edges.length > 48) throw new Error("Diagram exceeds export bounds")
  // Native callers resolve the host's system mode at click time. Standalone
  // render callers without a host retain the deterministic light default.
  const dark = options.colorMode === "dark"
  const palette = PALETTES[dark ? "dark" : "light"]
  const caption = graph.title
  const layout = await layoutDiagram(graph, { columns: 88, selected: options.selected })
  const title = wrapDiagramText(caption, 86)
  const summary = graph.notation && graph.summary ? wrapDiagramText(graph.summary, 86) : []
  const top = MARGIN + (title.length + summary.length + 1) * LINE
  const width = Math.max(WIDTH, layout.width * CELL + MARGIN * 2)
  const height = Math.ceil(top + layout.height * LINE + MARGIN)
  const left = (width - layout.width * CELL) / 2
  const elements: string[] = []
  const tips = new Map<string, number>()
  for (const edge of layout.edges) {
    const key = JSON.stringify(edge.points.at(-1))
    tips.set(key, (tips.get(key) ?? 0) + 1)
  }
  const segments: Array<{ edge: number; vertical: boolean; fixed: number; start: number; end: number }> = []
  const text = (value: string, x: number, y: number, color: string = palette.text, bold = false) => {
    const length = diagramTextWidth(value) * CELL
    elements.push(`<text x="${x}" y="${y}" fill="${color}"${bold ? ' font-weight="bold"' : ""}${length ? ` textLength="${length}" lengthAdjust="spacingAndGlyphs"` : ""}>${escape(value)}</text>`)
  }
  title.forEach((line, i) => text(line, MARGIN, MARGIN + (i + 1) * LINE, palette.text, true))
  summary.forEach((line, i) => text(line, MARGIN, MARGIN + (title.length + i + 1) * LINE, palette.subdued))
  if (layout.scene) elements.push(renderSceneSVG(layout.scene, { left, top, cell: CELL, line: LINE, dark, ...palette, escape }))
  for (const [edgeIndex, edge] of layout.edges.entries()) {
    const color = diagramArrowColor(edge.tone, dark)
    const source = layout.nodes.find((box) => box.node.id === edge.from)!
    const target = layout.nodes.find((box) => box.node.id === edge.to)!
    const points = edge.points.map((point) => ({ x: left + (point.x + 0.5) * CELL,
      y: top + (point.y + 0.5) * LINE }))
    for (const [end, box, side] of [[false, source, edge.sourceSide], [true, target, edge.targetSide]] as const) {
      // Extend cell-center endpoints to the border; moving them can turn the
      // last horizontal bend into a diagonal when snapping removed a short leg.
      const point = { ...(end ? points.at(-1)! : points[0]) }
      if (side === "top" || side === "bottom") point.y = top + (box.y + (side === "bottom" ? box.height : 0)) * LINE
      else point.x = left + (box.x + (side === "right" ? box.width : 0)) * CELL
      if (end) points.push(point); else points.unshift(point)
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]; const b = points[i]; const vertical = a.x === b.x
      segments.push({ edge: edgeIndex, vertical, fixed: vertical ? a.x : a.y,
        start: Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x), end: Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x) })
    }
    const marker = tips.get(JSON.stringify(edge.points.at(-1)))! > 1 ? "shared" : edge.tone
    let markers = edge.endMarker === "none" ? "" : ` marker-end="url(#arrow-${marker})"`
    if (edge.endMarker && edge.endMarker !== "none" && edge.endMarker !== "arrow") {
      elements.push(`<defs>${sceneMarkerSVG(`typed-end-${edgeIndex}`, edge.endMarker, color, palette.background)}</defs>`)
      markers = ` marker-end="url(#typed-end-${edgeIndex})"`
    }
    if (edge.startMarker) {
      elements.push(`<defs>${sceneMarkerSVG(`typed-start-${edgeIndex}`, edge.startMarker, color, palette.background, true)}</defs>`)
      markers += ` marker-start="url(#typed-start-${edgeIndex})"`
    }
    elements.push(`<path d="${points.map((point, i) => `${i ? "L" : "M"}${point.x},${point.y}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"${edge.dashed ? ' stroke-dasharray="5 4"' : ""}${markers}/>`)
    edge.labelLines.forEach((line, i) => text(line, left + edge.labelX * CELL, top + (edge.labelY + i + 0.8) * LINE, color))
  }
  // Neutralize coincident lengths after every colored route is painted. Merely
  // recoloring merged tips leaves shared trunks attributed to the last edge.
  // Perpendicular crossings have zero shared length and remain colored.
  const shared = new Set<string>()
  segments.forEach((a, i) => {
    for (const b of segments.slice(i + 1)) {
      if (a.edge === b.edge || a.vertical !== b.vertical || a.fixed !== b.fixed) continue
      const start = Math.max(a.start, b.start); const end = Math.min(a.end, b.end)
      if (start >= end) continue
      shared.add(a.vertical ? `M${a.fixed},${start} L${a.fixed},${end}` : `M${start},${a.fixed} L${end},${a.fixed}`)
    }
  })
  if (shared.size) elements.push(`<path d="${[...shared].join(" ")}" fill="none" stroke="${palette.border}" stroke-width="2"/>`)
  for (const box of layout.nodes) {
    elements.push(`<rect x="${left + box.x * CELL}" y="${top + box.y * LINE}" width="${box.width * CELL}" height="${box.height * LINE}" rx="10" fill="${palette.card}" stroke="${palette.border}"/>`)
    box.lines.forEach((line, i) => text(line.text, left + (box.x + 2) * CELL, top + (box.y + i + 1.8) * LINE,
      line.role === "meta" ? palette.subdued : palette.text, line.role === "label"))
  }
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)))
  const marker = (id: number | "shared", color: string) => `<marker id="arrow-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="${color}"/></marker>`
  const markers = [...new Set(layout.edges.map((edge) => edge.tone))].map((tone) => marker(tone, diagramArrowColor(tone, dark))).join("")
    + ([...tips.values()].some((count) => count > 1) ? marker("shared", palette.border) : "")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.floor(width * scale)}" height="${Math.floor(height * scale)}" viewBox="0 0 ${width} ${height}" role="img"${graph.notation ? ` data-notation="${graph.notation.family}"` : ""}><title>${escape(caption)}</title><defs>${markers}</defs><rect width="100%" height="100%" fill="${palette.background}"/><g font-family="DejaVu Sans Mono, monospace" font-size="16">${elements.join("")}</g></svg>`
}

export async function renderDiagramPNG(graph: DiagramGraph, options: DiagramExportOptions = {}): Promise<Uint8Array> {
  const svg = await renderDiagramSVG(graph, options)
  const { Resvg } = await import("@resvg/resvg-js")
  return new Resvg(svg, { font: { defaultFontFamily: "DejaVu Sans Mono", loadSystemFonts: true } }).render().asPng()
}
