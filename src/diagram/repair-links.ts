import { z } from "zod"
import { GraphSchema } from "./schema.js"
import { NotationSchema } from "./notation-schema.js"
import type { Evidence } from "./evidence.js"

const Architecture = NotationSchema.options[0]
const Link = Architecture.shape.links.element
export const LinkReplacement = Link.omit({ edge: true })
export const LinkRepairSchema = z.object({ view: z.number().int().min(0).max(3), edge: z.number().int().min(0).max(47), replacement: LinkReplacement }).strict()
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Repair bad architecture annotations, not every otherwise valid port/group/link. */
export function architectureLinkRepair(view: number, graph: unknown, evidence: readonly Evidence[]) {
  const value = object(graph), notation = object(value?.notation)
  if (!value || notation?.family !== "architecture" || !Array.isArray(value.edges) || !Array.isArray(notation.links)) return
  const edges = value.edges
  // Caller supplies diagnostic node stand-ins. This check gates the narrow path
  // on valid groups and port owners; none of its parsed nodes enter the result.
  const base = GraphSchema.safeParse({ ...value, edges: [], notation: { ...notation, links: [] } })
  if (!base.success || base.data.notation?.family !== "architecture") return
  const ports = base.data.notation.ports
  const ids = new Set(evidence.map(item => item.id))
  const original = notation.links
  const keep = new Map<number, z.infer<typeof Link>>()
  const targets: { view: number; edge: number; connection: unknown; original: unknown[]; sourcePorts: typeof ports; targetPorts: typeof ports }[] = []
  for (const [edge, connection] of edges.entries()) {
    const endpoints = object(connection)
    if (!endpoints || typeof endpoints.from !== "string" || typeof endpoints.to !== "string") return
    const matches = original.filter(item => object(item)?.edge === edge)
    const parsed = matches.length === 1 ? Link.safeParse(matches[0]) : undefined
    const sourcePorts = ports.filter(port => port.node === endpoints.from)
    const targetPorts = ports.filter(port => port.node === endpoints.to)
    if (parsed?.success && (parsed.data.fromPort === null || sourcePorts.some(port => port.id === parsed.data.fromPort))
      && (parsed.data.toPort === null || targetPorts.some(port => port.id === parsed.data.toPort)) && parsed.data.evidence.every(id => ids.has(id))) {
      keep.set(edge, parsed.data)
    } else targets.push({ view, edge, connection, original: matches, sourcePorts, targetPorts })
  }
  if (!targets.length) return // A stray extra record alone uses complete notation repair.
  return {
    targets,
    apply(replacements: Map<number, z.infer<typeof LinkReplacement>>) {
      // Every graph edge has exactly one old validated or requested new record.
      // The caller rejects missing, duplicate and unrequested replacements first.
      return { ...notation, links: edges.map((_, edge) => keep.get(edge) ?? { edge, ...replacements.get(edge)! }) }
    },
  }
}
