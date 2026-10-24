import { z } from "zod"
import { ViewAnalysisSchema } from "../diagram/model.js"
import { diagramID, diagramText } from "../diagram/notation-schema.js"
import { validateDiagramOutput } from "../diagram/protocol.js"
import { renderDiagramPNG, renderDiagramSVG } from "../diagram/export.js"

const revision = z.number().int().nonnegative()
export const SourcesSchema = z.array(z.object({ id: diagramID, label: diagramText(160) }).strict()).min(1).max(32)
  .refine(sources => new Set(sources.map(source => source.id)).size === sources.length, "Duplicate source IDs")
export const PublishSchema = z.object({
  diagramID,
  expectedRevision: revision.describe("0 creates a new diagram; otherwise supply its current revision from diagram_get."),
  analysis: ViewAnalysisSchema,
  sources: SourcesSchema,
}).strict()
export const LookupSchema = z.object({ diagramID }).strict()
export const RemoveSchema = LookupSchema.extend({ expectedRevision: revision }).strict()
export const RenderSchema = LookupSchema.extend({
  viewID: diagramID,
  format: z.enum(["svg", "png"]),
  colorMode: z.enum(["light", "dark"]).default("light"),
  selected: diagramID.optional(),
}).strict()
export const RecordSchema = z.object({
  version: z.literal(1), diagramID, revision, analysis: ViewAnalysisSchema, sources: SourcesSchema,
}).strict()
export type DiagramRecord = z.infer<typeof RecordSchema>

export class DiagramStoreError extends Error {}
const MAX_RECORD_BYTES = 512 * 1024
const MAX_RENDER_BYTES = 8 * 1024 * 1024

/** Process-local, bounded store. No paths, URLs, transcripts, or model credentials. */
export class DiagramStore {
  private records = new Map<string, DiagramRecord>()
  private revision = 0
  private rendering = 0

  publish(value: unknown): DiagramRecord {
    const parsed = PublishSchema.safeParse(value)
    if (!parsed.success) throw new DiagramStoreError("Invalid publication; use diagram_schema and the published input schema.")
    const input = parsed.data
    const previous = this.records.get(input.diagramID)
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new DiagramStoreError("Revision conflict; read diagram_get before publishing.")
    if (!previous && this.records.size >= 32) throw new DiagramStoreError("Diagram capacity reached (32); remove an unused diagram first.")
    const analysis = validateDiagramOutput(input.analysis, input.sources)
    if (!analysis.relevant) throw new DiagramStoreError("A stored diagram must contain at least one view; use diagram_remove to delete it.")
    const record: DiagramRecord = { version: 1, diagramID: input.diagramID, revision: this.revision + 1, analysis, sources: input.sources }
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw new DiagramStoreError("Diagram exceeds the 512 KiB record limit.")
    // No await between conflict check and commit. Revisions are never reused after removal.
    this.revision = record.revision
    this.records.set(record.diagramID, record)
    return structuredClone(record)
  }

  get(id: string): DiagramRecord {
    if (!diagramID.safeParse(id).success) throw new DiagramStoreError("Invalid diagram ID.")
    const record = this.records.get(id)
    if (!record) throw new DiagramStoreError("Diagram not found; records last only for this server process.")
    return structuredClone(record)
  }

  list() {
    return [...this.records.values()].map(({ diagramID, revision, analysis }) => ({ diagramID, revision,
      views: analysis.views.map(({ id, label }) => ({ id, label })) }))
  }

  remove(value: unknown) {
    const parsed = RemoveSchema.safeParse(value)
    if (!parsed.success) throw new DiagramStoreError("Invalid removal request.")
    const current = this.get(parsed.data.diagramID)
    if (current.revision !== parsed.data.expectedRevision) throw new DiagramStoreError("Revision conflict; read diagram_get before removing.")
    this.records.delete(current.diagramID)
    return { diagramID: current.diagramID, removed: true }
  }

  async render(value: unknown) {
    const parsed = RenderSchema.safeParse(value)
    if (!parsed.success) throw new DiagramStoreError("Invalid render request.")
    const input = parsed.data
    const record = this.get(input.diagramID)
    const view = record.analysis.views.find(view => view.id === input.viewID)
    if (!view) throw new DiagramStoreError("View not found; read diagram_get for available views.")
    if (input.selected && !view.graph.nodes.some(node => node.id === input.selected)) throw new DiagramStoreError("Selected node not found in this view.")
    if (this.rendering >= 2) throw new DiagramStoreError("Renderer busy; retry after a current render finishes.")
    this.rendering++
    try {
      const options = { colorMode: input.colorMode, selected: input.selected }
      const data = input.format === "svg" ? await renderDiagramSVG(view.graph, options)
        : Buffer.from(await renderDiagramPNG(view.graph, options)).toString("base64")
      if (Buffer.byteLength(data) > MAX_RENDER_BYTES) throw new DiagramStoreError("Rendered output exceeds the 8 MiB response limit.")
      return { diagramID: record.diagramID, revision: record.revision, viewID: view.id,
        format: input.format, mimeType: input.format === "svg" ? "image/svg+xml" : "image/png", data }
    } finally { this.rendering-- }
  }
}
