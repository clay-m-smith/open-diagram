import type { DiagramGraph } from "./schema.js"
import { diagramTextWidth, layoutDiagram, wrapDiagramText } from "./layout.js"

export type DiagramExportOptions = { selected?: string }
const WIDTH = 960
const MARGIN = 28
const LINE = 24
const CELL = 10
const MAX_PIXELS = 16_000_000
// Graph schema is intentionally broader than XML 1.0 (including lone UTF-16
// surrogates). Normalize only the exported representation, never saved graphs.
const escape = (text: string) => text.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "\uFFFD")
  .replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!))

/** Render accepted graph data only; never captures terminal UI or source text. */
export function renderDiagramSVG(graph: DiagramGraph, options: DiagramExportOptions = {}): string {
  if (!graph.nodes.length || graph.nodes.length > 24 || graph.edges.length > 48) throw new Error("Diagram exceeds export bounds")
  const layout = layoutDiagram(graph, { columns: 88, selected: options.selected })
  const title = wrapDiagramText(graph.title, 86)
  const top = MARGIN + (title.length + 1) * LINE
  const width = Math.max(WIDTH, layout.width * CELL + MARGIN * 2)
  const height = Math.ceil(top + layout.height * LINE + MARGIN)
  const left = (width - layout.width * CELL) / 2
  const elements: string[] = []
  const text = (value: string, x: number, y: number, color = "#172033", bold = false) => {
    const length = diagramTextWidth(value) * CELL
    elements.push(`<text x="${x}" y="${y}" fill="${color}"${bold ? ' font-weight="bold"' : ""}${length ? ` textLength="${length}" lengthAdjust="spacingAndGlyphs"` : ""}>${escape(value)}</text>`)
  }
  title.forEach((line, i) => text(line, MARGIN, MARGIN + (i + 1) * LINE, "#172033", true))
  for (const edge of layout.edges) {
    const source = layout.nodes.find((box) => box.node.id === edge.from)!
    const target = layout.nodes.find((box) => box.node.id === edge.to)!
    const points = edge.points.map((point, i) => ({ x: left + (point.x + 0.5) * CELL,
      y: top + (point.y + 0.5) * LINE }))
    points[0].y = top + (source.y + source.height) * LINE
    if (edge.direct) points[points.length - 1].y = top + target.y * LINE
    else points[points.length - 1].x = left + (target.x + target.width) * CELL
    elements.push(`<path d="${points.map((point, i) => `${i ? "L" : "M"}${point.x},${point.y}`).join(" ")}" fill="none" stroke="#64748b" stroke-width="2" stroke-linejoin="round" marker-end="url(#arrow)"/>`)
    edge.labelLines.forEach((line, i) => text(line, left + edge.labelX * CELL, top + (edge.labelY + i + 0.8) * LINE, "#465166"))
  }
  for (const box of layout.nodes) {
    elements.push(`<rect x="${left + box.x * CELL}" y="${top + box.y * LINE}" width="${box.width * CELL}" height="${box.height * LINE}" rx="10" fill="#eef2f8" stroke="#64748b"/>`)
    box.lines.forEach((line, i) => text(line.text, left + (box.x + 2) * CELL, top + (box.y + i + 1.8) * LINE,
      line.role === "meta" ? "#465166" : "#172033", line.role === "label"))
  }
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.floor(width * scale)}" height="${Math.floor(height * scale)}" viewBox="0 0 ${width} ${height}" role="img"><title>${escape(graph.title)}</title><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#64748b"/></marker></defs><rect width="100%" height="100%" fill="#ffffff"/><g font-family="DejaVu Sans Mono, monospace" font-size="16">${elements.join("")}</g></svg>`
}

export async function renderDiagramPNG(graph: DiagramGraph, options: DiagramExportOptions = {}): Promise<Uint8Array> {
  const svg = renderDiagramSVG(graph, options)
  const { Resvg } = await import("@resvg/resvg-js")
  return new Resvg(svg, { font: { defaultFontFamily: "DejaVu Sans Mono", loadSystemFonts: true } }).render().asPng()
}
