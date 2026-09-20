import type { DiagramGraph } from "./schema.js"

// Paired hues: bright on dark terminals, darker on light terminals/white exports.
export const ARROW_COLORS = [
  { dark: "#56c8e8", light: "#00758d" },
  { dark: "#e5b567", light: "#986000" },
  { dark: "#b99cff", light: "#7950b0" },
  { dark: "#80c993", light: "#277641" },
  { dark: "#f28b82", light: "#b23e39" },
  { dark: "#80b5ff", light: "#2869b3" },
  { dark: "#e99acb", light: "#a33e7d" },
  { dark: "#66ccb8", light: "#087969" },
] as const

export function diagramArrowColor(tone: number, dark = false): string {
  return ARROW_COLORS[tone % ARROW_COLORS.length][dark ? "dark" : "light"]
}

/** Geometry-independent assignments survive resize, expansion and edge reorder. */
export function diagramArrowTones(edges: DiagramGraph["edges"], nodeOrder: readonly string[]): number[] {
  const index = new Map(nodeOrder.map((id, i) => [id, i]))
  const items = edges.map((edge, i) => ({ i, key: JSON.stringify([edge.from, edge.to, edge.label]),
    start: Math.min(index.get(edge.from)!, index.get(edge.to)!), end: Math.max(index.get(edge.from)!, index.get(edge.to)!) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const tones: number[] = []
  const used = Array<number>(ARROW_COLORS.length).fill(0)
  const assigned: Array<typeof items[number] & { tone: number }> = []
  for (const item of items) {
    let hash = 2166136261
    for (const char of item.key) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0
    const preferred = hash % ARROW_COLORS.length
    const scores = used.map((count, tone) => count + (edges.length + 1) * assigned.filter((other) =>
      other.tone === tone && other.start <= item.end && item.start <= other.end).length)
    let tone = preferred
    for (let offset = 1; offset < ARROW_COLORS.length; offset++) {
      const candidate = (preferred + offset) % ARROW_COLORS.length
      if (scores[candidate] < scores[tone]) tone = candidate
    }
    tones[item.i] = tone; used[tone]++; assigned.push({ ...item, tone })
  }
  return tones
}
