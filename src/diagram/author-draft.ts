import { z } from "zod"
import type { Evidence } from "./evidence.js"
import { GraphSchema } from "./model.js"
import type { DiagramView, DiagramViewAnalysis } from "./model.js"
import { diagramID, diagramText, NotationSchema } from "./notation-schema.js"
import { DiagramOutputError, parseDiagramOutput } from "./protocol.js"

const index = z.number().int().min(0).max(95)
const defaults = GraphSchema.shape.nodes.element.pick({ status: true, evidence: true }).strict()
const notationEdits: z.ZodType[] = []
const notationRemovals: z.ZodType[] = []
const notationLimits = new Map<string, number>()
for (const variant of NotationSchema.options) {
  for (const [field, schema] of Object.entries(variant.shape)) {
    if (field === "version" || field === "family") continue
    const base = { view: diagramID, family: variant.shape.family, field: z.literal(field) }
    notationEdits.push(z.object({ ...base, value: schema }).strict())
    if (schema instanceof z.ZodArray) {
      notationLimits.set(`${variant.shape.family.value}.${field}`, z.toJSONSchema(schema).maxItems as number)
      notationEdits.push(z.object({ ...base, index, value: schema.element }).strict())
      notationRemovals.push(z.object({ target: z.literal("record"), ...base, index }).strict())
    }
  }
}
const schemas = {
  inspect: z.object({}).strict(),
  view: z.object({ id: diagramID.optional(), label: diagramText(24).min(1).optional(), title: diagramText(100).optional(),
    summary: diagramText(400).optional(), reason: diagramText(240).optional(), defaults: defaults.optional() }).strict()
    .refine(value => value.id !== undefined || (value.reason !== undefined && Object.keys(value).every(key => key === "reason"))),
  node: z.object({ view: diagramID, node: GraphSchema.shape.nodes.element.partial().required({ id: true }).strict() }).strict(),
  edge: z.object({ view: diagramID, index: z.number().int().min(0).max(47).optional(),
    edge: GraphSchema.shape.edges.element.partial().strict() }).strict(),
  notation: z.union(notationEdits),
  remove: z.union([
    z.object({ target: z.literal("view"), view: diagramID }).strict(),
    z.object({ target: z.literal("node"), view: diagramID, id: diagramID }).strict(),
    z.object({ target: z.literal("edge"), view: diagramID, index: z.number().int().min(0).max(47) }).strict(),
    z.object({ target: z.literal("notation"), view: diagramID }).strict(),
    ...notationRemovals,
  ]),
  validate: z.object({}).strict(),
}
const descriptions: Record<keyof typeof schemas, string> = {
  inspect: "Read a deep copy of canonical draft, explicit node defaults, evidence aliases and remaining mutation budget.",
  view: "Upsert view metadata; omitted fields stay unchanged. Omit id to set only root reason (required before validation). Defaults seed only NEW nodes; never infer citations.",
  node: "Upsert named node fields by ID. Omitted fields stay unchanged; new nodes may be incomplete until validate. References may temporarily dangle.",
  edge: "Append edge when index omitted; otherwise merge fields at existing index. References may temporarily dangle.",
  notation: "Set one family field/collection, or replace/append one complete record by index (length appends). Family changes require removing notation first. Replacing messages collection clears activations/fragments to avoid index retargeting.",
  remove: "Remove view, node, edge, notation or indexed notation record. Node removal leaves references for repair. Edge removal clears notation to prevent index retargeting. Message removal clears activations/fragments.",
  validate: "Strict canonical graph, notation, citations, reason, allowed views and node budget check. No persistence or locking; failed validation leaves draft editable.",
}
export const AUTHOR_DRAFT_TOOLS: Record<keyof typeof schemas, { description: string; input: Record<string, any> }> =
  Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, {
    description: descriptions[name as keyof typeof schemas], input: z.toJSONSchema(schema),
  }])) as Record<keyof typeof schemas, { description: string; input: Record<string, any> }>

