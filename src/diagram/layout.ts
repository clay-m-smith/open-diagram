import type { DiagramGraph } from "./schema.js"
import { diagramTextWidth, wrapDiagramText } from "./diagram-text.js"
export { diagramTextWidth, wrapDiagramText } from "./diagram-text.js"
import { diagramArrowTones } from "./arrow-colors.js"
import type { ElkNode } from "elkjs/lib/elk-api.js"
import { solveLayout } from "./layout-solver.js"
import type { DiagramScene, SceneMarker } from "./scene.js"
import { emptyScene, sceneWireRuns } from "./scene.js"
import { notationEdgeLabel, notationNodeLines } from "./notation.js"
import { layoutNotation } from "./notation-layout.js"

export type DiagramLine = { text: string; role: "label" | "meta" | "detail" | "sources" | "source" }
export type DiagramBox = { node: DiagramGraph["nodes"][number]; x: number; y: number; width: number; height: number; lines: DiagramLine[] }
export type DiagramPoint = { x: number; y: number }
export type DiagramSide = "top" | "bottom" | "left" | "right"
export type DiagramLink = DiagramGraph["edges"][number] & {
  cycle: boolean; direct: boolean; tone: number; points: DiagramPoint[]; labelLines: string[]; labelX: number; labelY: number
  sourceSide: DiagramSide; targetSide: DiagramSide
  startMarker?: SceneMarker; endMarker?: SceneMarker | "none"; dashed?: boolean
}
export type DiagramLayout = { nodes: DiagramBox[]; edges: DiagramLink[]; width: number; height: number; scene?: DiagramScene }
export type DiagramLayoutOptions = {
  columns?: number; selected?: string; changed?: readonly string[]
  sourceControl?: boolean; sources?: readonly string[]
}

