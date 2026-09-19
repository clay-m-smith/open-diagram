import type { DiagramGraph } from "./schema.js"
import { layoutDiagram } from "./layout.js"

export type DiagramExportOptions = { selected?: string }
const WIDTH = 960
const MARGIN = 28
const LINE = 24
const MAX_PIXELS = 16_000_000
// Graph schema is intentionally broader than XML 1.0 (including lone UTF-16
// surrogates). Normalize only the exported representation, never saved graphs.
const escape = (text: string) => text.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "\uFFFD")
  .replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!))

// Conservative fixed-width wrapping, with full-width Unicode given two cells.
function lines(value: string, columns = 78): string[] {
  const result: string[] = []
  let line = ""; let used = 0
  for (const char of value) {
    const cells = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\u{1f000}-\u{1ffff}]/u.test(char) ? 2 : 1
    if (used + cells > columns) { result.push(line); line = ""; used = 0 }
    line += char; used += cells
  }
  if (line || !result.length) result.push(line)
  return result
}

/** Render accepted graph data only; never captures terminal UI or source text. */
export function renderDiagramSVG(graph: DiagramGraph, options: DiagramExportOptions = {}): string {
  if (!graph.nodes.length || graph.nodes.length > 24 || graph.edges.length > 48) throw new Error("Diagram exceeds export bounds")
  const elements: string[] = []
  let y = MARGIN
  const text = (value: string, color = "#172033", bold = false) => {
    for (const line of lines(value)) {
      y += LINE
      // textLength caps rendered width even when fallback fonts have wider glyphs.
      const length = Math.min(WIDTH - MARGIN * 2 - 32, [...line].reduce((n, char) => n + (char.codePointAt(0)! > 0x2e7f ? 20 : 10), 0))
      elements.push(`<text x="${MARGIN + 16}" y="${y}" fill="${color}"${bold ? ' font-weight="bold"' : ""}${length ? ` textLength="${length}" lengthAdjust="spacingAndGlyphs"` : ""}>${escape(line)}</text>`)
    }
  }
  text(graph.title, "#172033", true)
  y += 20
  for (const block of layoutDiagram(graph)) {
    const start = y
    const index = elements.length
    y += 8
    text(`[${block.number}] ${block.node.label}${block.node.status === "planned" ? " ~" : ""}`, "#172033", true)
    if (options.selected === block.node.id) {
      text(`${block.node.kind} · ${block.node.status}`, "#465166")
      if (block.node.detail) text(block.node.detail)
      if (block.node.behavior) text(block.node.behavior)
    }
    y += 16
    elements.splice(index, 0, `<rect x="${MARGIN}" y="${start}" width="${WIDTH - 2 * MARGIN}" height="${y - start}" rx="10" fill="#eef2f8" stroke="#64748b"/>`)
    for (const edge of block.outgoing) text(edge.text, "#465166")
    y += 18
  }
  const height = Math.ceil(y + MARGIN)
  if (WIDTH * height > MAX_PIXELS) throw new Error("Diagram exceeds export pixel limit")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img"><title>${escape(graph.title)}</title><rect width="100%" height="100%" fill="#ffffff"/><g font-family="DejaVu Sans Mono, monospace" font-size="16">${elements.join("")}</g></svg>`
}

export async function renderDiagramPNG(graph: DiagramGraph, options: DiagramExportOptions = {}): Promise<Uint8Array> {
  const svg = renderDiagramSVG(graph, options)
  const { Resvg } = await import("@resvg/resvg-js")
  return new Resvg(svg, { font: { defaultFontFamily: "DejaVu Sans Mono", loadSystemFonts: true } }).render().asPng()
}
