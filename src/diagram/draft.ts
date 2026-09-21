import { z } from "zod"
import type { Evidence } from "./evidence.js"
import { GraphSchema } from "./schema.js"
import { DiagramOutputError, nativeDiagramOutputSchema, parseDiagramJSON } from "./harness.js"

const nodeCollections: Record<string, string> = { flowchart: "steps", state: "states", class: "records", er: "records" }
const edgeCollections: Record<string, string> = { architecture: "links", flowchart: "branches", state: "transitions", class: "relationships", er: "relationships" }
const defaultsSchema = z.object({ status: GraphSchema.shape.nodes.element.shape.status, evidence: GraphSchema.shape.nodes.element.shape.evidence }).strict()
const object = (value: unknown): Record<string, any> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined
function fail(message: string): never { throw new DiagramOutputError("schema", `Invalid diagram draft: ${message}`) }

/** Authoring syntax only. Public schemas, persistence and renderers stay canonical. */
export function draftOutputSchema(evidence: readonly Evidence[]) {
  const schema = nativeDiagramOutputSchema() as Record<string, any>
  const defs = schema.$defs as Record<string, any>
  const resolve = (value: any): any => value?.$ref ? defs[value.$ref.split("/").at(-1)] : value
  const graph = schema.properties.views.items.properties.graph
  const node = graph.properties.nodes.items
  const edge = graph.properties.edges.items
  const variants = graph.properties.notation.anyOf[0].anyOf
  const without = (value: any, key: string) => {
    delete value.properties[key]
    value.required = value.required?.filter((name: string) => name !== key)
  }
  const annotations = { node: [] as any[], edge: [] as any[] }
  for (const variant of variants) {
    const family = variant.properties.family.const
    variant.required = variant.required.filter((key: string) => key !== "version")
    for (const [identity, collection] of [["node", nodeCollections[family]], ["edge", edgeCollections[family]]] as const) {
      if (!collection) continue
      const annotation = structuredClone(resolve(resolve(variant.properties[collection]).items))
      without(annotation, identity)
      if (!annotations[identity].some(existing => JSON.stringify(existing) === JSON.stringify(annotation))) annotations[identity].push(annotation)
      without(variant, collection)
    }
  }
  node.properties.annotation = { description: "Flowchart shape, state role, or class/ER members for THIS node. Omit for other families.", anyOf: annotations.node }
  edge.properties.annotation = { description: "Family-specific metadata for THIS edge. Required for architecture, flowchart, state, class and ER; no numeric edge index.", anyOf: annotations.edge }
  node.required = node.required.filter((key: string) => key !== "status")
  // Citation IDs get their own constrained definition, not the schema for node IDs.
  const visit = (value: any, callback: (value: any) => void) => {
    if (!value || typeof value !== "object") return
    callback(value)
    for (const item of Object.values(value)) if (Array.isArray(item)) item.forEach(entry => visit(entry, callback)); else visit(item, callback)
  }
  visit(schema, value => {
    if (!value.properties?.evidence) return
    value.properties.evidence = { $ref: "#/$defs/EvidenceIDs" }
    value.required = value.required?.filter((key: string) => key !== "evidence")
  })
  defs.EvidenceIDs = { description: "Current source IDs. Omitted evidence inherits graph.defaults.evidence; override when sources differ.", type: "array", minItems: 1, maxItems: 6, items: { type: "string", ...(evidence.length ? { enum: evidence.map(item => item.id) } : {}) } }
  graph.properties = { defaults: { type: "object", additionalProperties: false, required: ["status", "evidence"],
    description: "Explicit shared values. Each omitted status/evidence inherits this value; use per-record overrides for different sources or status.",
    properties: { status: node.properties.status, evidence: { $ref: "#/$defs/EvidenceIDs" } } },
    notation: graph.properties.notation, ...Object.fromEntries(Object.entries(graph.properties).filter(([key]) => key !== "notation")) }
  graph.required.unshift("defaults")
  const column = (title: string, schema: any) => ({ title, ...schema })
  graph.properties.nodes.items = { type: "array", minItems: 5, maxItems: 6, items: false,
    description: "Node row: [id, label, kind, detail, behavior, overrides?]. Null behavior means unsupported. Overrides may contain status, evidence and family annotation.",
    prefixItems: [column("id", node.properties.id), column("label", node.properties.label), column("kind", node.properties.kind), column("detail", node.properties.detail),
      { title: "behavior", anyOf: [node.properties.behavior, { type: "null" }] },
      { title: "overrides", anyOf: [{ type: "object", additionalProperties: false, properties: { status: node.properties.status, evidence: node.properties.evidence, annotation: node.properties.annotation } }, { type: "null" }] }],
  }
  graph.properties.edges.items = { type: "array", minItems: 3, maxItems: 4, items: false,
    description: "Edge row: [from, to, label, annotation?]. Node IDs, not numeric indices. The annotation belongs to this edge.",
     prefixItems: [column("from", edge.properties.from), column("to", edge.properties.to), column("label", edge.properties.label), { title: "annotation", anyOf: [edge.properties.annotation, { type: "null" }] }],
  }
  schema.properties = { format: { const: "draft", type: "string" }, ...schema.properties }
  schema.required.unshift("format")
  schema.description = "Diagram authoring draft. Put metadata on its node/edge; the plugin constructs canonical annotation indices and expands your explicit defaults."
  // Remove definitions made obsolete by co-location, and name remaining shared types.
  const names = new Map<string, string>([[node.properties.id.$ref, "Identifier"]])
  for (const variant of variants) {
    if (variant.properties.version?.$ref) names.set(variant.properties.version.$ref, "NotationVersion")
    if (variant.properties.groups?.$ref) names.set(variant.properties.groups.$ref, "Groups")
  }
  const reachable = new Set<string>()
  const collect = (value: any) => {
    if (!value.$ref || reachable.has(value.$ref)) return
    reachable.add(value.$ref)
    visit(resolve(value), collect)
  }
  visit({ ...schema, $defs: undefined }, collect)
  schema.$defs = Object.fromEntries([...reachable].map(ref => [names.get(ref) ?? ref.split("/").at(-1), resolve({ $ref: ref })]))
  visit(schema, value => { if (names.has(value.$ref)) value.$ref = `#/$defs/${names.get(value.$ref)}` })
  return schema
}

