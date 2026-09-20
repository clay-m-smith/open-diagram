import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { diagramID as id, diagramText as text, NotationSchema, refineNotation } from "./notation-schema.js"
export { NotationSchema, type DiagramNotation } from "./notation-schema.js"

// No terminal controls, multiline labels, markup, or executable diagram syntax.
export const GraphSchema = z.object({
  title: text(100),
  summary: text(400),
  nodes: z.array(z.object({
    id,
    label: text(70),
    kind: text(32).min(1),
    detail: text(240),
    behavior: text(600).optional(),
    status: z.enum(["observed", "planned"]),
    evidence: z.array(id).min(1).max(6),
  }).strict()).min(1).max(24),
  edges: z.array(z.object({ from: id, to: id, label: text(60) }).strict()).max(48),
  notation: NotationSchema.nullable().optional(),
}).strict().superRefine((graph, ctx) => {
  const ids = new Set(graph.nodes.map((node) => node.id))
  if (ids.size !== graph.nodes.length) ctx.addIssue({ code: "custom", message: "Duplicate node IDs" })
  const edges = new Set<string>()
  for (const edge of graph.edges) {
    const key = JSON.stringify([edge.from, edge.to, edge.label])
    if (!ids.has(edge.from) || !ids.has(edge.to) || edges.has(key)) {
      ctx.addIssue({ code: "custom", message: "Dangling or duplicate edge" })
    }
    edges.add(key)
  }
  refineNotation(graph, ctx)
})
export type DiagramGraph = z.infer<typeof GraphSchema>
export const ViewSchema = z.object({ id, label: text(24).min(1), graph: GraphSchema }).strict()
export type DiagramView = z.infer<typeof ViewSchema>
export type DiagramUpdate = { views: DiagramView[]; maxNodes?: number }
const ViewsSchema = z.array(ViewSchema).max(4).superRefine((views, ctx) => {
  if (new Set(views.map((view) => view.id)).size !== views.length) ctx.addIssue({ code: "custom", message: "Duplicate view IDs" })
  if (views.reduce((sum, view) => sum + view.graph.nodes.length, 0) > 48) ctx.addIssue({ code: "custom", message: "Too many total nodes" })
})
export const ViewAnalysisSchema = z.object({
  relevant: z.boolean(), reason: text(240), views: ViewsSchema,
}).strict().refine((value) => value.relevant === (value.views.length > 0), "Relevant work requires a view")
export type DiagramViewAnalysis = z.infer<typeof ViewAnalysisSchema>
// Single-graph adapters remain readable; the public authoring contract uses views.
export const AnalysisSchema = z.object({
  relevant: z.boolean(),
  reason: text(240),
  graph: GraphSchema.nullable(),
}).strict().refine((value) => value.relevant === (value.graph !== null), "Relevant work requires a graph")
export type DiagramAnalysis = z.infer<typeof AnalysisSchema> & { views?: DiagramView[] }
export function analysisViews(analysis: { graph: DiagramGraph | null; views?: DiagramView[] }): DiagramView[] {
  return analysis.views?.length ? analysis.views : analysis.graph ? [{ id: "overview", label: "Overview", graph: analysis.graph }] : []
}
export const ModeSchema = z.enum(["auto", "on", "off"])
export type DiagramMode = z.infer<typeof ModeSchema>
export const GranularitySchema = z.enum(["overview", "granular"])
export type DiagramGranularity = z.infer<typeof GranularitySchema>
export const StateSchema = z.object({
  sessionID: z.string().min(1),
  epoch: id,
  mode: ModeSchema,
  granularity: GranularitySchema.default("overview"),
  phase: z.enum(["watching", "queued", "updating", "ready", "unavailable", "paused"]),
  relevant: z.boolean(),
  reason: text(240),
  revision: z.number().int().nonnegative(),
  cacheError: text(240).nullable().default(null),
  collectionError: text(240).nullable().default(null),
  updateError: text(240).nullable().default(null),
  updatedAt: z.number().nonnegative().nullable(),
  stale: z.boolean(),
  graph: GraphSchema.nullable(),
  views: ViewsSchema.default([]),
  changedViews: z.record(id, z.array(id).max(24)).default({}),
  changed: z.array(id).max(24),
  sources: z.array(z.object({ id, label: text(160) }).strict()).max(32),
}).strict()
export type DiagramState = z.infer<typeof StateSchema>
export function initialState(sessionID: string): DiagramState {
  return { sessionID, epoch: "pending", mode: "auto", granularity: "overview", phase: "watching", relevant: false,
    reason: "Watching development", revision: 0, updatedAt: null,
    stale: false, graph: null, views: [], changedViews: {}, changed: [], sources: [], cacheError: null, collectionError: null, updateError: null }
}

export const SnapshotSchema = z.object({
  version: z.literal(1), sessionID: z.string().min(1), epoch: id, token: z.string().min(1).max(128),
  granularity: GranularitySchema.default("overview"),
  evidence: z.array(z.object({ id, label: text(160), text: z.string().max(4000),
    at: z.number().optional(), category: z.enum(["request", "source", "structure", "recent", "inventory", "assistant"]).optional(),
    file: id.optional(), mutation: z.boolean().optional(), fingerprint: id.optional(),
  }).strict()).max(32),
  views: z.array(z.object({ id, label: text(24) }).strict()).max(4),
  instruction: z.string().max(8000), outputSchema: z.record(z.string(), z.unknown()),
}).strict()

/** The server owns snapshots. TUI storage contains presentation preferences only. */
export const DiagramRpc = Rpc.define({
  id: "open-diagram",
  methods: {
    get: { input: z.object({ sessionID: z.string().min(1) }).strict(), output: StateSchema },
    control: { input: z.object({ sessionID: z.string().min(1), mode: ModeSchema.optional(), refresh: z.boolean().optional(), granularity: GranularitySchema.optional() }).strict(), output: StateSchema,
      errors: { capacity: z.object({ mode: ModeSchema, cacheError: text(240).nullable().optional() }).strict() } },
    snapshot: { input: z.object({ sessionID: z.string().min(1) }).strict(), output: SnapshotSchema },
    publish: { input: z.object({ sessionID: z.string().min(1), token: z.string().min(1).max(128), analysis: ViewAnalysisSchema }).strict(), output: StateSchema },
  },
  events: { updated: { schema: StateSchema } },
})