const BYTE_LIMIT = 128 * 1024
const OP_LIMIT = 256
const clone = <T>(value: T): T => structuredClone(value)
type Issue = { path: string; message: string }
type Validation = { ok: true; value: DiagramViewAnalysis } | { ok: false; issues: Issue[] }
const failure = (message: string): { ok: false; issues: Issue[] } => ({ ok: false, issues: [{ path: "root", message }] })
function fail(message: string): never { throw new Error(message) }

/** Accept bounded plain JSON only, before parsing/cloning. Never invoke toJSON/getters. */
function boundedJSON(value: unknown): string {
  let remaining = BYTE_LIMIT
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 32) fail("Draft JSON limit exceeded")
    if (item === null || typeof item === "boolean") return
    if (typeof item === "number" && Number.isFinite(item)) return
    if (typeof item === "string") { remaining -= item.length; if (remaining < 0) fail("Draft JSON limit exceeded"); return }
    if (typeof item !== "object" || !item || seen.has(item)) fail("Expected plain JSON")
    const proto = Object.getPrototypeOf(item)
    if (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail("Expected plain JSON")
    seen.add(item)
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) fail("Forbidden JSON key")
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("Expected plain JSON")
      remaining -= key.length
      visit(descriptor.value, depth + 1)
    }
    seen.delete(item)
  }
  visit(value, 0)
  const text = JSON.stringify(value)
  if (new TextEncoder().encode(text).length > BYTE_LIMIT) fail("Draft JSON limit exceeded")
  return text
}

