import type { DiagramLayout, DiagramLink, DiagramPoint, DiagramSide } from "./layout.js"
import { diagramTextWidth } from "./diagram-text.js"

type Rect = { x: number; y: number; width: number; height: number }
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const segment = (a: DiagramPoint, b: DiagramPoint): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) + 1, height: Math.abs(a.y - b.y) + 1 })
const label = (edge: DiagramLink): Rect => ({ x: edge.labelX, y: edge.labelY, width: Math.max(0, ...edge.labelLines.map(diagramTextWidth)), height: edge.labelLines.length })
const normal: Record<DiagramSide, DiagramPoint> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }

/** Remove redundant points, but not reversals (which are not straight runs). */
function clean(points: DiagramPoint[]) {
  const out: DiagramPoint[] = []
  for (const p of points) {
    if (out.at(-1)?.x === p.x && out.at(-1)?.y === p.y) continue
    while (out.length > 1) {
      const a = out.at(-2)!, b = out.at(-1)!
      if ((a.x === b.x && b.x === p.x && (b.y - a.y) * (p.y - b.y) > 0)
        || (a.y === b.y && b.y === p.y && (b.x - a.x) * (p.x - b.x) > 0)) out.pop()
      else break
    }
    out.push(p)
  }
  return out
}

/** Bounded local route cleanup. Cards, named ports, semantics and canvas never move.
 * Try straight/one-lane shortcuts, retaining ELK when obstacles require its route.
 * Labels may move beside their own route, never onto other content or wires. */
