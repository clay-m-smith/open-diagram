import { z } from "zod"
import { AnalysisSchema, ViewAnalysisSchema, type DiagramViewAnalysis, type DiagramGraph, type DiagramGranularity } from "./schema.js"
import type { Evidence } from "./evidence.js"
import { DIAGRAM_INSTRUCTION, GRANULAR_INSTRUCTION } from "./prompt.js"
import { diagramEvidence } from "./notation.js"

export { DIAGRAM_INSTRUCTION } from "./prompt.js"
export { GraphSchema, ViewSchema, ViewAnalysisSchema, NotationSchema, DiagramRpc } from "./schema.js"
export { diagramEvidence, nodeEvidence } from "./notation.js"
export type { DiagramGraph, DiagramNotation } from "./schema.js"
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

/** Native result-tool schema; identical validators, reusable schema definitions. */
export function nativeDiagramOutputSchema() {
  return z.toJSONSchema(ViewAnalysisSchema, { reused: "ref" })
}

export function diagramRequest(evidence: readonly Evidence[], previous: DiagramGraph | null, forced: boolean, granularity: DiagramGranularity = "overview") {
  return {
    version: HARNESS_VERSION,
    instruction: DIAGRAM_INSTRUCTION + (granularity === "granular" ? `\n${GRANULAR_INSTRUCTION}` : ""),
    input: { forced, previous, evidence, granularity },
    outputSchema: diagramOutputSchema(),
  }
}

export type DiagramIssue = { path: (string | number)[]; problem: string }
export class DiagramOutputError extends Error {
  constructor(readonly code: "json" | "schema" | "citation", message: string, readonly issues: DiagramIssue[] = []) { super(message) }
}

export function parseDiagramJSON(text: string): unknown {
  const raw = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1")
  let failure: unknown
  try { return JSON.parse(raw) } catch (error) { failure = error }
  // V8 and JavaScriptCore describe syntax errors differently. Classify only;
  // raw parser messages can contain source text and must never reach the UI.
  const message = failure instanceof Error ? failure.message : ""
  const position = /position (\d+)/.exec(message)?.[1]
  const syntax = /unterminated|unexpected end/i.test(message) ? "incomplete"
    : /escape|unicode/i.test(message) ? "escape"
    : /expected.*:|after property name/i.test(message) ? "colon"
    : /property name|property names/i.test(message) ? "property"
    : /expected.*[,}\]]|after property value|array element/i.test(message) ? "separator"
    : "syntax"
  throw new DiagramOutputError("json", `Diagram response is not valid JSON (${syntax}; ${raw.length} chars)${position ? ` at character ${position}` : ""}`)
}

/** Validate any model's output without executing it or exposing source text in errors. */
export function parseDiagramOutput(text: string, evidence: readonly Evidence[]): DiagramViewAnalysis {
  return validateDiagramOutput(parseDiagramJSON(text), evidence)
}

function diagramIssue(issue: z.core.$ZodIssue): DiagramIssue {
  // Never echo received values, unknown property names, or raw validator messages.
  const problem = issue.code === "invalid_type" ? `expected ${issue.expected}`
    : issue.code === "unrecognized_keys" ? "unexpected fields"
    : issue.code === "too_small" ? `minimum ${issue.minimum}`
    : issue.code === "too_big" ? `maximum ${issue.maximum}`
    : issue.code === "invalid_value" ? "unsupported value"
    : issue.code === "invalid_format" ? "invalid text format"
    : issue.code === "custom" && issue.params?.diagramRule === true ? issue.message
    : "inconsistent structure or references"
  return { path: issue.path.map((part) => typeof part === "number" ? part : String(part).replace(/[^\w-]/g, "").slice(0, 50)), problem }
}

export function validateDiagramOutput(value: unknown, evidence: readonly Evidence[]): DiagramViewAnalysis {
  const multiple = ViewAnalysisSchema.safeParse(value)
  const legacy = multiple.success ? undefined : AnalysisSchema.safeParse(value)
  if (!multiple.success && !legacy?.success) {
    const issues = multiple.error.issues.map(diagramIssue)
    const details = issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "root"} (${issue.problem})`).join(", ")
    throw new DiagramOutputError("schema", `Invalid diagram schema: ${details}`, issues)
  }
  const analysis: DiagramViewAnalysis = multiple.success ? multiple.data : {
    relevant: legacy!.data!.relevant, reason: legacy!.data!.reason,
    views: legacy!.data!.graph ? [{ id: "overview", label: "Overview", graph: legacy!.data!.graph }] : [],
  }
  const ids = new Set(evidence.map((item) => item.id))
  const graphs = analysis.views.map((view) => view.graph)
  if (graphs.some((graph) => diagramEvidence(graph).some((id) => !ids.has(id)))) {
    throw new DiagramOutputError("citation", "Diagram cited evidence outside current snapshot")
  }
  return analysis
}
