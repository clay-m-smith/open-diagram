import type { DiagramGraph } from "./schema.js"
import stringWidth from "string-width"

export type DiagramLine = { text: string; role: "label" | "meta" | "detail" | "sources" | "source" }
export type DiagramBox = { node: DiagramGraph["nodes"][number]; x: number; y: number; width: number; height: number; lines: DiagramLine[] }
export type DiagramPoint = { x: number; y: number }
export type DiagramLink = DiagramGraph["edges"][number] & {
  cycle: boolean; direct: boolean; points: DiagramPoint[]; labelLines: string[]; labelX: number; labelY: number
}
export type DiagramLayout = { nodes: DiagramBox[]; edges: DiagramLink[]; width: number; height: number }
export type DiagramLayoutOptions = {
  columns?: number; selected?: string; changed?: readonly string[]
  sourceControl?: boolean; sources?: readonly string[]
}

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export function diagramTextWidth(value: string): number {
  // Same maintained cell-width dependency as OpenTUI, including supplementary
  // CJK and grapheme clusters. Keep wrapping independent of native FFI loading.
  return stringWidth(value)
}

/** Wrap at word boundaries where possible, never inside a Unicode grapheme. */
export function wrapDiagramText(value: string, columns: number): string[] {
  const width = Math.max(2, Math.floor(columns))
  const lines: string[] = []
  let line = ""
  for (const word of value.split(/\s+/u)) {
    if (!word) continue
    if (line && diagramTextWidth(`${line} ${word}`) <= width) { line += ` ${word}`; continue }
    if (line) { lines.push(line); line = "" }
    for (const { segment } of segments.segment(word)) {
      if (diagramTextWidth(line + segment) > width) { lines.push(line); line = "" }
      line += segment
    }
  }
  if (line || !lines.length) lines.push(line)
  return lines
}

/** Stable topological flow order, excluding DFS return edges, not graph data. */
export function diagramFlowOrder(graph: DiagramGraph) {
  const visited = new Set<string>(); const active = new Set<string>(); const returns = new Set<number>()
  const visit = (id: string) => {
    if (visited.has(id)) return
    visited.add(id); active.add(id)
    graph.edges.forEach((edge, i) => {
      if (edge.from !== id) return
      if (active.has(edge.to)) returns.add(i)
      else visit(edge.to)
    })
    active.delete(id)
  }
  graph.nodes.forEach((node) => visit(node.id))
  const remaining = new Set(graph.nodes.map((node) => node.id))
  const ordered: DiagramGraph["nodes"] = []
  while (remaining.size) {
    const next = graph.nodes.find((node) => remaining.has(node.id) && !graph.edges.some((edge, i) =>
      !returns.has(i) && edge.to === node.id && remaining.has(edge.from)))!
    ordered.push(next); remaining.delete(next.id)
  }
  return ordered
}

/**
 * Content-sized cards on a shared spine. Only real adjacent edges use the
 * spine; skips, forks, joins and loops use reusable outside lanes. Connectors
 * never pass through another card, and disconnected nodes get no fake arrow.
 */
