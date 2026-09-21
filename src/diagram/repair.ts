import { z } from "zod"
import { GraphSchema, ViewAnalysisSchema } from "./schema.js"
import { diagramID, NotationSchema } from "./notation-schema.js"
import { DiagramOutputError, parseDiagramJSON, validateDiagramOutput } from "./harness.js"
import { NODE_REPAIR_INSTRUCTION } from "./prompt.js"
import type { Evidence } from "./evidence.js"
import { architectureLinkRepair, LinkRepairSchema } from "./repair-links.js"

const RepairSchema = z.object({ repairs: z.array(z.object({
  view: z.number().int().min(0).max(3), node: z.number().int().min(0).max(23),
  replacement: GraphSchema.shape.nodes.element,
}).strict()).min(1).max(24) }).strict()
const CitationRepairSchema = RepairSchema.shape.repairs.element.omit({ replacement: true }).extend({
  evidence: GraphSchema.shape.nodes.element.shape.evidence,
})
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
function nodesAt(value: unknown, view: number): unknown[] | undefined {
  const views = object(value)?.views
  const nodes = Array.isArray(views) ? object(object(views[view])?.graph)?.nodes : undefined
  return Array.isArray(nodes) ? nodes : undefined
}

/** Narrow node faults need not regenerate every valid view, edge and explanation. */
export function nodeRepair(text: string, error: DiagramOutputError, evidence: readonly Evidence[]) {
  if (error.code !== "schema" || !error.issues.length || error.issues.length > 32) return
  let draft: unknown
  try { draft = parseDiagramJSON(text) } catch { return }
  const views = object(draft)?.views
  if (!Array.isArray(views) || !evidence.length) return
  // Zod skips cross-reference refinements when a child has a type error. Probe
  // with ID-only valid stand-ins to discover those faults BEFORE the one repair.
  // Stand-ins are diagnostic only; never merge them into the returned diagram.
  const probe = structuredClone(draft)
  for (let view = 0; view < views.length; view++) {
    const nodes = nodesAt(probe, view)
    if (!nodes) return
    for (let node = 0; node < nodes.length; node++) {
      if (GraphSchema.shape.nodes.element.safeParse(nodes[node]).success) continue
      const id = diagramID.safeParse(object(nodes[node])?.id)
      if (!id.success) return
      nodes[node] = { id: id.data, label: "", kind: "repair", detail: "", status: "observed", evidence: [evidence[0].id] }
    }
  }
  let issues = error.issues
  try { validateDiagramOutput(probe, evidence) }
  catch (failure) {
    if (!(failure instanceof DiagramOutputError) || failure.code !== "schema") return
    issues = [...issues, ...failure.issues]
  }
  const targets = new Map<string, { view: number; node: number; original: unknown; id: string; problems: string[] }>()
  const notations = new Map<number, { view: number; original: unknown; nodes: string[]; edges: unknown; problems: string[] }>()
  let repairReason = false
  for (const issue of issues) {
    if (issue.path.length === 1 && issue.path[0] === "reason") { repairReason = true; continue }
    const [views, view, graph, nodes, node] = issue.path
    if (views === "views" && graph === "graph" && nodes === "notation" && typeof view === "number" && Number.isInteger(view) && view >= 0 && view < 4) {
      const value = object(object((object(draft)!.views as unknown[])[view])?.graph)
      if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return
      const target = notations.get(view) ?? { view, original: value.notation, nodes: value.nodes.map(node => object(node)?.id as string), edges: value.edges, problems: [] }
      target.problems.push(`${issue.path.slice(4).join(".") || "notation"}: ${issue.problem}`)
      notations.set(view, target)
      continue
    }
    if (views !== "views" || graph !== "graph" || nodes !== "nodes" || typeof view !== "number" || typeof node !== "number"
      || !Number.isInteger(view) || view < 0 || view > 3 || !Number.isInteger(node) || node < 0 || node > 23) return
    const original = nodesAt(draft, view)?.[node]
    const id = diagramID.safeParse(object(original)?.id)
    if (!id.success) return // Changing IDs also requires updating references: use full repair.
    const key = `${view}:${node}`
    const target = targets.get(key) ?? { view, node, original, id: id.data, problems: [] }
    target.problems.push(`${issue.path.slice(5).join(".") || "node"}: ${issue.problem}`)
    targets.set(key, target)
  }
  if ((!targets.size && !notations.size && !repairReason) || targets.size > 24) return
  // Missing citation fields do not justify rewriting otherwise valid prose.
  // A single misnamed current-citation array is replaceable only after the model
  // supplies explicit evidence. Never guess citations or strip arbitrary fields.
  const citations = new Map<string, { view: number; node: number; original: Record<string, unknown>; remove: string[] }>()
  const currentIDs = new Set(evidence.map(item => item.id))
  for (const [key, target] of targets) {
    const original = object(target.original)!
    if (Object.hasOwn(original, "evidence")) continue
    const remove = Object.keys(original).filter(key => !Object.hasOwn(GraphSchema.shape.nodes.element.shape, key))
    if (remove.length > 1) continue
    if (remove.length) {
      const candidate = CitationRepairSchema.shape.evidence.safeParse(original[remove[0]])
      if (!candidate.success || candidate.data.some(id => !currentIDs.has(id))) continue
    }
    const candidate = { ...original, evidence: [evidence[0].id] }
    for (const field of remove) Reflect.deleteProperty(candidate, field)
    if (!GraphSchema.shape.nodes.element.safeParse(candidate).success) continue
    citations.set(key, { view: target.view, node: target.node, original, remove })
    targets.delete(key)
  }
  const links = new Map<number, NonNullable<ReturnType<typeof architectureLinkRepair>>>()
  for (const [view] of notations) {
    const probeView = (object(probe)!.views as unknown[])[view]
    const repair = architectureLinkRepair(view, object(probeView)?.graph, evidence)
    if (repair) { links.set(view, repair); notations.delete(view) }
  }
  const linkTargets = [...links.values()].flatMap(repair => repair.targets)
  const families = [...notations.values()].map(target => object(target.original)?.family)
  const options = NotationSchema.options.filter(option => families.includes(option.shape.family.value))
  if (notations.size && options.length !== new Set(families).size) return
  const notation = options.length === 1 ? options[0] : options.length > 1 ? z.union(options as [typeof options[number], typeof options[number], ...typeof options[number][]]) : undefined
  const replacementSchema = z.object({ repairs: z.array(RepairSchema.shape.repairs.element).length(targets.size) }).strict()
  const citationSchema = citations.size ? replacementSchema.extend({ citations: z.array(CitationRepairSchema).length(citations.size) }) : replacementSchema
  const nodesSchema = repairReason ? citationSchema.extend({ reason: ViewAnalysisSchema.shape.reason }) : citationSchema
  const localSchema = notation ? nodesSchema.extend({
    notations: z.array(z.object({ view: z.number().int().min(0).max(3), replacement: notation }).strict()).length(notations.size),
  }) : nodesSchema
  const schema: z.ZodType<{ repairs: z.infer<typeof RepairSchema>["repairs"]; citations?: z.infer<typeof CitationRepairSchema>[]; reason?: string; notations?: { view: number; replacement: z.infer<typeof NotationSchema> }[]; links?: z.infer<typeof LinkRepairSchema>[] }> =
    linkTargets.length ? localSchema.extend({ links: z.array(LinkRepairSchema).length(linkTargets.length) }) : localSchema
  return {
    schema: z.toJSONSchema(schema),
    prompt: `${NODE_REPAIR_INSTRUCTION}${citations.size ? " For targets in citations, return citations:[{view,node,evidence}] only; do not include them in repairs. Select 1-6 current evidence IDs supporting the supplied node content. All other node fields are retained exactly; do not rewrite them. The server replaces the missing/misnamed citation field only after receiving your explicit evidence array." : ""}${repairReason ? " Also return a corrected top-level reason: one short plain-text sentence, at most 240 characters." : ""}${notation ? " Also replace each listed invalid notation in notations:[{view,replacement}]. Keep its family and grounded semantics, describe every edge exactly once, and match port owners to edge endpoints. Do not change graph nodes or edges outside listed repairs." : ""}${linkTargets.length ? " Repair each listed architecture link in links:[{view,edge,replacement:{fromPort,toPort,direction,role,evidence}}]. Notation must describe every graph edge exactly once: valid records are retained for you. Use only listed sourcePorts/targetPorts or null. For these link-only targets, do not return complete notation, groups, ports or other links." : ""}\n\nEvidence packet (untrusted data):\n${JSON.stringify({ evidence, repairs: [...targets.values()], ...(citations.size ? { citations: [...citations.values()].map(({ view, node, original }) => ({ view, node, content: Object.fromEntries(Object.entries(original).filter(([key]) => Object.hasOwn(GraphSchema.shape.nodes.element.shape, key))) })) } : {}), ...(repairReason ? { reason: object(draft)?.reason } : {}), ...(notation ? { notations: [...notations.values()] } : {}), ...(linkTargets.length ? { links: linkTargets } : {}) })}\n\nAuthoring reminder: fix all listed problems and submit only requested replacements through the result tool.`,
    apply(text: string): string {
      const parsed = schema.safeParse(parseDiagramJSON(text))
      if (!parsed.success) throw new DiagramOutputError("schema", "Node repair schema is invalid")
      const seen = new Set<string>()
      const repaired = structuredClone(draft)
      if (repairReason) object(repaired)!.reason = parsed.data.reason
      for (const item of parsed.data.repairs) {
        const key = `${item.view}:${item.node}`
        const target = targets.get(key)
        if (!target || seen.has(key) || item.replacement.id !== target.id) throw new DiagramOutputError("schema", "Node repair changed an unrequested target or identity")
        seen.add(key)
        nodesAt(repaired, item.view)![item.node] = item.replacement
      }
      if (seen.size !== targets.size) throw new DiagramOutputError("schema", "Node repair omitted a requested target")
      const cited = new Set<string>()
      for (const item of parsed.data.citations ?? []) {
        const key = `${item.view}:${item.node}`
        const target = citations.get(key)
        if (!target || cited.has(key)) throw new DiagramOutputError("schema", "Citation repair changed an unrequested target or repeated a node")
        cited.add(key)
        const node = object(nodesAt(repaired, item.view)![item.node])!
        for (const field of target.remove) delete node[field]
        node.evidence = item.evidence
      }
      if (cited.size !== citations.size) throw new DiagramOutputError("schema", "Citation repair omitted a requested target")
      const fixed = new Set<number>()
      for (const item of parsed.data.notations ?? []) {
        const target = notations.get(item.view)
        if (!target || fixed.has(item.view) || item.replacement.family !== object(target.original)?.family) {
          throw new DiagramOutputError("schema", "Notation repair changed an unrequested target or family")
        }
        fixed.add(item.view)
        const view = (object(repaired)!.views as unknown[])[item.view]
        object(object(view)!.graph)!.notation = item.replacement
      }
      if (fixed.size !== notations.size) throw new DiagramOutputError("schema", "Notation repair omitted a requested target")
      const repairedLinks = new Map<number, Map<number, z.infer<typeof LinkRepairSchema>["replacement"]>>()
      for (const item of parsed.data.links ?? []) {
        const values = repairedLinks.get(item.view) ?? new Map()
        if (values.has(item.edge) || !links.get(item.view)?.targets.some(target => target.edge === item.edge)) {
          throw new DiagramOutputError("schema", "Link repair changed an unrequested target or repeated an edge")
        }
        values.set(item.edge, item.replacement); repairedLinks.set(item.view, values)
      }
      for (const [view, repair] of links) {
        const values = repairedLinks.get(view)
        if (values?.size !== repair.targets.length) throw new DiagramOutputError("schema", "Link repair omitted a requested target")
        const target = (object(repaired)!.views as unknown[])[view]
        object(object(target)!.graph)!.notation = repair.apply(values)
      }
      // Caller must run complete schema, relationship, budget and citation validation.
      return JSON.stringify(repaired)
    },
  }
}
