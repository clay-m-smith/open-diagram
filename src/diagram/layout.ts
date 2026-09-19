import type { DiagramGraph } from "./schema.js"

export interface DiagramLink {
  from: string
  to: string
  label: string
  cycle: boolean
  text: string
}

export interface DiagramBlock {
  node: DiagramGraph["nodes"][number]
  number: number
  incoming: string
  outgoing: DiagramLink[]
}

/**
 * A vertical, port-labelled graph. Each outgoing arrow names both endpoints;
 * adjacent blocks have no implicit connection. Numbered ports keep wide forks
 * readable in a narrow panel without eliding any node, edge, or edge label.
 */
export function layoutDiagram(graph: DiagramGraph): DiagramBlock[] {
  const numbers = new Map(graph.nodes.map((node, index) => [node.id, index + 1]))
  const outgoing = new Map<string, DiagramGraph["edges"]>()
  const incoming = new Map<string, DiagramGraph["edges"]>()
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge])
  }
  const reaches = (start: string, target: string): boolean => {
    const pending = [start]
    const visited = new Set<string>()
    while (pending.length) {
      const id = pending.pop()!
      if (id === target) return true
      if (visited.has(id)) continue
      visited.add(id)
      for (const edge of outgoing.get(id) ?? []) pending.push(edge.to)
    }
    return false
  }

  return graph.nodes.map((node, index) => {
    const inputs = incoming.get(node.id) ?? []
    const outputs = outgoing.get(node.id) ?? []
    const inputPorts = [...new Set(inputs.map((edge) => `[${numbers.get(edge.from)}]`))]
    return {
      node,
      number: index + 1,
      incoming: inputs.length
        ? `${inputPorts.length > 1 ? "join" : "in"} ◀── ${inputPorts.join(", ")}`
        : "no incoming edges",
      outgoing: outputs.map((edge, edgeIndex) => {
        const cycle = reaches(edge.to, edge.from)
        return {
          ...edge,
          cycle,
          text: `${edgeIndex === outputs.length - 1 ? "└" : "├"}─ [${index + 1}] ──▶ [${numbers.get(edge.to)}]${edge.label ? ` · ${edge.label}` : ""}${cycle ? " · ↺ cycle" : ""}`,
        }
      }),
    }
  })
}