export function simplifyDiagramRoutes(layout: DiagramLayout, fixedPorts: readonly { source: boolean; target: boolean }[] = []): DiagramLayout {
  const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.width <= layout.width && r.y + r.height <= layout.height
  const fixed: Rect[] = [...layout.nodes,
    ...(layout.scene?.regions.filter(r => r.label).map(r => ({ x: r.x, y: r.y, width: diagramTextWidth(r.label) + 2, height: 1 })) ?? []),
    ...(layout.scene?.texts.map(t => ({ x: t.x, y: t.y, width: diagramTextWidth(t.text), height: 1 })) ?? [])]
  // Wires may cross a container boundary; text must not be struck through by it.
  const frames: Rect[] = layout.scene?.regions.flatMap(r => [
    { x: r.x, y: r.y, width: r.width, height: 1 }, { x: r.x, y: r.y + r.height - 1, width: r.width, height: 1 },
    { x: r.x, y: r.y, width: 1, height: r.height }, { x: r.x + r.width - 1, y: r.y, width: 1, height: r.height },
  ]) ?? []
  for (const [edgeIndex, edge] of layout.edges.entries()) {
    const others = layout.edges.filter(e => e !== edge)
    const obstacles = [...fixed, ...others.filter(e => e.labelLines.length).map(label)]
    const otherSegments = others.flatMap(e => e.points.slice(1).map((p, i) => segment(e.points[i], p)))
    const otherTips = others.map(e => e.points.at(-1)!)
    const originalFirst = edge.points[0], originalLast = edge.points.at(-1)!
    const outward = (p: DiagramPoint, side: DiagramSide) => ({ x: p.x + normal[side].x, y: p.y + normal[side].y })
    const pairs = [[originalFirst, originalLast]]
    // Unnamed ports have no semantic position. Straighten an adjacent connection
    // within the same card side, but preserve distinct/shared endpoint ownership.
    if (!normal[edge.sourceSide].x && !normal[edge.targetSide].x) {
      for (const source of [true, false]) {
        if (fixedPorts[edgeIndex]?.[source ? "source" : "target"]) continue
        const own = source ? originalFirst : originalLast, other = source ? originalLast : originalFirst
        const box = layout.nodes.find(n => n.node.id === (source ? edge.from : edge.to))!
        const point = { x: other.x, y: own.y }
        if (point.x <= box.x || point.x >= box.x + box.width - 1) continue
        if (others.some(e => [e.points[0], e.points.at(-1)!].some(p => p.y === own.y && (p.x === own.x || Math.abs(p.x - point.x) < 2)))) continue
        pairs.push(source ? [point, originalLast] : [originalFirst, point])
      }
    }
    const xs = new Set(edge.points.map(p => p.x))
    const ys = new Set(edge.points.map(p => p.y))
    // Obstacle edges are enough to try useful bypass lanes; no cell-grid search.
    for (const box of obstacles) { xs.add(box.x - 1); xs.add(box.x + box.width); ys.add(box.y - 1); ys.add(box.y + box.height) }
    const candidates = [clean(edge.points), ...pairs.flatMap(([first, last]) => {
      const start = outward(first, edge.sourceSide), end = outward(last, edge.targetSide)
      return [clean([first, start, { x: start.x, y: end.y }, end, last]),
        clean([first, start, { x: end.x, y: start.y }, end, last]),
        ...[...xs].map(x => clean([first, start, { x, y: start.y }, { x, y: end.y }, end, last])),
        ...[...ys].map(y => clean([first, start, { x: start.x, y }, { x: end.x, y }, end, last]))]
    })]
    const seen = new Set<string>()
    let best = Infinity
    let chosen: { points: DiagramPoint[]; x: number; y: number } | undefined
    for (const points of candidates) {
      const key = JSON.stringify(points)
      if (seen.has(key)) continue
      seen.add(key)
      if (points.length < 2) continue
      const first = points[0], last = points.at(-1)!
      if (points.some((p, i) => i > 1 && (p.x - points[i - 1].x) * (points[i - 1].x - points[i - 2].x)
        + (p.y - points[i - 1].y) * (points[i - 1].y - points[i - 2].y) < 0)) continue
      // Keep a straight, outward-facing terminal cell for arrowheads and exports.
      const aligned = (a: DiagramPoint, b: DiagramPoint, side: DiagramSide) => {
        const n = normal[side]
        return n.x ? a.y === b.y && (b.x - a.x) * n.x > 0 : a.x === b.x && (b.y - a.y) * n.y > 0
      }
      if (!aligned(first, points[1], edge.sourceSide) || !aligned(last, points.at(-2)!, edge.targetSide)) continue
      const segments = points.slice(1).map((p, i) => segment(points[i], p))
      if (segments.some(s => !inside(s) || obstacles.some(o => overlap(s, o)))) continue
      if (otherTips.some(p => !(p.x === last.x && p.y === last.y) && segments.some(s => overlap(s, { ...p, width: 1, height: 1 })))) continue
      let cost = (points.length - 2) * 64
      for (const s of segments) {
        cost += (s.width - 1 + 2 * (s.height - 1)) * 2
        for (const o of otherSegments) if (overlap(s, o)) {
          cost += s.width === 1 && o.width === 1 ? Math.max(0, Math.min(s.y + s.height, o.y + o.height) - Math.max(s.y, o.y) - 1) * 16
            : s.height === 1 && o.height === 1 ? Math.max(0, Math.min(s.x + s.width, o.x + o.width) - Math.max(s.x, o.x) - 1) * 8 : 40
        }
      }
      if (cost >= best) continue
      const box = label(edge)
      const oldPosition = segments.some(s => s.width === 1 && box.y >= s.y && box.y + box.height <= s.y + s.height
        && (box.x > s.x && box.x - s.x <= 2 || s.x >= box.x + box.width && s.x - box.x - box.width <= 1))
        ? [{ x: box.x, y: box.y }] : []
      const positions: DiagramPoint[] = []
      for (const s of segments) {
        if (s.width === 1 && s.height >= box.height) for (const y of [Math.floor(s.y + (s.height - box.height) / 2), s.y, s.y + s.height - box.height]) {
          positions.push({ x: s.x + 2, y }, { x: s.x - box.width - 1, y })
        }
        if (s.height === 1 && s.width >= box.width) {
          const x = Math.floor(s.x + (s.width - box.width) / 2)
          positions.push({ x, y: s.y - box.height - 1 }, { x, y: s.y + 1 })
        }
      }
      positions.push(...oldPosition)
      const position = !box.height ? { x: box.x, y: box.y } : positions.find(p => {
        const r = { ...box, ...p }
        return inside(r) && ![...obstacles, ...frames, ...segments, ...otherSegments].some(o => overlap(r, o))
      })
      if (!position) continue
      best = cost; chosen = { points, ...position }
    }
    if (chosen) {
      edge.points = chosen.points; edge.labelX = chosen.x; edge.labelY = chosen.y
      edge.direct = edge.points.length === 2 && edge.points[0].x === edge.points[1].x && edge.points[0].y < edge.points[1].y
    }
  }
  return layout
}
