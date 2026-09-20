import { diagramArrowColor } from "./arrow-colors.js"
import { diagramTextWidth } from "./diagram-text.js"
import type { DiagramScene, SceneMarker } from "./scene.js"

export function sceneMarkerSVG(id: string, marker: SceneMarker, color: string, background: string, start = false) {
  const d = marker === "diamond" || marker === "filled-diamond" ? "M0,5 L5,0 L10,5 L5,10 Z"
    : marker === "open" ? "M0,0 L10,5 L0,10" : "M0,0 L10,5 L0,10 Z"
  const fill = marker === "open" ? "none" : marker === "diamond" || marker === "triangle" ? background : color
  // resvg 2.6.2 does not rotate auto-start-reverse markers. Use supported auto
  // orientation and reverse start glyphs explicitly (including their anchor).
  return `<marker id="${id}" viewBox="0 0 10 10" refX="${start ? 1 : 9}" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="${d}"${start ? ' transform="translate(10 0) scale(-1 1)"' : ""} fill="${fill}" stroke="${color}" stroke-width="1.3"/></marker>`
}

export function renderSceneSVG(scene: DiagramScene, options: {
  left: number; top: number; cell: number; line: number; dark: boolean
  border: string; text: string; subdued: string; card: string; background: string
  escape(value: string): string
}): string {
  const { left, top, cell, line, escape } = options
  const x = (value: number) => left + (value + 0.5) * cell
  const y = (value: number) => top + (value + 0.5) * line
  const tone = (value?: number) => value === undefined ? options.subdued : diagramArrowColor(value, options.dark)
  const elements: string[] = []
  for (const region of scene.regions) {
    elements.push(`<rect x="${left + region.x * cell}" y="${top + region.y * line}" width="${region.width * cell}" height="${region.height * line}" fill="${region.style === "activation" ? options.card : "none"}" stroke="${options.border}"${region.style === "group" ? ' stroke-dasharray="6 4"' : ""}/>`)
    if (region.label) elements.push(`<text x="${x(region.x + 1)}" y="${y(region.y) + 6}" fill="${options.subdued}">${escape(region.label)}</text>`)
  }
  scene.paths.forEach((path, index) => {
    const color = tone(path.tone); let markers = ""
    for (const [marker, position] of [[path.startMarker, "start"], [path.endMarker, "end"]] as const) {
      if (!marker) continue
      const id = `scene-${index}-${position}`
      elements.push(`<defs>${sceneMarkerSVG(id, marker, color, options.background, position === "start")}</defs>`)
      markers += ` marker-${position}="url(#${id})"`
    }
    const points = path.points.map((point) => ({ x: x(point.x), y: y(point.y) }))
    if (path.startBoundary && points[0]) {
      if (path.startBoundary === "left") points[0].x -= cell / 2
      else if (path.startBoundary === "right") points[0].x += cell / 2
      else if (path.startBoundary === "top") points[0].y -= line / 2
      else points[0].y += line / 2
    }
    elements.push(`<path data-owner="${escape(path.owner)}" d="${points.map((point, i) => `${i ? "L" : "M"}${point.x},${point.y}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2"${path.dashed ? ' stroke-dasharray="5 4"' : ""}${markers}/>`)
  })
  for (const dot of scene.dots) elements.push(`<circle data-net="${escape(dot.owner)}" cx="${x(dot.x)}" cy="${y(dot.y)}" r="4" fill="${tone(dot.tone)}"/>`)
  for (const label of scene.texts) elements.push(`<text x="${left + label.x * cell}" y="${top + (label.y + 0.8) * line}" fill="${tone(label.tone)}" textLength="${diagramTextWidth(label.text) * cell}" lengthAdjust="spacingAndGlyphs">${escape(label.text)}</text>`)
  return elements.join("")
}
