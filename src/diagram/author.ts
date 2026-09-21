import type { Evidence } from "./evidence.js"
import { diagramRequest, parseDiagramOutput, DiagramOutputError } from "./harness.js"
import type { DiagramGraph, DiagramGranularity, DiagramUpdate } from "./schema.js"
import { mapDiagramEvidence } from "./notation.js"

/** Short, exact transport citations; durable IDs never depend on model spelling. */
export function authorRequest(evidence: readonly Evidence[], previous: DiagramGraph | null, forced: boolean, granularity: DiagramGranularity = "overview", update?: DiagramUpdate) {
  const aliases = new Map(evidence.map((item, index) => [`e${index + 1}`, item.id]))
  const input = evidence.map((item, index) => ({ ...item, id: `e${index + 1}` }))
  // Prior citations belong to another snapshot. Only identity/layout is a hint.
  const hint = previous && mapDiagramEvidence(previous, () => [])
  const request = diagramRequest(input, hint, forced, granularity)
  if (update) {
    request.instruction += update.replaceAll
      ? "\nIncremental update: all cached views are affected. Prefer stable view/node IDs; keep labels when accurate, correct them when misleading. Return a reorganized complete view set if current structure needs it. Do not omit architecture merely to preserve the old view count."
      : `\nIncremental update: return exactly these existing view IDs (listed labels are current hints, not constraints): ${JSON.stringify(update.views.map(({ id, label }) => ({ id, label })))}. Do not create or return other views. Correct misleading labels and structure within the selected views. Return each selected view's complete graph; keep stable node IDs and grounded details. Unselected views are cached separately and will not be regenerated.`
    request.instruction += ` Your returned views may contain at most ${update.maxNodes ?? 48} nodes TOTAL; remaining nodes are reserved by untouched cached views. This overrides the general 48-node total. File mutation observations are ordered deltas: combine them with baseline reads; a later partial read does not erase changes outside its range.`
    Object.assign(request.input, { update: { maxNodes: update.maxNodes ?? 48, replaceAll: !!update.replaceAll, views: update.views.map((view) => ({ ...view, graph: mapDiagramEvidence(view.graph, () => []) })) } })
  }
  return {
    request,
    parse(text: string) {
      const result = parseDiagramOutput(text, input)
      if (update && result.views.reduce((sum, view) => sum + view.graph.nodes.length, 0) > (update.maxNodes ?? 48)) {
        throw new DiagramOutputError("schema", `Incremental views exceed remaining ${update.maxNodes ?? 48}-node total budget`)
      }
      for (const view of result.views) view.graph = mapDiagramEvidence(view.graph, (ids) => ids.map((id) => aliases.get(id)!))
      return { ...result, graph: result.views[0]?.graph ?? null }
    },
  }
}
