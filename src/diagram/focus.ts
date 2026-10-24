import type { Evidence } from "./evidence.js"

export type EvidenceRole = "subject" | "support" | "instruction"

/** Acknowledgements advance a conversation, not its diagram subject. Unknown
 * requests remain meaningful; this is deliberately not a domain classifier. */
export function substantiveRequest(text: string): boolean {
  const value = text.trim().replace(/[.!?]+$/g, "").toLowerCase()
  if (!value) return false
  if (/^(?:(?:please|thanks|thank|you|continue|proceed|okay|ok|yes|no|go|on|ahead|resume|stop|keep|checking|tracking|the|current|implementation)[\s,!.]*)+$/.test(value)) return false
  return !/^(?:any updates|status update|what(?:'s| is) the status|are you (?:hanging|still there)|continue if there(?:'s| is) anything left to do|anything else to do while we wait)$/.test(value)
}

export function activeRequest(evidence: readonly Evidence[]): Evidence | undefined {
  return evidence.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.category === "request" && item.role !== "support" && substantiveRequest(item.text))
    .sort((a, b) => (a.item.at ?? a.index) - (b.item.at ?? b.index) || a.index - b.index).at(-1)?.item
}

/** Roles describe evidence, never diagram families. A test, instruction set, or
 * operational workflow can itself be the explicitly requested subject. */
export function evidenceRole(path: string, request: string): EvidenceRole {
  const normalized = path.replaceAll("\\", "/")
  const name = normalized.split("/").at(-1) ?? ""
  const explicitFile = name.length > 3 && request.toLowerCase().includes(name.toLowerCase())
  const instruction = /(?:^|\/)(?:AGENTS\.md|SKILL\.md)$/i.test(normalized)
    || /(?:^|\/)\.opencode\/(?:skills|agents|commands|instructions)\//i.test(normalized)
  if (instruction) return explicitFile || /\b(?:diagram|map|show|explain|focus on|visuali[sz]e|design|author|create|edit|update)\b[^.!?\n]{0,80}\b(?:skills?|agents?|instructions?|prompts?)\b/i.test(request) ? "subject" : "instruction"
  const support = /(?:^|\/)(?:tests?|__tests__|scripts|tools)\//i.test(normalized)
    || /(?:^|[_-])(?:test|check|verify|analy[sz]e|analysis|summari[sz]e)(?:[_\.-]|$)/i.test(name)
    || /^(?:status|handoff|notes|worklog|manifest|research[-_](?:state|log))\./i.test(name)
    || /\.(?:log|jsonl)$/i.test(name)
  if (!support || explicitFile) return "subject"
  return /\b(?:diagram|map|show|explain|focus on|visuali[sz]e|design)\b.{0,80}\b(?:test\w*|validat\w*|verif\w*|analy[sz]\w*|audit\w*|recovery|status|handoff|report\w*|workflow|process)\b/i.test(request)
    ? "subject" : "support"
}

const STOP = new Set("about active actual architecture current diagram develop development evidence explain focus from have into just latest model project research show software some system that their there these this through using want what when where which with work working would".split(" "))

/** Bounded lexical preference for explicitly named subjects, not semantic proof.
 * Recency still resolves versions; unmatched domains keep ordinary selection. */
export function focusPriority(request: string, label: string): number {
  const terms = [...new Set(request.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? [])]
    .filter(term => !STOP.has(term)).slice(0, 64)
  // Rank named artifacts, not repeated goal/process prose in their contents.
  // Otherwise generic objectives favor long receipts over actual structures.
  const haystack = label.toLowerCase()
  return Math.min(8, terms.filter(term => haystack.includes(term)).length)
}
