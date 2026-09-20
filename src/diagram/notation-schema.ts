import { z } from "zod"

export const diagramID = z.string().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/)
export const diagramText = (max: number) => z.string().max(max).regex(/^[^\x00-\x1f\x7f-\x9f]*$/u)
const id = diagramID
const text = diagramText
const evidence = z.array(id).min(1).max(6)
const edge = z.number().int().min(0).max(47)
const version = z.literal(2)
const group = z.object({ id, label: text(60), kind: text(32), parent: id.nullable(), nodes: z.array(id).max(24), evidence }).strict()
const groups = z.array(group).max(12)
const cardinality = z.enum(["", "1", "0..1", "0..*", "1..*"])
const records = z.array(z.object({ node: id, members: z.array(z.object({ name: text(60), type: text(60),
  role: z.enum(["field", "method", "primary", "foreign"]), visibility: z.enum(["public", "protected", "private", "package"]) }).strict()).max(12), evidence }).strict()).max(24)
const relationships = z.array(z.object({ edge, kind: z.enum(["association", "dependency", "inheritance", "realization", "aggregation", "composition"]),
  fromCardinality: cardinality, toCardinality: cardinality, evidence }).strict()).max(48)

/** Additive, versioned notation payload. Legacy graphs omit it (or use null). */
export const NotationSchema = z.discriminatedUnion("family", [
  z.object({ version, family: z.literal("architecture"), groups,
    ports: z.array(z.object({ id, node: id, label: text(40), direction: z.enum(["input", "output", "inout", "passive", "power", "ground"]), evidence }).strict()).max(96),
    links: z.array(z.object({ edge, fromPort: id.nullable(), toPort: id.nullable(), direction: z.enum(["forward", "both", "none"]),
      role: z.enum(["signal", "data", "control", "power", "clock", "reset", "dependency", "containment", "association"]), evidence }).strict()).max(48),
  }).strict(),
  z.object({ version, family: z.literal("flowchart"), groups,
    steps: z.array(z.object({ node: id, shape: z.enum(["process", "decision", "start", "end", "fork", "join"]), evidence }).strict()).max(24),
    branches: z.array(z.object({ edge, condition: text(80), evidence }).strict()).max(48),
  }).strict(),
  z.object({ version, family: z.literal("state"), groups,
    states: z.array(z.object({ node: id, role: z.enum(["state", "initial", "final", "choice"]), evidence }).strict()).max(24),
    transitions: z.array(z.object({ edge, event: text(60), guard: text(80), action: text(80), evidence }).strict()).max(48),
  }).strict(),
  z.object({ version, family: z.literal("class"), records, relationships }).strict(),
  z.object({ version, family: z.literal("er"), records, relationships }).strict(),
  z.object({ version, family: z.literal("sequence"), participants: z.array(id).min(1).max(24),
    messages: z.array(z.object({ id, from: id, to: id, label: text(100), kind: z.enum(["sync", "async", "return"]), evidence }).strict()).max(48),
    activations: z.array(z.object({ node: id, from: edge, to: edge }).strict()).max(24),
    fragments: z.array(z.object({ id, kind: z.enum(["alt", "opt", "loop", "par"]), label: text(80), from: edge, to: edge, evidence }).strict()).max(12),
  }).strict(),
  z.object({ version, family: z.literal("timing"), unit: z.enum(["s", "ms", "us", "ns", "ticks"]), end: z.number().positive().max(1e12),
    signals: z.array(z.object({ node: id, mode: z.enum(["digital", "bus"]), initial: text(24).min(1),
      samples: z.array(z.object({ at: z.number().positive().max(1e12), value: text(24).min(1) }).strict()).max(64), evidence }).strict()).min(1).max(24),
  }).strict(),
  z.object({ version, family: z.literal("circuit"), groups,
    components: z.array(z.object({ node: id, reference: text(24).min(1), value: text(60),
      symbol: z.enum(["resistor", "capacitor", "inductor", "diode", "led", "transistor", "switch", "ground", "power", "power-flag", "ic", "connector", "generic"]),
      pins: z.array(z.object({ id, number: text(12).min(1), label: text(32),
        electrical: z.enum(["input", "output", "bidirectional", "passive", "power-in", "power-out", "open-drain", "unspecified"]), noConnect: z.boolean() }).strict()).min(1).max(32), evidence }).strict()).min(1).max(24),
    nets: z.array(z.object({ id, label: text(60), scope: id.nullable(),
      terminals: z.array(z.object({ node: id, pin: id }).strict()).min(1).max(96), evidence }).strict()).max(48),
  }).strict(),
])
export type DiagramNotation = z.infer<typeof NotationSchema>
type Graph = { nodes: { id: string }[]; edges: { from: string; to: string; label: string }[]; notation?: DiagramNotation | null }

