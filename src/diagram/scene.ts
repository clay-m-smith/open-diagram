/** Cell-space primitives shared by native terminal and vector/raster exports. */
export type ScenePoint = { x: number; y: number }
export type SceneMarker = "arrow" | "open" | "triangle" | "diamond" | "filled-diamond"
export type ScenePath = {
  points: ScenePoint[]
  owner: string
  tone?: number
  dashed?: boolean
  startMarker?: SceneMarker
  endMarker?: SceneMarker
  /** Start at this boundary of the first terminal cell in vector exports. */
  startBoundary?: "left" | "right" | "top" | "bottom"
}
export type SceneText = { x: number; y: number; text: string; tone?: number; node?: string }
export type SceneRegion = { x: number; y: number; width: number; height: number; label: string; style: "group" | "fragment" | "activation" }
export type SceneDot = ScenePoint & { owner: string; tone?: number }
export type DiagramScene = { paths: ScenePath[]; texts: SceneText[]; regions: SceneRegion[]; dots: SceneDot[] }
export const emptyScene = (): DiagramScene => ({ paths: [], texts: [], regions: [], dots: [] })

/** Only explicit shared ownership creates junctions. Crossings never join nets. */
export function sceneWireRuns(scene: DiagramScene, width: number, height: number): Array<{ text: string; tone?: number }> {
  const cells = new Map<string, Map<string, { mask: number; tone?: number; dashed?: boolean }>>()
  const markers = new Map<string, { text: string; tone?: number }>()
  const point = (p: ScenePoint, owner: string, mask: number, path: ScenePath) => {
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) throw new Error("Notation geometry exceeds scene bounds")
    const key = `${p.x},${p.y}`; const owners = cells.get(key) ?? new Map()
    const value = owners.get(owner) ?? { mask: 0, tone: path.tone, dashed: path.dashed }
    value.mask |= mask; owners.set(owner, value); cells.set(key, owners)
  }
  for (const path of scene.paths) {
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1]; const b = path.points[i]
      if (a.x !== b.x && a.y !== b.y) throw new Error("Notation route is not orthogonal")
      const dx = Math.sign(b.x - a.x); const dy = Math.sign(b.y - a.y)
      let x = a.x; let y = a.y
      while (x !== b.x || y !== b.y) {
        point({ x, y }, path.owner, dx > 0 ? 2 : dx < 0 ? 8 : dy > 0 ? 4 : 1, path)
        x += dx; y += dy
        point({ x, y }, path.owner, dx > 0 ? 8 : dx < 0 ? 2 : dy > 0 ? 1 : 4, path)
      }
    }
    for (const [marker, a, b] of [[path.startMarker, path.points[0], path.points[1]],
      [path.endMarker, path.points.at(-1), path.points.at(-2)]] as const) {
      if (!marker || !a || !b) continue
      const open = marker === "open" || marker === "triangle"
      const text = marker === "diamond" ? "◇" : marker === "filled-diamond" ? "◆"
        : a.x > b.x ? open ? "▷" : "▶" : a.x < b.x ? open ? "◁" : "◀" : a.y > b.y ? open ? "▽" : "▼" : open ? "△" : "▲"
      markers.set(`${a.x},${a.y}`, { text, tone: path.tone })
    }
  }
  for (const dot of scene.dots) markers.set(`${dot.x},${dot.y}`, { text: "●", tone: dot.tone })
  const glyphs = [" ", "│", "─", "└", "│", "│", "┌", "├", "─", "┘", "─", "┴", "┐", "┤", "┬", "┼"]
  const runs: Array<{ text: string; tone?: number }> = []
  const append = (text: string, tone?: number) => {
    const previous = runs.at(-1)
    if (previous && previous.tone === tone) previous.text += text
    else runs.push({ text, tone })
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const key = `${x},${y}`; const marker = markers.get(key)
      if (marker) { append(marker.text, marker.tone); continue }
      const owners = [...(cells.get(key)?.values() ?? [])]
      // Prefer an intact vertical overpass; do not OR masks across different nets.
      const route = owners.find((value) => value.mask === 5) ?? owners[0]
      if (!route) { append(" "); continue }
      const glyph = route.dashed && (route.mask === 5 || route.mask === 10) && (x + y) % 2 ? " " : glyphs[route.mask]
      append(glyph, route.tone)
    }
    if (y < height - 1) append("\n")
  }
  return runs
}