export function layoutDiagram(graph: DiagramGraph, options: DiagramLayoutOptions = {}): DiagramLayout {
  const ordered = diagramFlowOrder(graph)
  const index = new Map(ordered.map((node, i) => [node.id, i]))
  const directPairs = new Set<string>()
  const links = graph.edges.map((edge) => {
    const from = index.get(edge.from)!; const to = index.get(edge.to)!
    const direct = to === from + 1 && !directPairs.has(edge.from)
    if (direct) directPairs.add(edge.from)
    return { ...edge, direct, cycle: to <= from, lane: -1, start: Math.min(from + 0.8, to + 0.4), end: Math.max(from + 0.8, to + 0.4) }
  })
  const laneEnds: number[] = []
  for (const edge of links.filter((edge) => !edge.direct).sort((a, b) => a.start - b.start || a.end - b.end)) {
    let lane = laneEnds.findIndex((end) => end < edge.start)
    if (lane < 0) lane = laneEnds.length
    laneEnds[lane] = edge.end; edge.lane = lane
  }
  const columns = Math.max(20, Math.min(120, Math.floor(options.columns ?? 38)))
  const cardLimit = Math.max(18, Math.min(50, columns - laneEnds.length * 2 - 3))
  const nodes = ordered.map((node): DiagramBox => {
    const selected = node.id === options.selected
    const limit = selected ? cardLimit : Math.min(cardLimit, 34)
    const lines: DiagramLine[] = []
    const add = (text: string, role: DiagramLine["role"]) => {
      lines.push(...wrapDiagramText(text, limit - 4).map((text) => ({ text, role })))
    }
    add(`${node.label}${node.status === "planned" ? " ~" : ""}${options.changed?.includes(node.id) ? " *" : ""}`, "label")
    if (selected) {
      add(`${node.kind} · ${node.status}`, "meta")
      if (node.detail) add(node.detail, "detail")
      if (node.behavior) add(node.behavior, "detail")
      if (options.sourceControl) add(options.sources ? "[Hide sources]" : "[Sources]", "sources")
      for (const caption of options.sources ?? []) add(caption, "source")
    }
    return { node, x: 0, y: 0, width: Math.max(10, ...lines.map((line) => diagramTextWidth(line.text) + 4)), height: lines.length + 2, lines }
  })
  const bodyWidth = Math.max(28, ...nodes.map((node) => node.width))
  const axis = Math.floor(bodyWidth / 2)
  const edges = links.map((edge): DiagramLink => ({ ...edge, points: [],
    labelLines: edge.label || edge.cycle ? wrapDiagramText(`${edge.cycle ? "↺ " : ""}${edge.label}`, axis - 2) : [], labelX: 0, labelY: 0 }))
  let y = 0
  for (const box of nodes) {
    box.x = axis - Math.floor(box.width / 2); box.y = y
    y += box.height
    // Keep the direct arrow nearest its destination; routed branches leave first.
    const outgoing = edges.map((edge, i) => ({ edge, i })).filter(({ edge }) => edge.from === box.node.id)
      .sort((a, b) => Number(a.edge.direct) - Number(b.edge.direct))
    for (const { edge } of outgoing) {
      edge.labelY = y + 1
      edge.labelX = axis - 2 - Math.max(0, ...edge.labelLines.map(diagramTextWidth))
      edge.points = [{ x: axis, y: box.y + box.height }, { x: axis, y: y + 1 + Math.floor(edge.labelLines.length / 2) }]
      y += Math.max(1, edge.labelLines.length + 1)
    }
    y += outgoing.length ? 1 : 2
  }
  const byID = new Map(nodes.map((box) => [box.node.id, box]))
  edges.forEach((edge, i) => {
    const target = byID.get(edge.to)!
    if (edge.direct) edge.points.push({ x: axis, y: target.y - 1 })
    else {
      const x = bodyWidth + 1 + links[i].lane * 2
      const targetY = target.y + Math.floor(target.height / 2)
      edge.points.push({ x, y: edge.points[1].y }, { x, y: targetY }, { x: target.x + target.width, y: targetY })
    }
  })
  return { nodes, edges, width: bodyWidth + (laneEnds.length ? laneEnds.length * 2 + 1 : 0), height: Math.max(1, y - 1) }
}

/** Rasterize only connectors. Node cards and labels are independent hit targets. */
export function diagramWires(layout: DiagramLayout): string {
  const cells = Array.from({ length: layout.height }, () => Array<number>(layout.width).fill(0))
  const owners = new Map<string, Map<DiagramLink, number>>()
  const arrows = new Map<string, string>()
  for (const edge of layout.edges) {
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1]; const b = edge.points[i]
      const dx = Math.sign(b.x - a.x); const dy = Math.sign(b.y - a.y)
      let x = a.x; let y = a.y
      while (x !== b.x || y !== b.y) {
        const nx = x + dx; const ny = y + dy
        const outgoing = dx > 0 ? 2 : dx < 0 ? 8 : dy > 0 ? 4 : 1
        const incoming = dx > 0 ? 8 : dx < 0 ? 2 : dy > 0 ? 1 : 4
        cells[y][x] |= outgoing
        cells[ny][nx] |= incoming
        for (const [key, mask] of [[`${x},${y}`, outgoing], [`${nx},${ny}`, incoming]] as const) {
          const values = owners.get(key) ?? new Map<DiagramLink, number>()
          values.set(edge, (values.get(edge) ?? 0) | mask)
          owners.set(key, values)
        }
        x = nx; y = ny
      }
    }
    const end = edge.points.at(-1)!
    arrows.set(`${end.x},${end.y}`, edge.direct ? "▼" : "◀")
  }
  const glyphs = [" ", "│", "─", "└", "│", "│", "┌", "├", "─", "┘", "─", "┴", "┐", "┤", "┬", "┼"]
  return cells.map((row, y) => row.map((mask, x) => {
    const key = `${x},${y}`
    if (arrows.has(key)) return arrows.get(key)!
    const paths = [...(owners.get(key)?.values() ?? [])]
    // Straight perpendicular routes cross after diverging even when they share
    // a source/destination. Actual shared spine branches remain T junctions.
    if (mask === 15 && paths.includes(5) && paths.includes(10)) return "╳"
    return glyphs[mask]
  }).join("")).join("\n")
}