/** Expand declared structure only. No inferred citations, roles, ports or content. */
export function expandDiagramDraft(text: string, evidence: readonly Evidence[]): string {
  const value = parseDiagramJSON(text)
  const root = object(value)
  if (!root || root.format !== "draft") return text // Existing canonical responses/repairs remain supported.
  delete root.format
  if (!Array.isArray(root.views)) fail("views must be an array")
  const currentIDs = new Set(evidence.map(item => item.id))
  for (const view of root.views) {
    const graph = object(object(view)?.graph)
    if (!graph) fail("view must contain a graph")
    const defaults = defaultsSchema.safeParse(graph.defaults)
    if (!defaults.success) fail("each graph needs explicit valid status and evidence defaults")
    const shared = defaults.data
    if (shared.evidence.some(id => !currentIDs.has(id))) fail("default evidence must use current source IDs")
    delete graph.defaults
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) fail("nodes and edges must be arrays")
    graph.nodes = graph.nodes.map((node: unknown) => {
      if (!Array.isArray(node)) return node // Object drafts remain readable.
      if (node.length < 5 || node.length > 6) fail("node row needs five fields and optional overrides")
      const [id, label, kind, detail, behavior] = node
      const overrides = node.length === 6 && node[5] !== null ? object(node[5]) : {}
      if (!overrides || Object.keys(overrides).some(key => !["status", "evidence", "annotation"].includes(key))) fail("invalid node overrides")
      return { id, label, kind, detail, ...(behavior === null ? {} : { behavior }), ...overrides }
    })
    graph.edges = graph.edges.map((edge: unknown) => {
      if (!Array.isArray(edge)) return edge
      if (edge.length < 3 || edge.length > 4) fail("edge row needs three fields and optional annotation")
      return { from: edge[0], to: edge[1], label: edge[2], ...(edge.length === 4 && edge[3] !== null ? { annotation: edge[3] } : {}) }
    })
    const inherit = (record: Record<string, any>) => { if (!Object.hasOwn(record, "evidence")) record.evidence = [...shared.evidence] }
    const notation = object(graph.notation)
    const family = typeof notation?.family === "string" ? notation.family : ""
    const move = (items: unknown[], identity: "node" | "edge", collection?: string) => {
      if (collection) {
        if (Object.hasOwn(notation!, collection)) fail("do not mix inline annotations with canonical annotation arrays")
        notation![collection] = []
      }
      for (const [index, item] of items.entries()) {
        const record = object(item)
        if (!record) fail(`${identity} must be an object`)
        if (identity === "node") {
          inherit(record)
          if (!Object.hasOwn(record, "status")) record.status = shared.status
        }
        if (!collection) {
          if (Object.hasOwn(record, "annotation")) fail("annotation does not belong to this family")
          continue
        }
        const annotation = object(record.annotation)
        if (!annotation || Object.hasOwn(annotation, identity)) fail(`each ${identity} requires an inline annotation without an identity field`)
        inherit(annotation)
        notation![collection].push({ [identity]: identity === "node" ? record.id : index, ...annotation })
        delete record.annotation
      }
    }
    move(graph.nodes, "node", Object.hasOwn(nodeCollections, family) ? nodeCollections[family] : undefined)
    move(graph.edges, "edge", Object.hasOwn(edgeCollections, family) ? edgeCollections[family] : undefined)
    if (notation) {
      if (!Object.hasOwn(notation, "version")) notation.version = 2
      // Only known citation-bearing records inherit. Unknown fields remain for
      // canonical strict validation to reject; never silently discard them.
      for (const key of ["groups", "ports", "steps", "branches", "states", "transitions", "records", "relationships", "links", "messages", "fragments", "signals", "components", "nets"]) {
        if (Array.isArray(notation[key])) for (const record of notation[key]) if (object(record)) inherit(record)
      }
    }
  }
  // Caller must validate the complete canonical object, including all references.
  return JSON.stringify(root)
}
