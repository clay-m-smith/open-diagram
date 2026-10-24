import { createHash } from "node:crypto"
import type { SessionMessageInfo } from "@opencode/client"
import { selectEvidence, type EvidenceCandidate } from "./selection.js"
import { activeRequest, evidenceRole, focusPriority, substantiveRequest, type EvidenceRole } from "./focus.js"

export type Evidence = { id: string; label: string; text: string; at?: number; category?: EvidenceCandidate["category"]; file?: string; mutation?: boolean; fingerprint?: string; role?: EvidenceRole }
type Candidate = EvidenceCandidate & Pick<Evidence, "file" | "mutation" | "fingerprint" | "role"> & { position?: number }
const materialCategory = (category: EvidenceCandidate["category"]) => ["source", "structure", "inventory"].includes(category)

// Fixed, independent material/context budgets: adding chat or logs cannot steal
// source slots or resize source excerpts. Unused context quota stays unused.
function stableSelection(records: Candidate[], limit = 32, budget = 36_000) {
  // Resolve identity/category winners before partitioning; otherwise an older
  // context record can collide with and overwrite a newer material observation.
  const newest = new Map<string, Candidate>()
  for (const item of records) {
    const key = item.source === undefined ? `key:${item.key}` : `source:${item.source}`
    if (!newest.has(key) || newest.get(key)!.order <= item.order) { newest.delete(key); newest.set(key, item) }
  }
  records = [...newest.values()]
  const files = new Set(records.filter((item) => materialCategory(item.category) && item.file).map((item) => item.file))
  records = records.map((item) => item.file && files.has(item.file) && !materialCategory(item.category) ? { ...item, category: "source" } : item)
  const objective = activeRequest(records.map((item) => ({ ...item, id: item.key, at: item.order })))
  const request = objective?.text ?? ""
  records = records.map(item => ({ ...item, priority: item.category === "request"
    ? item.key === objective?.id ? 100 : 0 : focusPriority(request, item.label) }))
  const material = records.filter((item) => materialCategory(item.category))
  const materialLimit = Math.max(1, Math.floor(limit * 0.75))
  const materialBudget = Math.floor(budget * 0.78)
  // Operational receipts and tests cannot spend the subject's entire allowance.
  // With no subject material, supporting/non-code work gets the whole budget.
  const subject = material.filter(item => item.role !== "support")
  const support = material.filter(item => item.role === "support")
  const selectedMaterial = subject.length && support.length
    ? [...selectEvidence(subject, { limit: Math.max(1, Math.floor(materialLimit * 0.75)), budget: Math.floor(materialBudget * 0.75) }),
      ...selectEvidence(support, { limit: materialLimit - Math.max(1, Math.floor(materialLimit * 0.75)), budget: materialBudget - Math.floor(materialBudget * 0.75) })]
    : selectEvidence(material, { limit: materialLimit, budget: materialBudget })
  const selected = material.length ? [...selectedMaterial,
    ...selectEvidence(records.filter((item) => !materialCategory(item.category)),
      { limit: limit - materialLimit, budget: budget - materialBudget })] : selectEvidence(records, { limit, budget })
  const positions = new Map(records.map((item, index) => [`e_${digest(item.source === undefined ? `key:${item.key}` : `source:${item.source}`)}`, { order: item.order, index, category: item.category, role: item.role }]))
  return selected.sort((a, b) => positions.get(a.id)!.order - positions.get(b.id)!.order || positions.get(a.id)!.index - positions.get(b.id)!.index)
    .map((item) => ({ ...item, category: positions.get(item.id)!.category, ...(positions.get(item.id)!.role ? { role: positions.get(item.id)!.role } : {}) }))
}
export function cleanText(value: string, limit: number): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, limit)
}
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}

function boundedValue(value: unknown, depth = 0): string {
  if (typeof value === "string") return cleanText(value, 3000)
  if (value === null || typeof value !== "object") return String(value ?? "")
  if (depth > 3) return "[nested data omitted]"
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => boundedValue(item, depth + 1)).join("\n").slice(0, 4000)
  return Object.entries(value).slice(0, 20).flatMap(([key, item]) => {
    if (/token|password|secret|authorization|api.?key|base64|reasoning/i.test(key)) return []
    return [`${key}: ${boundedValue(item, depth + 1)}`]
  }).join("\n").slice(0, 4000)
}

