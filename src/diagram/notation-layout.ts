import type { DiagramGraph } from "./schema.js"
import type { DiagramBox, DiagramLayout } from "./layout.js"
import { diagramTextWidth, wrapDiagramText } from "./diagram-text.js"
import { emptyScene, type DiagramScene } from "./scene.js"

type Line = DiagramBox["lines"][number]
const integer = (value: number) => Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
const textWidth = (text: string) => Math.max(1, integer(diagramTextWidth(text)))
const clone = (boxes: DiagramBox[]) => boxes.map((box) => ({ ...box, lines: box.lines.map((line) => ({ ...line })) }))
const bounds = (nodes: DiagramBox[], scene: DiagramScene): DiagramLayout => {
  const points = scene.paths.flatMap((path) => path.points).concat(scene.texts, scene.regions.flatMap((region) => [
    { x: region.x, y: region.y }, { x: region.x + region.width - 1, y: region.y + region.height - 1 },
  ]), scene.dots)
  const width = Math.max(1, ...nodes.map((box) => box.x + box.width), ...points.map((point) => point.x + 1),
    ...scene.texts.map((item) => item.x + textWidth(item.text)), ...scene.regions.map((item) => item.x + textWidth(item.label)))
  const height = Math.max(1, ...nodes.map((box) => box.y + box.height), ...points.map((point) => point.y + 1))
  return { nodes, edges: [], width: integer(width), height: integer(height), scene }
}
const card = (box: DiagramBox, x: number, y: number, lines = box.lines): DiagramBox => ({ ...box, x: integer(x), y: integer(y),
  width: Math.max(10, ...lines.map((line) => textWidth(line.text) + 4)), height: Math.max(2, lines.length + 2), lines })

function sequence(graph: DiagramGraph, boxes: DiagramBox[]): DiagramLayout {
  const notation = graph.notation!
  if (notation.family !== "sequence") throw new Error("Unexpected notation")
  const byNode = new Map(boxes.map((box) => [box.node.id, box]))
  const labelWidth = Math.max(10, ...notation.messages.map((message) => textWidth(message.label) + 4))
  const headers = notation.participants.map((id) => byNode.get(id)!)
  const slot = Math.max(labelWidth + 4, ...headers.map((box) => Math.max(10, box.width) + 6))
  const fragmentDepth = (fragment: typeof notation.fragments[number], index: number) => notation.fragments.filter((other, j) =>
    j !== index && other.from <= fragment.from && other.to >= fragment.to
      && (other.from < fragment.from || other.to > fragment.to || j < index)).length
  const depth = Math.max(0, ...notation.fragments.map(fragmentDepth))
  const nodes = headers.map((box, i) => card(box, 2 + depth * 2 + i * slot, 2))
  const center = new Map(nodes.map((box) => [box.node.id, box.x + Math.floor(box.width / 2)]))
  const headerBottom = Math.max(...nodes.map((box) => box.y + box.height))
  const scene = emptyScene()
  const messageRows: number[] = []; const starts = new Map<string, number>(); const ends = new Map<string, number>()
  let nextY = headerBottom + 2
  notation.messages.forEach((_, index) => {
    for (const fragment of notation.fragments.filter((fragment) => fragment.from === index).sort((a, b) => b.to - a.to)) {
      starts.set(fragment.id, nextY); nextY += 2
    }
    messageRows.push(nextY + 1); nextY += 4
    for (const fragment of notation.fragments.filter((fragment) => fragment.to === index).sort((a, b) => b.from - a.from)) {
      ends.set(fragment.id, nextY); nextY += 2
    }
  })
  const messageY = (index: number) => messageRows[index]
  const bottom = nextY + 2
  nodes.forEach((box) => scene.paths.push({ owner: `participant:${box.node.id}`, tone: 0, dashed: true,
    points: [{ x: center.get(box.node.id)!, y: box.y + box.height }, { x: center.get(box.node.id)!, y: bottom }] }))
  notation.messages.forEach((message, index) => {
    const y = messageY(index); const from = center.get(message.from)!; const to = center.get(message.to)!
    const marker = message.kind === "sync" ? "arrow" : "open"
    const path = from === to ? [{ x: from, y }, { x: from + 3, y }, { x: from + 3, y: y + 1 }, { x: from, y: y + 1 }]
      : [{ x: from, y }, { x: to, y }]
    scene.paths.push({ owner: `message:${message.id}`, points: path, dashed: message.kind === "return", endMarker: marker })
    const left = Math.min(from, to)
    scene.texts.push({ x: left + (from === to ? 4 : 1), y: y - 1, text: message.label, tone: 1 })
  })
  notation.fragments.forEach((fragment, index) => {
    const y = starts.get(fragment.id)!
    const label = `${fragment.kind} ${fragment.label}`.trim()
    const x = fragmentDepth(fragment, index) * 2
    const right = Math.max(nodes.at(-1)!.x + nodes.at(-1)!.width, ...scene.texts.map((text) => text.x + textWidth(text.text))) + 2
    scene.regions.push({ x, y, width: Math.max(textWidth(label) + 4, right - x),
      height: ends.get(fragment.id)! - y + 1, label, style: "fragment" })
  })
  notation.activations.forEach((activation) => {
    const x = center.get(activation.node)! + 1; const y = messageY(activation.from) - 1
    scene.regions.push({ x, y, width: 2, height: messageY(activation.to) - y + 2, label: "", style: "activation" })
  })
  return bounds(nodes, scene)
}

