import type { DiagramGraph } from "./schema.js"

/** Traverse schema-owned citation arrays, including pins/nets/messages/groups. */
function visitEvidence(value: unknown, visit: (ids: string[]) => void) {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) { value.forEach((item) => visitEvidence(item, visit)); return }
  for (const [key, item] of Object.entries(value)) {
    if (key === "evidence" && Array.isArray(item)) visit(item)
    else visitEvidence(item, visit)
  }
}
export function diagramEvidence(graph: DiagramGraph): string[] {
  const result = new Set<string>()
  visitEvidence(graph, (ids) => ids.forEach((id) => result.add(id)))
  return [...result]
}
export function mapDiagramEvidence(graph: DiagramGraph, map: (ids: string[]) => string[]): DiagramGraph {
  const result = structuredClone(graph)
  // structuredClone preserves shared references. Map a shared citation array
  // once, otherwise a second visit can mistake newly mapped IDs for old ones.
  const mapped = new WeakSet<string[]>()
  visitEvidence(result, (ids) => {
    if (mapped.has(ids)) return
    mapped.add(ids)
    ids.splice(0, ids.length, ...map(ids))
  })
  return result
}

/** Metadata affecting a node, including relations not expressible as block edges. */
export function nodeNotation(graph: DiagramGraph, id: string): unknown {
  const n = graph.notation
  if (!n) return null
  const incident = (index: number) => graph.edges[index]?.from === id || graph.edges[index]?.to === id
  const groups = "groups" in n ? n.groups : []
  const groupIDs = new Set(groups.filter((group) => group.nodes.includes(id)).map((group) => group.id))
  for (let i = 0; i < groups.length; i++) for (const group of groups) if (groupIDs.has(group.id) && group.parent) groupIDs.add(group.parent)
  const parents = groups.filter((group) => groupIDs.has(group.id))
  let detail: unknown
  switch (n.family) {
    case "architecture": detail = [n.ports.filter((port) => port.node === id), n.links.filter((link) => incident(link.edge)), parents]; break
    case "flowchart": detail = [n.steps.filter((step) => step.node === id), n.branches.filter((branch) => incident(branch.edge)), parents]; break
    case "state": detail = [n.states.filter((state) => state.node === id), n.transitions.filter((transition) => incident(transition.edge)), parents]; break
    case "class": case "er": detail = [n.records.filter((record) => record.node === id), n.relationships.filter((relation) => incident(relation.edge))]; break
    case "sequence": detail = [n.participants.indexOf(id), n.messages.flatMap((message, index) => message.from === id || message.to === id ? [{ index, ...message }] : []), n.activations.filter((activation) => activation.node === id), n.fragments]; break
    case "timing": detail = [n.unit, n.end, n.signals.filter((signal) => signal.node === id)]; break
    case "circuit": detail = [n.components.filter((component) => component.node === id), n.nets.filter((net) => net.terminals.some((terminal) => terminal.node === id)), parents]; break
  }
  return [n.version, n.family, detail]
}
export function nodeEvidence(graph: DiagramGraph, id: string): string[] {
  const result = new Set(graph.nodes.find((node) => node.id === id)?.evidence ?? [])
  visitEvidence(nodeNotation(graph, id), (ids) => ids.forEach((source) => result.add(source)))
  return [...result]
}
export function notationSignature(graph: DiagramGraph, id: string): string {
  return JSON.stringify(nodeNotation(graph, id), (key, value) => key === "evidence" ? undefined : value)
}

export function notationNodeLines(graph: DiagramGraph, id: string): string[] {
  const n = graph.notation
  if (!n) return []
  if (n.family === "architecture") return n.ports.filter((port) => port.node === id).map((port) => `${port.direction}: ${port.label}`)
  if (n.family === "flowchart") return [{ process: "Process", decision: "◇ Decision", start: "● Start", end: "◎ End", fork: "━ Fork", join: "━ Join" }[n.steps.find((step) => step.node === id)!.shape]]
  if (n.family === "state") return [{ state: "State", initial: "● Initial", final: "◎ Final", choice: "◇ Choice" }[n.states.find((state) => state.node === id)!.role]]
  if (n.family === "class" || n.family === "er") return n.records.find((record) => record.node === id)!.members.map((member) =>
    `${({ public: "+", protected: "#", private: "-", package: "~" })[member.visibility]} ${member.name}${member.role === "method" ? "()" : ""}: ${member.type}${member.role === "primary" ? " [PK]" : member.role === "foreign" ? " [FK]" : ""}`)
  return []
}
export function notationEdgeLabel(graph: DiagramGraph, index: number): string {
  const edge = graph.edges[index]; const n = graph.notation
  if (!n) return edge.label
  const join = (...parts: string[]) => [...new Set(parts.filter(Boolean))].join(" · ")
  if (n.family === "architecture") {
    const link = n.links.find((link) => link.edge === index)!
    const from = n.ports.find((port) => port.id === link.fromPort)?.label
    const to = n.ports.find((port) => port.id === link.toPort)?.label
    return join(edge.label, link.role, from || to ? `${from ?? edge.from} ${link.direction === "both" ? "↔" : link.direction === "none" ? "—" : "→"} ${to ?? edge.to}` : "")
  }
  if (n.family === "flowchart") return join(edge.label, n.branches.find((branch) => branch.edge === index)!.condition)
  if (n.family === "state") {
    const transition = n.transitions.find((transition) => transition.edge === index)!
    return join(edge.label, [transition.event, transition.guard ? `[${transition.guard}]` : "", transition.action ? `/ ${transition.action}` : ""].filter(Boolean).join(" "))
  }
  if (n.family === "class" || n.family === "er") {
    const relation = n.relationships.find((relation) => relation.edge === index)!
    return join(edge.label, relation.kind, relation.fromCardinality || relation.toCardinality ? `${relation.fromCardinality || "?"} : ${relation.toCardinality || "?"}` : "")
  }
  return edge.label
}