/** Stable topological flow order, excluding DFS return edges, not graph data. */
export function diagramFlowOrder(graph: DiagramGraph) {
  const notation = graph.notation
  if (notation?.family === "sequence") return notation.participants.map((id) => graph.nodes.find((node) => node.id === id)!)
  if (notation?.family === "timing") return notation.signals.map((signal) => graph.nodes.find((node) => node.id === signal.node)!)
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

const layouts = new Map<string, Promise<DiagramLayout>>()
const round = (value: number) => Math.floor(value + 0.5000001)

/** Bounded, shared local solver cache. No server, model, or persistent state. */
export function layoutDiagram(graph: DiagramGraph, options: DiagramLayoutOptions = {}): Promise<DiagramLayout> {
  const key = JSON.stringify([graph, options])
  const cached = layouts.get(key)
  if (cached) return cached
  // Own the inputs while ELK runs asynchronously; callers may change selection.
  const [snapshot, settings] = JSON.parse(key) as [DiagramGraph, DiagramLayoutOptions]
  const pending = solveDiagram(snapshot, settings)
  layouts.set(key, pending)
  if (layouts.size > 64) layouts.delete(layouts.keys().next().value!)
  void pending.catch(() => { if (layouts.get(key) === pending) layouts.delete(key) })
  return pending
}

async function solveDiagram(graph: DiagramGraph, options: DiagramLayoutOptions): Promise<DiagramLayout> {
  const ordered = diagramFlowOrder(graph)
  const index = new Map(ordered.map((node, i) => [node.id, i]))
  const tones = diagramArrowTones(graph.edges, ordered.map((node) => node.id))
  const columns = Math.max(20, Math.min(500, Math.floor(options.columns ?? 38)))
  const cardLimit = Math.max(18, Math.min(50, columns - 8))
  const nodes = ordered.map((node): DiagramBox => {
    const selected = node.id === options.selected
    const limit = selected ? cardLimit : Math.min(cardLimit, 34)
    const lines: DiagramLine[] = []
    const add = (text: string, role: DiagramLine["role"]) => {
      lines.push(...wrapDiagramText(text, limit - 4).map((text) => ({ text, role })))
    }
    add(`${node.label}${node.status === "planned" ? " ~" : ""}${options.changed?.includes(node.id) ? " *" : ""}`, "label")
    for (const line of notationNodeLines(graph, node.id)) add(line, "meta")
    if (selected) {
      add(`${node.kind} · ${node.status}`, "meta")
      if (node.detail) add(node.detail, "detail")
      if (node.behavior) add(node.behavior, "detail")
      if (options.sourceControl) add(options.sources ? "[Hide sources]" : "[Sources]", "sources")
      for (const caption of options.sources ?? []) add(caption, "source")
    }
    return { node, x: 0, y: 0, width: Math.max(10, ...lines.map((line) => diagramTextWidth(line.text) + 4)), height: lines.length + 2, lines }
  })
  const specialized = layoutNotation(graph, nodes, columns)
  if (specialized) return specialized
  const notation = graph.notation
  const scene = notation ? emptyScene() : undefined
  const edges = graph.edges.map((edge, i): DiagramLink => {
    const cycle = index.get(edge.to)! <= index.get(edge.from)!
    const label = notationEdgeLabel(graph, i)
    return { ...edge, cycle, direct: false, tone: tones[i], points: [], sourceSide: "bottom", targetSide: "top",
      labelLines: label || (cycle && !notation) ? wrapDiagramText(`${cycle && !notation ? "↺ " : ""}${label}`, notation ? 24 : 16) : [], labelX: 0, labelY: 0 }
  })
  if (notation?.family === "architecture") for (const link of notation.links) {
    const edge = edges[link.edge]
    edge.endMarker = link.direction === "none" ? "none" : "arrow"
    if (link.direction === "both") edge.startMarker = "arrow"
    edge.dashed = link.role === "dependency"
  }
  if (notation?.family === "class" || notation?.family === "er") for (const relation of notation.relationships) {
    const edge = edges[relation.edge]
    edge.endMarker = relation.kind === "inheritance" || relation.kind === "realization" ? "triangle" : relation.kind === "dependency" ? "open" : "none"
    if (relation.kind === "aggregation" || relation.kind === "composition") edge.startMarker = relation.kind === "composition" ? "filled-diamond" : "diamond"
    edge.dashed = relation.kind === "dependency" || relation.kind === "realization"
  }
  const ports = notation?.family === "architecture" ? notation.ports : []
  const links = notation?.family === "architecture" ? notation.links : []
  const endpoint = (i: number, source: boolean) => {
    const link = links.find((link) => link.edge === i)
    const id = source ? link?.fromPort : link?.toPort
    return id ? `p${ports.findIndex((port) => port.id === id)}` : `${source ? "s" : "t"}${i}`
  }
  const children: ElkNode[] = nodes.map((box, i) => ({ id: `n${i}`, width: box.width, height: box.height * 2,
    layoutOptions: { "elk.portConstraints": "FREE", "elk.nodeSize.constraints": "[]" },
    ports: [...ports.flatMap((port, j) => port.node === box.node.id ? [{ id: `p${j}`, width: 0, height: 0 }] : []),
      ...edges.flatMap((edge, j) => [
        ...(edge.from === box.node.id && endpoint(j, true).startsWith("s") ? [{ id: endpoint(j, true), width: 0, height: 0 }] : []),
        ...(edge.to === box.node.id && endpoint(j, false).startsWith("t") ? [{ id: endpoint(j, false), width: 0, height: 0 }] : []),
      ])],
  }))
  const groups = notation && "groups" in notation ? notation.groups : []
  const groupBoxes = new Map(groups.map((group, i) => [group.id, { id: `g${i}`, children: [] as ElkNode[],
    layoutOptions: { "elk.padding": "[top=8,left=4,bottom=4,right=4]", "elk.nodeLabels.placement": "[INSIDE,H_LEFT,V_TOP]" },
    labels: [{ text: `${group.label} (${group.kind})`, width: diagramTextWidth(`${group.label} (${group.kind})`), height: 2 }],
  }]))
  for (const group of groups) for (const id of group.nodes) groupBoxes.get(group.id)!.children.push(children[index.get(id)!])
  const grouped = new Set(groups.flatMap((group) => group.nodes))
  const rootChildren = children.filter((_, i) => !grouped.has(nodes[i].node.id))
  for (const group of groups) {
    const box = groupBoxes.get(group.id)!
    if (group.parent) groupBoxes.get(group.parent)!.children.push(box)
    else rootChildren.push(box)
  }
  // Width is a preference, not a clipping constraint. Keep a downward flow and
  // allow more parallel nodes at larger widths; scroll handles dense graphs.
  // Selection/details do not change this bound and unexpectedly reorder layers.
  const typicalWidth = Math.max(18, ...ordered.map((node) => Math.min(34, diagramTextWidth(node.label) + 4)))
  const input: ElkNode = { id: "root", layoutOptions: {
    "elk.algorithm": "layered", "elk.direction": "DOWN", "elk.edgeRouting": "ORTHOGONAL",
    "elk.randomSeed": "1", "elk.separateConnectedComponents": "false",
    ...(groups.length ? { "elk.hierarchyHandling": "INCLUDE_CHILDREN" } : {}),
    "elk.layered.layering.strategy": "COFFMAN_GRAHAM",
    "elk.layered.layering.coffmanGraham.layerBound": String(Math.max(1, Math.floor(columns / (typicalWidth + 8)))),
    "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    // Tighten horizontal card/label gaps, keeping route clearance and vertical
    // lane spacing large enough to survive terminal-cell rounding.
    "elk.spacing.nodeNode": "2", "elk.spacing.edgeLabel": "1", "elk.spacing.edgeNode": "2", "elk.spacing.edgeEdge": "2",
    "elk.spacing.portPort": "2", "elk.spacing.nodeSelfLoop": "4", "elk.spacing.labelNode": "2",
    "elk.layered.spacing.nodeNodeBetweenLayers": "6", "elk.layered.spacing.edgeNodeBetweenLayers": "2",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "2", "elk.padding": "[top=2,left=2,bottom=2,right=2]",
  }, children: rootChildren, edges: edges.map((edge, i) => ({ id: `e${i}`, sources: [endpoint(i, true)], targets: [endpoint(i, false)],
    labels: edge.labelLines.length ? [{ text: edge.labelLines.join("\n"), width: Math.max(...edge.labelLines.map(diagramTextWidth)), height: edge.labelLines.length * 2 }] : [],
  })) }
  const result = await solveLayout(input)
  const boxes = new Map<string, ElkNode>()
  const routedEdges = new Map<string, NonNullable<ElkNode["edges"]>[number]>()
  const collect = (box: ElkNode, x = 0, y = 0) => {
    const absolute = { ...box, x: x + (box.x ?? 0), y: y + (box.y ?? 0) }
    boxes.set(box.id, absolute)
    for (const edge of box.edges ?? []) routedEdges.set(edge.id, edge)
    for (const child of box.children ?? []) collect(child, absolute.x, absolute.y)
  }
  collect(result)
  for (const group of groups) {
    const box = boxes.get(groupBoxes.get(group.id)!.id)!
    scene!.regions.push({ x: round(box.x!), y: round(box.y! / 2), width: Math.ceil(box.width!), height: Math.ceil(box.height! / 2),
      label: `${group.label} (${group.kind})`, style: "group" })
  }
  nodes.forEach((box, i) => {
    const placed = boxes.get(`n${i}`)!
    box.x = round(placed.x!); box.y = round(placed.y! / 2)
    box.width = Math.ceil(placed.width!); box.height = Math.ceil(placed.height! / 2)
  })
  const port = (point: DiagramPoint, i: number, box: DiagramBox): { side: DiagramSide; point: DiagramPoint } => {
    const raw = boxes.get(`n${i}`)!
    const sides: Array<[DiagramSide, number]> = [["left", Math.abs(point.x - raw.x!)], ["right", Math.abs(point.x - raw.x! - raw.width!)],
      ["top", Math.abs(point.y - raw.y!)], ["bottom", Math.abs(point.y - raw.y! - raw.height!)]]
    const side = sides.sort((a, b) => a[1] - b[1])[0][0]
    return { side, point: { x: side === "left" ? box.x - 1 : side === "right" ? box.x + box.width : round(point.x),
      y: side === "top" ? box.y - 1 : side === "bottom" ? box.y + box.height : round(point.y / 2) } }
  }
  edges.forEach((edge, i) => {
    const routed = routedEdges.get(`e${i}`)
    const section = routed?.sections?.[0]
    if (!section || routed!.sections!.length !== 1) throw new Error("Diagram route unavailable")
    const container = boxes.get(routed!.container ?? "root")!
    const offset = (point: DiagramPoint) => ({ x: point.x + (container?.x ?? 0), y: point.y + (container?.y ?? 0) })
    const from = index.get(edge.from)!; const to = index.get(edge.to)!
    const start = port(offset(section.startPoint), from, nodes[from]); const end = port(offset(section.endPoint), to, nodes[to])
    edge.sourceSide = start.side; edge.targetSide = end.side
    edge.points = [start.point, ...(section.bendPoints ?? []).map(offset).map((p) => ({ x: round(p.x), y: round(p.y / 2) })), end.point]
      .filter((p, j, all) => !j || p.x !== all[j - 1].x || p.y !== all[j - 1].y)
    if (edge.points.length < 2 || edge.points.some((p, j, all) => !Number.isFinite(p.x + p.y)
      || (j > 0 && p.x !== all[j - 1].x && p.y !== all[j - 1].y))) throw new Error("Diagram route is not orthogonal")
    edge.direct = edge.points.length === 2 && edge.points[0].x === edge.points[1].x && edge.points[0].y < edge.points[1].y
    if (edge.labelLines.length) { edge.labelX = round(routed!.labels![0].x! + (container?.x ?? 0)); edge.labelY = round((routed!.labels![0].y! + (container?.y ?? 0)) / 2) }
  })
  // Cards in one layer overlap vertically, but may be top-aligned or centered.
  // Read that row left to right regardless of an expanded card's height.
  nodes.sort((a, b) => a.y - b.y || a.x - b.x)
  const reading: DiagramBox[] = []
  for (let i = 0; i < nodes.length;) {
    const row = [nodes[i++]]
    let bottom = row[0].y + row[0].height
    while (i < nodes.length && nodes[i].y < bottom) {
      bottom = Math.min(bottom, nodes[i].y + nodes[i].height); row.push(nodes[i++])
    }
    reading.push(...row.sort((a, b) => a.x - b.x))
  }
  return { nodes: reading, edges, width: Math.ceil(result.width!), height: Math.ceil(result.height! / 2), ...(scene ? { scene } : {}) }
}

export type DiagramWireRun = { text: string; tone?: number }

/** Rasterize only connectors; shared cells stay neutral rather than lie about ownership. */
export function diagramWireRuns(layout: DiagramLayout): DiagramWireRun[] {
  if (layout.scene) return sceneWireRuns({ ...layout.scene, paths: [...layout.scene.paths, ...layout.edges.map((edge, i) => ({
    points: edge.points, owner: `edge-${i}`, tone: edge.tone, dashed: edge.dashed, startMarker: edge.startMarker,
    endMarker: edge.endMarker === "none" ? undefined : edge.endMarker ?? "arrow",
  }))] }, layout.width, layout.height)
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
    arrows.set(`${end.x},${end.y}`, { top: "▼", bottom: "▲", left: "▶", right: "◀" }[edge.targetSide])
  }
  const glyphs = [" ", "│", "─", "└", "│", "│", "┌", "├", "─", "┘", "─", "┴", "┐", "┤", "┬", "┼"]
  const runs: DiagramWireRun[] = []
  const append = (text: string, tone?: number) => {
    const previous = runs.at(-1)
    if (previous && previous.tone === tone) previous.text += text
    else runs.push({ text, tone })
  }
  cells.forEach((row, y) => {
    row.forEach((mask, x) => {
      const key = `${x},${y}`
      const paths = owners.get(key)
      const directions = [...(paths?.values() ?? [])]
      // Draw vertical routes over perpendicular ones, not a false junction or
      // overlap marker. Actual shared spine branches remain neutral T junctions.
      const crossing = mask === 15 && directions.includes(5) && directions.includes(10)
      const arrow = arrows.get(key)
      const vertical = crossing && !arrow ? [...paths!].filter(([, direction]) => direction === 5) : []
      const glyph = arrow ?? (crossing ? "│" : glyphs[mask])
      const tone = vertical.length === 1 ? vertical[0][0].tone : paths?.size === 1 ? paths.keys().next().value!.tone : undefined
      append(glyph, tone)
    })
    if (y < cells.length - 1) append("\n")
  })
  return runs
}

export function diagramWires(layout: DiagramLayout): string {
  return diagramWireRuns(layout).map((run) => run.text).join("")
}