function excerpt(value: string, limit: number): string {
  const text = cleanText(value, value.length)
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 22))}\n[excerpt truncated]`
}

function toolInput(name: string, input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const fields = input as Record<string, unknown>
    const path = fields.path ?? fields.filePath ?? ""
    // Replacement text is current evidence; an oldString can consume the whole
    // packet if native edit arguments are serialized in their ordinary order.
    if (name === "edit" && typeof fields.newString === "string") {
      return `path: ${String(path).slice(0, 240)}\nreplacement text:\n${excerpt(fields.newString, 2000)}\nprevious text (superseded):\n${excerpt(String(fields.oldString ?? ""), 400)}`
    }
    if (name === "patch" && typeof fields.patchText === "string") {
      const added = fields.patchText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      return `added lines:\n${excerpt(added.join("\n"), 2000)}\npatch context excerpt:\n${excerpt(fields.patchText, 500)}`
    }
  }
  return boundedValue(input)
}

/** Reserve room for live child evidence while retaining the parent's current job. */
export function mergeEvidence(parent: Evidence[], children: Evidence[]): Evidence[] {
  // A worker's compacted objective must not replace its parent's project focus.
  children = children.filter(item => item.category !== "context" && item.category !== "request")
  const files = new Set([...parent, ...children].filter((item) => item.file && item.category && materialCategory(item.category)).map((item) => item.file))
  const promote = (items: Evidence[]) => items.map((item) => item.file && files.has(item.file) && item.category && !materialCategory(item.category)
    ? { ...item, category: "source" as const } : item)
  parent = promote(parent)
  children = promote(children)
  const select = (items: Evidence[], limit: number, budget: number) => {
    const originals = new Map<string, Evidence>()
    const candidates = items.map((item, index) => {
      const key = `e_${digest(`source:${item.id}`)}`
      if (!originals.has(key) || (originals.get(key)!.at ?? 0) <= (item.at ?? index)) originals.set(key, item)
      return { key: item.id, source: item.id, label: item.label, text: item.text, category: item.category ?? "recent", order: item.at ?? index, file: item.file, role: item.role }
    })
    return stableSelection(candidates, limit, budget).map((item) => ({ ...originals.get(item.id)!, text: item.text, label: item.label, category: item.category }))
  }
  if (!children.some((item) => !item.category || materialCategory(item.category))) return select([...children, ...parent], 32, 36_000)
  // Deduplicate shared files by actual observation order, not parent/child role.
  const newest = new Map<string, Evidence>()
  for (const item of [...children, ...parent]) if (!newest.has(item.id) || (item.at ?? 0) >= (newest.get(item.id)!.at ?? 0)) newest.set(item.id, item)
  const childIDs = new Set(children.filter((item) => newest.get(item.id) === item).map((item) => item.id))
  return [...select([...newest.values()].filter((item) => childIDs.has(item.id)), 8, 10_000),
    ...select([...newest.values()].filter((item) => !childIDs.has(item.id)), 24, 26_000)]
}

function category(name: string, path: string, output: string): EvidenceCandidate["category"] {
  if (/(?:^|\/)(?:node_modules|\.git)\//i.test(path)) return "recent"
  if (/\.(?:md|mdx|rst|adoc)$/i.test(path) || /(?:package|tsconfig|config|schema)[^/]*\.json$/i.test(path)) return "structure"
  if (/\.(?:py|[cm]?[jt]sx?|rs|go|java|kt|scala|c|cc|cpp|h|hpp|cs|rb|php|swift|sh|sql|tf|proto|graphql|ya?ml|toml|v|sv|vh|svh|vhd|vhdl|dts|dtsi|ld|sdc|xdc|ioc|kicad_sch|kicad_sym|kicad_pcb|net)$/i.test(path)
    ) return "source"
  if (/(?:^|\/)(?:runs?|logs?|artifacts?)\//i.test(path)) return "recent"
  if (["edit", "patch", "write"].includes(name)) return "source"
  if (name === "glob" || /^Read directory\b/.test(output)) return "inventory"
  if (/architect|design|workflow|diagram|protocol|schema|pipeline|overview|outline/i.test(path)
    || /(?:^|\n)(?:\d+: )?(?:#{1,5} .*?(?:architecture|flow|design|pipeline)|(?:export )?(?:class|interface|def|function) |flowchart |sequenceDiagram)/im.test(output)) return "structure"
  // Successful file reads are material regardless of extension, before the
  // retention window can age them out. Excluded directories remain context.
  if (name === "read" && path) return "source"
  return "recent"
}

/** Only public conversation/compaction text and completed text tool evidence;
 * never system instructions, reasoning, provider state or media. */
export function collectEvidence(messages: readonly SessionMessageInfo[]): Evidence[] {
  const records: Candidate[] = []
  let subjectMessages = 0, supportMessages = 0
  const objective = messages.findLast(message => message.type === "user" && substantiveRequest(message.text))
  const latestRequest = messages.findLast(message => message.type === "user")
  // Keep cumulative design refinements, especially when no files exist yet.
  // Repeated acknowledgements and repeated identical objectives add no history.
  const requests = new Set<SessionMessageInfo>()
  const requestTexts = new Set<string>()
  for (let index = messages.length - 1; index >= 0 && requests.size < 4; index--) {
    const message = messages[index]
    if (message.type !== "user" || !substantiveRequest(message.text) || requestTexts.has(message.text.trim())) continue
    requests.add(message); requestTexts.add(message.text.trim())
  }
  const request = objective?.type === "user" ? objective.text : ""
  const compaction = messages.findLast(message => message.type === "compaction" && message.status === "completed")
  // Chat cannot age source observations out of the material window.
  for (let index = messages.length - 1; index >= 0; index--) {
    const recent = index >= messages.length - 120
    const message = messages[index]
    const at = message.time?.created ?? index
    if (message === compaction && message.type === "compaction" && message.status === "completed") {
      // context() replaces older turns with this public summary. Ignoring it
      // loses the subject/version being designed while retaining recent chores.
      // One stable identity lets a newer compaction supersede, not accumulate.
      records.push({ key: "compacted-context", source: "compacted-context", label: "Compacted context (historical, not source proof)",
        text: message.summary, category: "context", order: at, position: index * 1024 })
    }
    // Only the latest acknowledgement accompanies bounded substantive history.
    if (message.type === "user" && (requests.has(message) || message === latestRequest)) records.push({ key: message.id,
      ...(message === objective ? { source: "active-objective" } : {}), label: message === objective ? "Active user objective" : "User request",
      text: message.text, category: "request", role: substantiveRequest(message.text) ? "subject" : "support", order: at, position: index * 1024 })
    if (message.type !== "assistant") continue
    // Always scan cheap user/compaction metadata, even after material retention
    // fills. Supporting activity cannot age the actual subject out of its window.
    if (!recent && subjectMessages >= 120 && supportMessages >= 120) continue
    const start = records.length
    for (const [partIndex, part] of message.content.slice(-128).entries()) {
      const order = at + partIndex / 1000
      if (part.type === "text") records.push({ key: `${message.id}:text:${partIndex}`, label: "Assistant design (not proof of implementation)", text: part.text, category: "assistant", order, position: index * 1024 + partIndex })
      if (part.type !== "tool" || !["completed", "error"].includes(part.state.status)) continue
      if (part.state.status !== "completed" && part.state.status !== "error") continue
      // Ignore credentials and unrelated opaque service tools; read no private plugin state.
      if (!/^(read|grep|glob|patch|write|edit|shell|execute|subagent)$/.test(part.name)) continue
      const input = toolInput(part.name, part.state.input)
      if (/(?:^|[\s/])(?:\.env(?:\.[\w-]+)?|credentials|id_rsa|id_ed25519)(?:[\s:]|$)/i.test(input)) continue
      if (part.name === "execute" && /tooling_(?:context|memory)|open_diagram_|quota|credential/i.test(input)) continue
      const output = (part.state.content ?? []).slice(0, 16).flatMap((content) => content.type === "text" ? [content.text.slice(0, 131_072)] : []).join("\n").slice(0, 262_144)
      const arguments_ = part.state.input
      const path = typeof arguments_ === "object" && arguments_ !== null
        ? ["path", "filePath", "file"].map((key) => arguments_[key]).find((value) => typeof value === "string") : undefined
      // File dependency and observation identity are distinct: partial edits
      // must survive one another and subsequent partial rereads.
      const mutation = part.state.status === "completed" && ["edit", "write", "patch"].includes(part.name)
      const source = part.state.status !== "completed" ? undefined
        : mutation ? `mutation:${message.id}:${part.id}`
        : typeof path === "string" && part.name === "read" ? `${path}:${(arguments_ as Record<string, unknown>).offset ?? 1}`
        : part.name === "glob" ? `glob:${JSON.stringify(part.state.input)}` : undefined
      const patchPaths = part.name === "patch" && arguments_ && typeof arguments_ === "object" && typeof arguments_.patchText === "string"
        ? [...arguments_.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]) : []
      const patchKinds = patchPaths.map(path => category("patch", path, ""))
      const kind = part.state.status !== "completed" ? "recent"
        : patchKinds.length ? patchKinds.includes("source") ? "source" : patchKinds.includes("structure") ? "structure" : "recent"
        : category(part.name, String(path ?? ""), output)
      const roles = (patchPaths.length ? patchPaths : [String(path ?? "")]).map(path => evidenceRole(path, request))
      const role = ["subagent", "shell", "execute"].includes(part.name) ? "support"
        : roles.includes("subject") ? "subject" : roles.includes("support") ? "support" : "instruction"
      if (role === "instruction") continue
      records.push({ key: part.id, source, label: `${part.name}${path ? ` · ${path}` : ""} · ${part.state.status}`,
        text: part.name === "edit" || part.name === "patch" ? `${input}\n${output.slice(0, 600)}` : `${input.slice(0, part.name === "shell" || part.name === "execute" ? 400 : 600)}\n${output}`,
        category: kind,
        role,
        file: part.state.status === "completed" && typeof path === "string" ? digest(path) : undefined,
        mutation,
        fingerprint: materialCategory(kind) || (part.state.status === "completed" && typeof path === "string") ? digest(JSON.stringify([part.name, part.state.input,
          (part.state.content ?? []).filter((content) => content.type === "text")])) : undefined,
        position: index * 1024 + partIndex,
        order: part.time?.completed ?? part.time?.created ?? order })
    }
    const candidates = records.splice(start)
    const subject = candidates.filter((item) => materialCategory(item.category) && item.role !== "support")
    const support = candidates.filter((item) => materialCategory(item.category) && item.role === "support")
    if (subject.length && subjectMessages++ < 120) records.push(...subject)
    if (support.length && supportMessages++ < 120) records.push(...support)
    if (recent) records.push(...candidates.filter((item) => !materialCategory(item.category)))
  }
  records.sort((a, b) => a.position! - b.position!)
  const metadata = new Map<string, Candidate>()
  for (const record of records) {
    const id = `e_${digest(record.source === undefined ? `key:${record.key}` : `source:${record.source}`)}`
    if (!metadata.has(id) || metadata.get(id)!.order <= record.order) metadata.set(id, record)
  }
  return stableSelection(records).map((item) => {
    const record = metadata.get(item.id)!
    // Native RPC requires JSON values, not optional keys present as undefined.
    return { ...item, at: record.order,
      ...(record.file ? { file: record.file } : {}), ...(record.mutation ? { mutation: true } : {}),
      ...(record.fingerprint ? { fingerprint: record.fingerprint } : {}) }
  })
}

/** Cheap prefilter; the model makes the final relevance decision. */
export function candidateWork(evidence: readonly Evidence[]): boolean {
  // Relevance is semantic and domain-independent; only skip empty/trivial input.
  return evidence.some((item) => item.text.trim().length >= 16)
}
