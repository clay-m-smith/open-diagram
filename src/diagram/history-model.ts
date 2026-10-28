import { z } from "zod"
import { GranularitySchema, StateSchema, ViewSchema } from "./model.js"

export const HISTORY_LIMIT = 24
export const HISTORY_BYTES = 1024 * 1024
export const HistoryEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/),
  granularity: GranularitySchema,
  updatedAt: z.number().nonnegative(),
  view: ViewSchema,
  sources: StateSchema.shape.sources,
}).strict()
export const HistorySchema = z.object({
  version: z.literal(1), entries: z.array(HistoryEntrySchema).max(HISTORY_LIMIT),
}).strict()
export const HistorySummarySchema = HistoryEntrySchema.pick({ id: true, granularity: true, updatedAt: true }).extend({
  viewID: ViewSchema.shape.id,
  label: ViewSchema.shape.label,
  title: ViewSchema.shape.graph.shape.title,
  current: z.boolean(),
}).strict()
export type DiagramHistory = z.infer<typeof HistorySchema>
export type DiagramHistoryEntry = z.infer<typeof HistoryEntrySchema>
export type DiagramHistorySummary = z.infer<typeof HistorySummarySchema>
