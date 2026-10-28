import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { diagramText as text } from "./notation-schema.js"
import { StateSchema, ModeSchema, GranularitySchema, SnapshotSchema, ViewAnalysisSchema } from "./model.js"
import { HistoryEntrySchema, HistorySummarySchema, HISTORY_LIMIT } from "./history-model.js"

// Preserve the OpenCode RPC entrypoint; shared data schemas do not load the host.
export * from "./model.js"

export const RenderInputSchema = z.object({
  sessionID: z.string().min(1), viewID: z.string().min(1).max(40),
  epoch: z.string().min(1), revision: z.number().int().nonnegative(),
  selected: z.string().min(1).max(40).optional(), colorMode: z.enum(["light", "dark"]),
}).strict()
export const RenderOutputSchema = z.object({
  sessionID: z.string(), viewID: z.string(), epoch: z.string(), revision: z.number().int().nonnegative(),
  svg: z.string().max(4 * 1024 * 1024),
}).strict()
const HistoryInputSchema = z.object({ sessionID: z.string().min(1), snapshotID: z.string().regex(/^[a-f0-9]{24}$/) }).strict()

/** The server owns snapshots. UI storage contains presentation preferences only. */
export const DiagramRpc = Rpc.define({
  id: "open-diagram",
  methods: {
    get: { input: z.object({ sessionID: z.string().min(1) }).strict(), output: StateSchema },
    render: { input: RenderInputSchema, output: RenderOutputSchema,
      errors: { stale: z.object({}).strict(), unavailable: z.object({}).strict() } },
    history: { input: z.object({ sessionID: z.string().min(1) }).strict(), output: z.array(HistorySummarySchema).max(HISTORY_LIMIT) },
    historyGet: { input: HistoryInputSchema, output: HistoryEntrySchema, errors: { unavailable: z.object({}).strict() } },
    renderHistory: { input: HistoryInputSchema.extend({ selected: RenderInputSchema.shape.selected, colorMode: RenderInputSchema.shape.colorMode }),
      output: HistoryInputSchema.extend({ svg: RenderOutputSchema.shape.svg }), errors: { unavailable: z.object({}).strict() } },
    control: { input: z.object({ sessionID: z.string().min(1), mode: ModeSchema.optional(), refresh: z.boolean().optional(), granularity: GranularitySchema.optional() }).strict(), output: StateSchema,
      errors: { capacity: z.object({ mode: ModeSchema, cacheError: text(240).nullable().optional() }).strict() } },
    snapshot: { input: z.object({ sessionID: z.string().min(1) }).strict(), output: SnapshotSchema },
    publish: { input: z.object({ sessionID: z.string().min(1), token: z.string().min(1).max(128), analysis: ViewAnalysisSchema }).strict(), output: StateSchema },
  },
  events: { updated: { schema: StateSchema } },
})