/** Caller supplies canonical baseline and evidence already remapped to short aliases. */
export function createAuthorDraft(input: { evidence: readonly Evidence[]; views?: readonly DiagramView[]; maxNodes?: number; viewIDs?: readonly string[] }) {
  const maxNodes = input.maxNodes ?? 48
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 48) fail("Invalid node budget")
  const allowed = input.viewIDs === undefined ? undefined : new Set(input.viewIDs.map(id => diagramID.parse(id)))
  const evidence = input.evidence.map(item => ({ id: diagramID.parse(item.id), label: diagramText(160).parse(item.label) }))
  let state: { reason: string; views: any[]; defaults: Record<string, z.infer<typeof defaults>> } =
    { reason: "", views: clone([...(input.views ?? [])]), defaults: Object.create(null) }
  let operations = 0
  function bounds(next: typeof state) {
    if (next.views.length > 4 || next.views.some(view => view.graph.nodes.length > 24 || view.graph.edges.length > 48)
      || next.views.reduce((sum, view) => sum + view.graph.nodes.length, 0) > 48) fail("Draft count limit exceeded")
    for (const view of next.views) {
      const notation = view.graph.notation
      if (!notation) continue
      for (const [field, value] of Object.entries(notation)) {
        const limit = notationLimits.get(`${notation.family}.${field}`)
        if (Array.isArray(value) && limit !== undefined && value.length > limit) fail("Draft count limit exceeded")
      }
    }
    boundedJSON(next)
  }
  bounds(state)
  function inspect() {
    return clone({ relevant: state.views.length > 0, ...state, evidence, remainingOperations: OP_LIMIT - operations })
  }
  function validate(): Validation {
    if (!state.reason.trim()) return failure("Nonempty reason required; set view.reason")
    if (allowed && (state.views.length !== allowed.size || state.views.some(view => !allowed.has(view.id)))) return failure("Draft must retain exactly the allowed view set")
    if (state.views.reduce((sum, view) => sum + view.graph.nodes.length, 0) > maxNodes) return failure("Total node budget exceeded")
    try {
      return { ok: true, value: clone(parseDiagramOutput(boundedJSON({ relevant: state.views.length > 0, reason: state.reason, views: state.views }), evidence)) }
    } catch (error) {
      if (error instanceof DiagramOutputError) return { ok: false, issues: error.issues.length
        ? error.issues.slice(0, 16).map(issue => ({ path: issue.path.join(".").slice(0, 240) || "root", message: issue.problem }))
        : [{ path: "root", message: error.code === "citation" ? "Citation outside supplied evidence" : "Invalid canonical draft" }] }
      return failure("Invalid canonical draft")
    }
  }
  function execute(name: string, raw: unknown): unknown {
    if (!Object.hasOwn(schemas, name)) return failure("Unknown draft operation")
    try {
      boundedJSON(raw)
      const parsed = schemas[name as keyof typeof schemas].safeParse(raw)
      if (!parsed.success) return failure("Invalid operation fields or values; consult operation schema")
      if (name === "inspect") return inspect()
      if (name === "validate") return validate()
      if (operations >= OP_LIMIT) return failure("Draft mutation limit exceeded")
      const arg: any = parsed.data
      const next = clone(state)
      if (name === "view") {
        if (arg.reason !== undefined) next.reason = arg.reason
        if (arg.id !== undefined) {
          let view = next.views.find(view => view.id === arg.id)
          if (!view) { view = { id: arg.id, graph: { nodes: [], edges: [] } }; next.views.push(view) }
          if (arg.label !== undefined) view.label = arg.label
          for (const key of ["title", "summary"]) if (arg[key] !== undefined) view.graph[key] = arg[key]
          if (arg.defaults !== undefined) next.defaults[arg.id] = arg.defaults
        }
      } else {
        const viewIndex = next.views.findIndex(view => view.id === arg.view)
        if (viewIndex < 0) fail("Unknown draft view")
        const graph = next.views[viewIndex].graph
        if (name === "node") {
          const position = graph.nodes.findIndex((node: any) => node.id === arg.node.id)
          if (position < 0) graph.nodes.push({ ...next.defaults[arg.view], ...arg.node })
          else graph.nodes[position] = { ...graph.nodes[position], ...arg.node }
        } else if (name === "edge") {
          if (arg.index === undefined) graph.edges.push(arg.edge)
          else {
            if (arg.index >= graph.edges.length) fail("Unknown draft edge index")
            graph.edges[arg.index] = { ...graph.edges[arg.index], ...arg.edge }
          }
        } else if (name === "notation") {
          if (graph.notation && graph.notation.family !== arg.family) fail("Remove notation before changing family")
          const notation = graph.notation ??= { version: 2, family: arg.family }
          if (arg.index === undefined) notation[arg.field] = arg.value
          else {
            const records = notation[arg.field] ??= []
            if (arg.index > records.length) fail("Unknown notation record index")
            records[arg.index] = arg.value
          }
          if (arg.field === "messages" && arg.index === undefined) { notation.activations = []; notation.fragments = [] }
        } else if (name === "remove") {
          if (arg.target === "view") { next.views.splice(viewIndex, 1); delete next.defaults[arg.view] }
          if (arg.target === "notation") graph.notation = null
          if (arg.target === "node") {
            const position = graph.nodes.findIndex((node: any) => node.id === arg.id)
            if (position < 0) fail("Unknown draft node")
            graph.nodes.splice(position, 1)
          }
          if (arg.target === "edge") {
            if (arg.index >= graph.edges.length) fail("Unknown draft edge index")
            graph.edges.splice(arg.index, 1); graph.notation = null
          }
          if (arg.target === "record") {
            const notation = graph.notation
            if (!notation || notation.family !== arg.family || !Array.isArray(notation[arg.field]) || arg.index >= notation[arg.field].length) fail("Unknown notation record index")
            notation[arg.field].splice(arg.index, 1)
            if (arg.field === "messages") { notation.activations = []; notation.fragments = [] }
          }
        }
      }
      bounds(next)
      state = next
      operations++
      return { ok: true }
    } catch (error) {
      // All edit errors above are code-owned; never relay arbitrary exception text.
      return failure(error instanceof Error && ["Draft JSON limit exceeded", "Expected plain JSON", "Forbidden JSON key", "Draft count limit exceeded", "Unknown draft view", "Unknown draft node", "Unknown draft edge index", "Unknown notation record index", "Remove notation before changing family"].includes(error.message)
        ? error.message : "Invalid draft operation")
    }
  }
  return { execute, validate, inspect }
}