function timing(graph: DiagramGraph, boxes: DiagramBox[], columns: number): DiagramLayout {
  const notation = graph.notation!
  if (notation.family !== "timing") throw new Error("Unexpected notation")
  const byNode = new Map(boxes.map((box) => [box.node.id, box]))
  const times = [0, ...notation.signals.flatMap((signal) => signal.samples.map((sample) => sample.at)), notation.end]
    .filter((time, index, all) => all.indexOf(time) === index).sort((a, b) => a - b)
  const valueWidth = new Map<number, number>()
  for (const time of times) valueWidth.set(time, textWidth(`t=${time}${notation.unit}`))
  for (const signal of notation.signals) {
    let value = signal.initial
    for (const time of times) {
      const sample = signal.samples.find((item) => item.at === time)
      if (sample) value = sample.value
      valueWidth.set(time, Math.max(valueWidth.get(time)!, textWidth(value)))
    }
  }
  const x = new Map<number, number>(); let cursor = 0
  for (const time of times) { x.set(time, cursor); cursor += valueWidth.get(time)! + 3 }
  const plotWidth = Math.max(32, cursor, Math.max(20, Math.min(500, integer(columns))))
  const left = Math.max(...notation.signals.map((signal) => Math.max(byNode.get(signal.node)!.width, textWidth(signal.node) + 4))) + 3
  const scene = emptyScene(); const nodes: DiagramBox[] = []; let y = 5
  scene.texts.push({ x: left, y: 0, text: "Event-spaced timing (not to scale)" })
  notation.signals.forEach((signal) => {
    const box = card(byNode.get(signal.node)!, 1, y)
    nodes.push(box)
    const mid = y + Math.max(2, Math.floor(box.height / 2)); const high = mid - 1; const low = mid + 1
    const level = (value: string) => value === "1" ? high : value === "0" ? low : mid
    let value = signal.initial; let at = 0
    const show = (from: number, to: number, current: string) => {
      const a = left + x.get(from)!; const b = left + x.get(to)!
      if (signal.mode === "bus") {
        scene.paths.push({ owner: `signal:${signal.node}`, points: [{ x: a, y: mid - 1 }, { x: b, y: mid - 1 }, { x: b, y: mid + 1 }, { x: a, y: mid + 1 }, { x: a, y: mid - 1 }] })
        scene.texts.push({ x: a + 1, y: mid, text: current, node: signal.node })
      } else if (current === "X" || current === "Z") {
        scene.paths.push({ owner: `signal:${signal.node}`, dashed: true, points: [{ x: a, y: mid }, { x: b, y: mid }] })
        scene.texts.push({ x: a + 1, y: mid - 1, text: current, node: signal.node })
      } else scene.paths.push({ owner: `signal:${signal.node}`, points: [{ x: a, y: level(current) }, { x: b, y: level(current) }] })
    }
    for (const sample of signal.samples) {
      show(at, sample.at, value)
      if (signal.mode === "digital" && value !== sample.value) scene.paths.push({ owner: `signal:${signal.node}`,
        points: [{ x: left + x.get(sample.at)!, y: level(value) }, { x: left + x.get(sample.at)!, y: level(sample.value) }] })
      value = sample.value; at = sample.at
    }
    show(at, notation.end, value)
    y += Math.max(box.height + 3, 6)
  })
  scene.paths.push({ owner: "time-axis", tone: 0, points: [{ x: left, y: 3 }, { x: left + plotWidth, y: 3 }] })
  times.forEach((time) => scene.texts.push({ x: left + x.get(time)!, y: 1, text: `t=${time}${notation.unit}`, tone: 0 }))
  return bounds(nodes, scene)
}