/** Cross-reference validation is shared by models, public publication, RPC and storage. */
export function refineNotation(graph: Graph, ctx: z.RefinementCtx) {
  const n = graph.notation
  if (!n) return
  const fail = (message: string) => ctx.addIssue({ code: "custom", path: ["notation"], message })
  const nodes = new Set(graph.nodes.map((node) => node.id))
  const unique = (items: readonly string[], name: string) => { if (new Set(items).size !== items.length) fail(`Duplicate ${name}`) }
  const cover = (items: readonly string[]) => {
    unique(items, "notation node")
    if (items.length !== nodes.size || items.some((id) => !nodes.has(id))) fail("Notation must describe every graph node exactly once")
  }
  const edges = (items: { edge: number }[]) => {
    unique(items.map((item) => String(item.edge)), "edge annotation")
    if (items.length !== graph.edges.length || items.some((item) => item.edge >= graph.edges.length)) fail("Notation must describe every graph edge exactly once")
  }
  const membership = new Map<string, string>()
  if ("groups" in n) {
    unique(n.groups.map((group) => group.id), "group ID")
    const parents = new Map(n.groups.map((group) => [group.id, group.parent]))
    for (const group of n.groups) {
      if (nodes.has(group.id)) fail("Group and node IDs must be distinct")
      const seen = new Set<string>()
      let current: string | null | undefined = group.id
      while (current != null) {
        if (seen.has(current)) { fail("Cyclic group hierarchy"); break }
        seen.add(current)
        if (!parents.has(current)) { fail("Unknown parent group"); break }
        current = parents.get(current)
      }
      for (const node of group.nodes) {
        if (!nodes.has(node) || membership.has(node)) fail("Unknown or multiply grouped node")
        membership.set(node, group.id)
      }
    }
  }
  switch (n.family) {
    case "architecture": {
      unique(n.ports.map((port) => port.id), "port ID")
      const ports = new Map(n.ports.map((port) => [port.id, port]))
      for (const port of n.ports) if (!nodes.has(port.node)) fail("Unknown port owner")
      edges(n.links)
      for (const link of n.links) {
        const e = graph.edges[link.edge]
        if (!e) continue
        if (link.fromPort && ports.get(link.fromPort)?.node !== e.from) fail("Source port does not belong to source node")
        if (link.toPort && ports.get(link.toPort)?.node !== e.to) fail("Target port does not belong to target node")
      }
      break
    }
    case "flowchart": cover(n.steps.map((step) => step.node)); edges(n.branches); break
    case "state": cover(n.states.map((state) => state.node)); edges(n.transitions); break
    case "class": case "er": cover(n.records.map((record) => record.node)); edges(n.relationships); break
    case "sequence": {
      if (graph.edges.length) fail("Sequence uses ordered messages, not graph edges")
      cover(n.participants); unique(n.messages.map((message) => message.id), "message ID"); unique(n.fragments.map((fragment) => fragment.id), "fragment ID")
      for (const message of n.messages) if (!nodes.has(message.from) || !nodes.has(message.to)) fail("Unknown message participant")
      for (const range of [...n.activations, ...n.fragments]) if (range.from > range.to || range.to >= n.messages.length) fail("Invalid message range")
      for (const activation of n.activations) if (!nodes.has(activation.node)) fail("Unknown activation participant")
      for (let i = 0; i < n.fragments.length; i++) for (const other of n.fragments.slice(i + 1)) {
        const a = n.fragments[i]
        if (a.from < other.from && other.from <= a.to && a.to < other.to || other.from < a.from && a.from <= other.to && other.to < a.to) fail("Interaction fragments may nest, not partially overlap")
      }
      break
    }
    case "timing": {
      if (graph.edges.length) fail("Timing uses signal samples, not graph edges")
      cover(n.signals.map((signal) => signal.node))
      if (n.signals.reduce((sum, signal) => sum + signal.samples.length, 0) > 256) fail("Too many timing samples")
      for (const signal of n.signals) {
        if (signal.mode === "digital" && [signal.initial, ...signal.samples.map((sample) => sample.value)].some((value) => !["0", "1", "X", "Z"].includes(value))) fail("Digital values must be 0, 1, X or Z")
        let previous = 0
        for (const sample of signal.samples) {
          if (sample.at <= previous || sample.at >= n.end) fail("Timing samples must increase strictly inside the time range")
          previous = sample.at
        }
      }
      break
    }
    case "circuit": {
      if (graph.edges.length) fail("Circuits use explicit pin/net membership, not graph edges")
      cover(n.components.map((component) => component.node)); unique(n.nets.map((net) => net.id), "net ID")
      unique(n.components.map((component) => JSON.stringify([membership.get(component.node), component.reference])), "component reference within sheet")
      if (n.components.reduce((sum, component) => sum + component.pins.length, 0) > 96) fail("Too many circuit pins")
      const pins = new Map(n.components.flatMap((component) => {
        unique(component.pins.map((pin) => pin.id), "component pin ID")
        unique(component.pins.map((pin) => pin.number), "component pin number")
        return component.pins.map((pin) => [JSON.stringify([component.node, pin.id]), pin] as const)
      }))
      const connected = new Set<string>()
      const parents = new Map(n.groups.map((group) => [group.id, group.parent]))
      for (const net of n.nets) {
        if (net.scope && !parents.has(net.scope)) fail("Unknown net scope")
        for (const terminal of net.terminals) {
          const key = JSON.stringify([terminal.node, terminal.pin]); const pin = pins.get(key)
          if (!pin || pin.noConnect) fail("Unknown or explicitly unconnected net pin")
          if (connected.has(key)) fail("A pin must belong to exactly one net, with no duplicate terminals")
          connected.add(key)
          if (net.scope) {
            let group = membership.get(terminal.node); const visited = new Set<string>()
            while (group && group !== net.scope && !visited.has(group)) { visited.add(group); group = parents.get(group) ?? undefined }
            if (group !== net.scope) fail("Local net terminal is outside its sheet scope")
          }
        }
      }
    }
  }
}
