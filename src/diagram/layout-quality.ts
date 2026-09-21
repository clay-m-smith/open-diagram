import type { DiagramLayout, DiagramPoint } from "./layout.js"
import { diagramTextWidth } from "./diagram-text.js"

type Rect = { x: number; y: number; width: number; height: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
type Segment = { edge: number; vertical: boolean; fixed: number; start: number; end: number }

/** Terminal-cell objective: never buy compactness by obscuring cards or labels.
 * A couple of crossings and short shared runs are cheaper than wide empty lanes.
 * This scores a bounded candidate set, not a claim of global optimality. */
export function diagramLayoutCost(layout: DiagramLayout, columns: number): number {
  const cards: Rect[] = layout.nodes
  const labels = layout.edges.filter((edge) => edge.labelLines.length).map((edge) => ({
    x: edge.labelX, y: edge.labelY, width: Math.max(...edge.labelLines.map(diagramTextWidth)), height: edge.labelLines.length,
  }))
  const segments: Segment[] = []
  const touches = (a: DiagramPoint, b: DiagramPoint, rect: Rect) => overlaps({
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) + 1, height: Math.abs(a.y - b.y) + 1,
  }, rect)
  for (let i = 0; i < cards.length; i++) if (cards.slice(i + 1).some((box) => overlaps(cards[i], box))) return Infinity
  for (let i = 0; i < labels.length; i++) if (cards.some((box) => overlaps(labels[i], box)) || labels.slice(i + 1).some((box) => overlaps(labels[i], box))) return Infinity
  let length = 0; let bends = 0
  for (const [edge, route] of layout.edges.entries()) for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1]; const b = route.points[i]
    if (i > 1) {
      const previous = route.points[i - 2]
      if ((previous.x === a.x) !== (a.x === b.x)) bends++
    }
    if (cards.some((box) => touches(a, b, box)) || labels.some((box) => touches(a, b, box))) return Infinity
    const vertical = a.x === b.x
    const start = Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x)
    const end = Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x)
    segments.push({ edge, vertical, fixed: vertical ? a.x : a.y, start, end })
    length += vertical ? 2 * (end - start) : end - start
  }
  let crossings = 0; let shared = 0
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i]; const b = segments[j]
    if (a.edge === b.edge) continue
    if (a.vertical === b.vertical) {
      if (a.fixed === b.fixed) shared += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) * (a.vertical ? 2 : 1)
    } else {
      const [v, h] = a.vertical ? [a, b] : [b, a]
      // Endpoints shared by routes are not perpendicular crossings.
      if (v.fixed > h.start && v.fixed < h.end && h.fixed > v.start && h.fixed < v.end) crossings++
    }
  }
  const overflow = Math.max(0, layout.width - columns)
  return layout.width * layout.height + 8 * overflow * overflow + (layout.width ** 2 + layout.height ** 2) / 2
    + length * 2 + bends * 24 + Math.min(crossings, 2) * 40 + Math.max(0, crossings - 2) * 240 + shared * 8
}