function circuit(graph: DiagramGraph, boxes: DiagramBox[]): DiagramLayout {
  const notation = graph.notation!
  if (notation.family !== "circuit") throw new Error("Unexpected notation")
  const byNode = new Map(boxes.map((box) => [box.node.id, box]))
  const connected = new Set(notation.nets.flatMap((net) => net.terminals.map((terminal) => `${terminal.node}\u0000${terminal.pin}`)))
  const netLabels = notation.nets.map((net) => wrapDiagramText(`${net.scope ?? "global"}:${net.label || net.id}`, 24))
  const nodes: DiagramBox[] = []; let y = netLabels.reduce((sum, lines) => sum + lines.length + 1, 0) + 3; let right = 0
  const pins = new Map<string, number>()
  const scene = emptyScene()
  const symbols: Record<typeof notation.components[number]["symbol"], string> = {
    resistor: "─[R]─", capacitor: "─| |─", inductor: "─∿∿─", diode: "─▷|─", led: "─▷|─ ↗", transistor: "[Q]",
    switch: "─o/ o─", ground: "⏚", power: "↑ V", "power-flag": "⚑ ERC", ic: "[IC]", connector: "[J]", generic: "[?]",
  }
  const place = (component: typeof notation.components[number], depth: number) => {
    const base = byNode.get(component.node)!
    const lines: Line[] = [...base.lines, { text: `${symbols[component.symbol]} ${component.reference}${component.value ? ` · ${component.value}` : ""}`, role: "meta" }]
    for (const pin of component.pins) lines.push({ text: `${pin.number} ${pin.label || "pin"} · ${pin.electrical}${pin.noConnect ? " · NC" : connected.has(`${component.node}\u0000${pin.id}`) ? "" : " · unassigned"}`, role: "detail" })
    const box = card(base, 2 + depth * 3, y, lines); nodes.push(box); right = Math.max(right, box.x + box.width)
    component.pins.forEach((pin, index) => pins.set(`${component.node}\u0000${pin.id}`, box.y + base.lines.length + 2 + index))
    y += box.height + 2
  }
  const grouped = new Set(notation.groups.flatMap((group) => group.nodes))
  for (const component of notation.components) if (!grouped.has(component.node)) place(component, 0)
  const placeGroup = (group: typeof notation.groups[number], depth: number) => {
    const top = y; const first = nodes.length; y += 2
    for (const component of notation.components) if (group.nodes.includes(component.node)) place(component, depth + 1)
    for (const child of notation.groups) if (child.parent === group.id) placeGroup(child, depth + 1)
    const label = `${group.label} (${group.kind})`
    const x = 1 + depth * 3
    const end = Math.max(x + textWidth(label) + 4, ...nodes.slice(first).map((box) => box.x + box.width + 2))
    scene.regions.push({ x, y: top, width: end - x, height: y - top + 1, label, style: "group" })
    right = Math.max(right, end); y += 3
  }
  for (const group of notation.groups) if (!group.parent) placeGroup(group, 0)
  let headerY = 0
  notation.nets.forEach((net, index) => {
    const railX = right + 5 + index * 3
    netLabels[index].forEach((text, i) => scene.texts.push({ x: railX + 1, y: headerY + i, text, tone: index % 8 }))
    const labelBottom = headerY + netLabels[index].length
    headerY = labelBottom + 1
    const ys = net.terminals.map((terminal) => pins.get(`${terminal.node}\u0000${terminal.pin}`)!).sort((a, b) => a - b)
    if (ys.length) scene.paths.push({ owner: `net:${net.id}`, tone: index % 8, points: [{ x: railX, y: labelBottom }, { x: railX, y: ys.at(-1)! }] })
    net.terminals.forEach((terminal) => {
      const pinY = pins.get(`${terminal.node}\u0000${terminal.pin}`)!; const box = nodes.find((item) => item.node.id === terminal.node)!
      scene.paths.push({ owner: `net:${net.id}`, tone: index % 8, startBoundary: "left", points: [{ x: box.x + box.width, y: pinY }, { x: railX, y: pinY }] })
      scene.dots.push({ x: railX, y: pinY, owner: `net:${net.id}`, tone: index % 8 })
    })
  })
  return bounds(nodes, scene)
}

/** First-class notation geometry. Legacy and compound-ELK families remain elsewhere. */
export function layoutNotation(graph: DiagramGraph, boxes: DiagramBox[], columns: number): DiagramLayout | undefined {
  if (!graph.notation || ["architecture", "flowchart", "state", "class", "er"].includes(graph.notation.family)) return undefined
  const copied = clone(boxes)
  switch (graph.notation.family) {
    case "sequence": return sequence(graph, copied)
    case "timing": return timing(graph, copied, columns)
    case "circuit": return circuit(graph, copied)
  }
}
