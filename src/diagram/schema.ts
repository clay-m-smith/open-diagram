import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { diagramText as text } from "./notation-schema.js"
import { StateSchema, ModeSchema, GranularitySchema, SnapshotSchema, ViewAnalysisSchema } from "./model.js"

// Preserve the OpenCode RPC entrypoint; shared data schemas do not load the host.
export * from "./model.js"

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
