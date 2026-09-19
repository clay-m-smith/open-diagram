import { z } from "zod"
import { AnalysisSchema, ViewAnalysisSchema, type DiagramViewAnalysis, type DiagramGraph, type DiagramGranularity } from "./schema.js"
import type { Evidence } from "./evidence.js"
import { DIAGRAM_INSTRUCTION, GRANULAR_INSTRUCTION } from "./prompt.js"

export { DIAGRAM_INSTRUCTION } from "./prompt.js"
export { GraphSchema, ViewSchema, ViewAnalysisSchema, DiagramRpc } from "./schema.js"
export const HARNESS_VERSION = 1

export function diagramOutputSchema(options: { strict?: boolean } = {}) {
  return z.toJSONSchema(ViewAnalysisSchema, {
    override: ({ jsonSchema }) => {
      if (options.strict && jsonSchema.type === "object" && jsonSchema.properties) {
        jsonSchema.required = Object.keys(jsonSchema.properties)
      }
    },
  })
}

export function diagramRequest(evidence: readonly Evidence[], previous: DiagramGraph | null, forced: boolean, granularity: DiagramGranularity = "overview") {
  return {
    version: HARNESS_VERSION,
    instruction: DIAGRAM_INSTRUCTION + (granularity === "granular" ? `\n${GRANULAR_INSTRUCTION}` : ""),
    input: { forced, previous, evidence, granularity },
    outputSchema: diagramOutputSchema(),
  }
}

export class DiagramOutputError extends Error {
  constructor(readonly code: "json" | "schema" | "citation", message: string) { super(message) }
}

/** Validate any model's output without executing it or exposing source text in errors. */
export function parseDiagramOutput(text: string, evidence: readonly Evidence[]): DiagramViewAnalysis {
  let value: unknown
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1")) }
  catch { throw new DiagramOutputError("json", "Diagram response is not valid JSON") }
  return validateDiagramOutput(value, evidence)
}

export function validateDiagramOutput(value: unknown, evidence: readonly Evidence[]): DiagramViewAnalysis {
  const multiple = ViewAnalysisSchema.safeParse(value)
  const legacy = multiple.success ? undefined : AnalysisSchema.safeParse(value)
  if (!multiple.success && !legacy?.success) {
    const paths = multiple.error.issues.slice(0, 3).map((issue) => issue.path.join(".").replace(/[^\w.\[\]-]/g, "")).join(", ")
    throw new DiagramOutputError("schema", `Invalid diagram schema${paths ? `: ${paths}` : ""}`)
  }
  const analysis: DiagramViewAnalysis = multiple.success ? multiple.data : {
    relevant: legacy!.data!.relevant, reason: legacy!.data!.reason,
    views: legacy!.data!.graph ? [{ id: "overview", label: "Overview", graph: legacy!.data!.graph }] : [],
  }
  const ids = new Set(evidence.map((item) => item.id))
  const graphs = analysis.views.map((view) => view.graph)
  if (graphs.some((graph) => graph.nodes.some((node) => node.evidence.some((id) => !ids.has(id))))) {
    throw new DiagramOutputError("citation", "Diagram cited evidence outside current snapshot")
  }
  return analysis
}
