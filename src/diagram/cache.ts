import { z } from "zod"
import { digest, type Evidence } from "./evidence.js"
import { GranularitySchema, StateSchema, ViewAnalysisSchema, type DiagramState, type DiagramView } from "./schema.js"
import { diagramEvidence } from "./notation.js"

// Internal durable metadata, never part of the public snapshot/RPC schema.
// Two accepted entries: one per depth. Failed attempts never replace them.
const AcceptedSchema = z.object({
  key: z.string().max(80),
  granularity: GranularitySchema,
  fingerprints: z.record(z.string().max(100), z.string().max(64)).refine((value) => Object.keys(value).length <= 32),
  analysis: ViewAnalysisSchema,
  sources: StateSchema.shape.sources,
  updatedAt: z.number().nonnegative(),
}).strict()
export const MemoSchema = z.object({ version: z.literal(1), entries: z.array(AcceptedSchema).max(2),
  failed: z.array(z.object({ key: z.string().max(80), granularity: GranularitySchema,
    error: z.string().max(240).regex(/^[^\x00-\x1f\x7f-\x9f]*$/u).optional(),
  }).strict()).max(32).optional(),
}).strict()
export const StoredDiagramSchema = StateSchema.extend({ memo: MemoSchema.optional() })
export type AcceptedDiagram = z.infer<typeof AcceptedSchema>
export type DiagramMemo = z.infer<typeof MemoSchema>
export type StoredDiagram = DiagramState & { memo?: DiagramMemo }

/** Event time/order, progress prose and command logs are not code changes. */
export function materialEvidence(evidence: readonly Evidence[]): Evidence[] {
  const material = evidence.filter((item) => !item.category || ["source", "structure", "inventory"].includes(item.category))
  // Once implementation evidence exists, chat alone is not a code change.
  // Request-only domains can still update from their public user requests.
  const requests = evidence.filter((item) => item.category === "request")
  // Non-code domains and inventory-only sessions still have an authoring path.
  const files = new Set(material.map((item) => item.file).filter(Boolean))
  return material.length ? evidence.filter((item) => material.includes(item) || item.category === "context" || (item.file && files.has(item.file)))
    : requests.length ? evidence.filter(item => item.category === "request" || item.category === "context") : evidence.filter((item) => item.category !== "assistant")
}
export function evidenceFingerprints(evidence: readonly Evidence[]): Record<string, string> {
  const material = materialEvidence(evidence)
  const orderedFiles = new Map<string, string>()
  for (const item of material) {
    if (!item.file || !item.mutation || orderedFiles.has(item.file)) continue
    // Absolute observation time is noise. Relative read/mutation precedence is
    // not: a later reread can prove that an earlier mutation was reverted.
    const observations = material.map((value, index) => ({ value, index })).filter(({ value }) => value.file === item.file)
      .sort((a, b) => (a.value.at ?? a.index) - (b.value.at ?? b.index) || a.index - b.index)
      .map(({ value }) => [value.id, value.fingerprint ?? digest(JSON.stringify([value.label, value.text]))])
    orderedFiles.set(item.file, digest(JSON.stringify(observations)))
  }
  return Object.fromEntries(material.map((item) => [item.id, digest(JSON.stringify([item.label, item.text, item.fingerprint ?? null,
    item.file ? orderedFiles.get(item.file) ?? null : null]))]))
}
export function evidenceKey(evidence: readonly Evidence[], depth: DiagramState["granularity"], namespace = ""): string {
  return fingerprintKey(evidenceFingerprints(evidence), depth, namespace)
}
export function fingerprintKey(fingerprints: Record<string, string>, depth: DiagramState["granularity"], namespace = ""): string {
  return digest(JSON.stringify([namespace, depth, Object.entries(fingerprints).sort(([a], [b]) => a.localeCompare(b))]))
}

/** Only known, changed source dependencies can safely narrow an update. */
export function affectedViews(previous: AcceptedDiagram, evidence: readonly Evidence[], options: { knownOnly?: boolean } = {}): DiagramView[] {
  const next = evidenceFingerprints(evidence)
  const before = previous.fingerprints
  const changed = new Set([...new Set([...Object.keys(before), ...Object.keys(next)])].filter((id) => before[id] !== next[id]))
  const views = previous.analysis.views
  // Unknown scope must allow new views. Known edits can patch even a single view
  // or every existing view, not only a strict subset of a multi-view diagram.
  const full = options.knownOnly ? [] : views
  // Native mutations affect a file, not merely the read at its default offset.
  const mutatedFiles = new Set(evidence.filter((item) => changed.has(item.id) && item.mutation && item.file).map((item) => item.file))
  const knownMutation = (id: string) => {
    const mutation = evidence.find((item) => item.id === id && item.mutation)
    return !!mutation?.file && evidence.some((item) => item.file === mutation.file && before[item.id]
      && views.some((view) => diagramEvidence(view.graph).includes(item.id)))
  }
  for (const item of evidence) if (item.file && mutatedFiles.has(item.file)) changed.add(item.id)
  if ([...changed].some((id) => (!before[id] && !knownMutation(id)) || !next[id] || ["request", "context"].includes(evidence.find((item) => item.id === id)?.category ?? ""))) return full
  // A changed source not cited by any existing view can introduce structure.
  if ([...changed].some((id) => !knownMutation(id) && !views.some((view) => diagramEvidence(view.graph).includes(id)))) return full
  return views.filter((view) => diagramEvidence(view.graph).some((id) => changed.has(id)))
}
