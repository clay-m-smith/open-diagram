import { McpServer, ResourceTemplate, type CallToolResult, type StandardSchemaWithJSON } from "@modelcontextprotocol/server"
import { z } from "zod"
import { DIAGRAM_INSTRUCTION, DiagramOutputError, diagramOutputSchema } from "../diagram/protocol.js"
import { DiagramStore, DiagramStoreError, LookupSchema, PublishSchema, RecordSchema, RemoveSchema, RenderSchema } from "./store.js"

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const uriFor = (id: string) => `diagram://local/${id}`
// Zod 4.1 has Standard Schema validation but predates its JSON Schema interface.
// Keep the project's pinned validators/refinements, adding only SDK conversion.
function mcpSchema<S extends z.ZodType>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  return { "~standard": { ...schema["~standard"], jsonSchema: {
    input: () => z.toJSONSchema(schema, { io: "input" }),
    output: () => z.toJSONSchema(schema),
  } } }
}
function json(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }
}
async function result(run: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try { return await run() }
  catch (error) {
    const message = error instanceof DiagramStoreError || error instanceof DiagramOutputError ? error.message : "Diagram operation failed; retry without replacing the accepted diagram."
    return { isError: true, content: [{ type: "text", text: message }] }
  }
}

/** One store per server instance. Sharing between users requires an external access-control design. */
export function createDiagramMcpServer() {
  const store = new DiagramStore()
  const server = new McpServer({ name: "open-diagram", version: "0.1.0" }, {
    instructions: "Client-authored diagrams only. Call diagram_schema for the authoring contract, then diagram_publish. No model calls or source-file reads. Records are process-local and disappear on exit; export anything you need to keep. Resource URIs are local MCP identifiers, not web URLs.",
    maxToolInputElements: 50_000,
  })
  server.registerTool("diagram_schema", {
    description: "Get the shared diagram authoring instructions and JSON Schema. Clients author the analysis; the server never calls a model. Source IDs are client-supplied references, not independently verified facts.",
    inputSchema: mcpSchema(z.object({}).strict()), annotations: readOnly,
  }, () => json({ version: 1, instruction: DIAGRAM_INSTRUCTION, outputSchema: diagramOutputSchema() }))
  server.registerTool("diagram_publish", {
    description: "Create or replace a validated diagram with client-supplied source references. 0 expectedRevision creates; updates require the current revision. At most 32 diagrams, 512 KiB each. In memory until process exit; never reads sources or writes files.",
    inputSchema: mcpSchema(PublishSchema), outputSchema: mcpSchema(RecordSchema),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, input => result(() => json(store.publish(input))))
  server.registerTool("diagram_get", {
    description: "Read an accepted diagram, all views and source references as JSON, without regeneration.",
    inputSchema: mcpSchema(LookupSchema), outputSchema: mcpSchema(RecordSchema), annotations: readOnly,
  }, ({ diagramID }) => result(() => json(store.get(diagramID))))
  server.registerTool("diagram_list", {
    description: "List this process's diagram IDs, revisions and views. Other server processes have separate stores.",
    inputSchema: mcpSchema(z.object({}).strict()), annotations: readOnly,
  }, () => json({ diagrams: store.list() }))
  server.registerTool("diagram_remove", {
    description: "Remove a diagram from this process, requiring its current revision. Export first if it must be kept.",
    inputSchema: mcpSchema(RemoveSchema), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, input => result(() => json(store.remove(input))))
  server.registerTool("diagram_render", {
    description: "Render one accepted view as an embedded SVG resource or PNG image. Optional selected node expands details. No model calls; at most two active renders and 8 MiB output. Client image display support varies.",
    inputSchema: mcpSchema(RenderSchema), annotations: readOnly,
  }, input => result(async () => {
    const { data, ...metadata } = await store.render(input)
    return { ...json(metadata), content: [
      { type: "text", text: JSON.stringify(metadata) },
      metadata.format === "png" ? { type: "image", mimeType: "image/png", data }
        : { type: "resource", resource: { uri: `${uriFor(metadata.diagramID)}/${metadata.revision}/${metadata.viewID}.svg`, mimeType: "image/svg+xml", text: data } },
    ] }
  }))
  server.registerResource("diagram", new ResourceTemplate("diagram://local/{diagramID}", {
    list: async () => ({ resources: store.list().map(item => ({ uri: uriFor(item.diagramID), name: item.diagramID, mimeType: "application/json" })) }),
  }), { description: "Current accepted diagram JSON. In-memory; re-read to see updates. No resource subscriptions.", mimeType: "application/json" },
  async (uri, variables) => {
    const record = store.get(String(variables.diagramID))
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(record) }] }
  })
  return server
}
