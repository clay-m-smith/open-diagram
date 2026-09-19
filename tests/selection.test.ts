import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { selectEvidence, structuralExcerpt, type EvidenceCandidate } from "../src/diagram/selection.js"

function candidate(key: string, category: EvidenceCandidate["category"], text: string, order: number, source?: string): EvidenceCandidate {
  return { key, category, text, order, source, label: `${category} · ${source ?? key}` }
}

function cost(records: ReturnType<typeof selectEvidence>): number {
  return records.reduce((sum, record) => sum + record.id.length + record.label.length + record.text.length, 0)
}

function numbered(lines: string[]): string {
  return lines.map((line, index) => `${index + 1}: ${line}`).join("\n")
}

test("early service implementation, config, and architecture survive later logs and artifacts", () => {
  const service = numbered([
    ...Array.from({ length: 180 }, (_, index) => `// license and introductory note ${index}`),
    "export class DispatchService {",
    "  async dispatch(order) {",
    "    const route = this.router.resolve(order.region)",
    "    await this.queue.publish(route, order)",
    "    return this.audit.record(order.id)",
    "  }",
    "}",
    ...Array.from({ length: 150 }, (_, index) => `// generated reference note ${index}`),
  ])
  const document = numbered([
    "# Delivery system",
    ...Array.from({ length: 200 }, (_, index) => `Background context ${index}.`),
    "## Message delivery flow",
    "Gateway -> DispatchService -> Queue -> DeliveryWorker",
    "DeliveryWorker publishes to ReceiptStore",
    ...Array.from({ length: 220 }, (_, index) => `Operational appendix ${index}.`),
  ])
  const input = [
    candidate("config", "source", "services:\n  gateway:\n    depends_on: [queue]\n  queue:\n    image: broker:4", 1, "deploy/compose.yml:1-30"),
    candidate("router", "source", "export function route(region) {\n  return queues.get(region)\n}", 2, "src/router.ts:1-60"),
    candidate("service", "source", service, 3, "src/dispatch.ts:1-337"),
    candidate("architecture", "structure", document, 4, "docs/delivery.md:1-424"),
    candidate("old-request", "request", "Explain the HTTP endpoint.", 5),
    ...Array.from({ length: 100 }, (_, index) => candidate(`log-${index}`, "recent", `audit run ${index}\n${"elapsed=20ms completed=true\n".repeat(200)}`, index + 10)),
    ...Array.from({ length: 20 }, (_, index) => candidate(`artifact-${index}`, "recent", `artifact report ${index}\n${"checked file checksum\n".repeat(120)}`, index + 110)),
    candidate("latest-request", "request", "Diagram delivery dependencies and the dispatch-to-receipt workflow.", 140),
  ]
  const records = selectEvidence(input)
  const text = records.map((record) => record.text).join("\n")
  assert.match(text, /depends_on: \[queue\]/)
  assert.match(text, /export function route/)
  assert.match(text, /await this\.queue\.publish\(route, order\)/)
  assert.match(text, /Gateway -> DispatchService -> Queue -> DeliveryWorker/)
  assert.match(text, /Diagram delivery dependencies/)
  assert.ok(records.length <= 32)
  assert.ok(cost(records) <= 36_000)
  assert.ok(records.every((record) => record.text.length <= 4000 && record.label.length <= 160))
})

test("workflow and repository-inventory categories receive useful reservations", () => {
  const input = [
    candidate("tree", "inventory", "workspace/\n├── apps/api/\n├── packages/events/\n└── deploy/charts/", 1, "workspace-tree"),
    candidate("flow", "structure", "# Release workflow\nBuild -> Package -> Sign -> Deploy\nDeploy depends on approval", 2, "docs/release.md"),
    ...Array.from({ length: 50 }, (_, index) => candidate(`output-${index}`, "recent", "build output\n".repeat(300), index + 3)),
    candidate("request", "request", "Show the repository layout and release handoffs.", 100),
  ]
  const records = selectEvidence(input, { budget: 8000, limit: 8 })
  assert.ok(records.some((record) => record.text.includes("packages/events/")))
  assert.ok(records.some((record) => record.text.includes("Build -> Package -> Sign -> Deploy")))
  assert.ok(records.some((record) => record.text.includes("release handoffs")))
  assert.ok(cost(records) <= 8000)
  assert.ok(records.length <= 8)
})

test("structural excerpts include function bodies beyond introductory material", () => {
  const source = numbered([
    ...Array.from({ length: 300 }, (_, index) => `// introductory copyright ${index}`),
    "class TicketRouter:",
    "    def deliver(self, ticket):",
    "        target = self.registry.resolve(ticket.team)",
    "        self.queue.send(target, ticket)",
    "        return target",
    ...Array.from({ length: 300 }, (_, index) => `# reference appendix ${index}`),
  ])
  const excerpt = structuralExcerpt(source, 2400)
  assert.match(excerpt, /302:     def deliver\(self, ticket\):/)
  assert.match(excerpt, /304:         self\.queue\.send\(target, ticket\)/)
  assert.match(excerpt, /\[\.\.\. omitted \.\.\.\]/)
  assert.ok(excerpt.length <= 2400)
  const originalLines = new Set(source.split("\n"))
  const lineNumbers = [...excerpt.matchAll(/(?:^|\n)(\d+):/g)].map((match) => Number(match[1]))
  assert.deepEqual(lineNumbers, [...lineNumbers].sort((a, b) => a - b))
  for (const line of excerpt.split("\n")) {
    if (line.includes("self.queue.send")) assert.ok(originalLines.has(line))
  }
})

test("headings, configuration, and dependency arrows remain domain-neutral", () => {
  for (const body of [
    "## Incident response\nAlert -> Triage -> Mitigation\nMitigation depends on incident commander",
    "[services.worker]\nqueue = dispatch\nconcurrency = 8\nretry = bounded",
    "function settle(invoice) {\n  const ledger = reconcile(invoice)\n  return ledger.commit()\n}",
  ]) {
    const text = `${"Introductory note.\n".repeat(250)}${body}\n${"Appendix detail.\n".repeat(250)}`
    const excerpt = structuralExcerpt(text, 1800)
    assert.ok(excerpt.includes(body), body)
    assert.ok(excerpt.length <= 1800)
  }
})

test("exact sources deduplicate to latest order while distinct ranges remain separate", () => {
  const input = [
    candidate("new-read", "source", "function current() {}", 30, "src/jobs.ts:1-20"),
    candidate("same-call", "source", "function otherRange() {}", 20, "src/jobs.ts:21-40"),
    candidate("same-call", "source", "function stale() {}", 1, "src/jobs.ts:1-20"),
    candidate("note", "assistant", "old design", 2),
    candidate("note", "assistant", "current design", 25),
  ]
  const records = selectEvidence(input)
  assert.deepEqual(records.map((record) => record.text), ["function otherRange() {}", "current design", "function current() {}"])
  assert.equal(new Set(records.map((record) => record.id)).size, 3)
  assert.deepEqual(records, selectEvidence([...input].reverse()))
})

test("citation IDs depend on stable identity, not excerpt budget or unrelated later logs", () => {
  const source = candidate("read-12", "source", `export class Billing {\n${"  charge() { return ledger.post() }\n".repeat(150)}}`, 1, "src/billing.ts:1-200")
  const large = selectEvidence([source])
  const small = selectEvidence([source], { budget: 700 })
  const flooded = selectEvidence([source, ...Array.from({ length: 300 }, (_, index) => candidate(`log-${index}`, "recent", "done", index + 2))])
  const expected = `e_${createHash("sha256").update("source:src/billing.ts:1-200").digest("hex").slice(0, 24)}`
  assert.equal(large[0]?.id, expected)
  assert.equal(small[0]?.id, expected)
  assert.equal(flooded.find((record) => record.label.includes("src/billing.ts"))?.id, expected)
  assert.match(expected, /^e_[a-f0-9]{24}$/)
  assert.notEqual(large[0]?.text, small[0]?.text)
  assert.ok(cost(small) <= 700)
})

test("latest request wins a single slot and remains represented at minimal feasible budget", () => {
  const input = [
    candidate("latest", "request", "Current workflow question", 100),
    candidate("source", "source", "export class Queue {}", 3),
    candidate("old", "request", "Previous question", 1),
    candidate("log", "recent", "later command output", 200),
  ]
  const single = selectEvidence(input, { limit: 1, budget: 100 })
  assert.equal(single.length, 1)
  assert.match(single[0]!.text, /^Current/)
  const minimal = selectEvidence(input, { budget: 27 })
  assert.equal(minimal.length, 1)
  assert.equal(minimal[0]!.id, single[0]!.id)
  assert.equal(minimal[0]!.text, "C")
  assert.equal(cost(minimal), 27)
  assert.deepEqual(selectEvidence(input, { budget: 26 }), [])
})

test("oversized latest request retains final constraints as well as opening task", () => {
  const request = `Diagram the settlement workflow.\n${"Additional background.\n".repeat(500)}FINAL CONSTRAINT: include reversal handling.`
  const records = selectEvidence([candidate("request", "request", request, 1)])
  assert.match(records[0]!.text, /^Diagram the settlement workflow/)
  assert.match(records[0]!.text, /FINAL CONSTRAINT: include reversal handling\.$/)
  assert.ok(records[0]!.text.length <= 4000)
})

test("leading whitespace cannot hide the latest request at a small budget", () => {
  const input = [
    candidate("old", "request", "Old request", 1),
    candidate("latest", "request", "\n\t  Current request\n", 2),
  ]
  const records = selectEvidence(input, { budget: 27, limit: 1 })
  assert.equal(records.length, 1)
  assert.equal(records[0]!.text, "C")
})

test("strict budgets hold across tiny, fractional, and invalid options", () => {
  const input = [
    candidate("request", "request", "Explain this workflow. ".repeat(600), 20),
    candidate("code", "source", "export function step() { return next() }\n".repeat(600), 1),
    candidate("doc", "structure", "# Architecture\nService -> Queue -> Worker\n".repeat(600), 2),
    candidate("inventory", "inventory", "packages/runtime\npackages/web\n".repeat(600), 3),
    candidate("recent", "recent", "diagnostic output\n".repeat(600), 30),
  ].map((item) => ({ ...item, label: "long label ".repeat(100) }))
  for (const budget of [0, 1, 26, 27, 28, 48, 100, 500, 1000, 4000, 4000.9, 36_000]) {
    for (const limit of [0, 1, 2, 5, 32]) {
      const records = selectEvidence(input, { budget, limit })
      assert.ok(cost(records) <= Math.floor(budget), `${budget}/${limit}: ${cost(records)}`)
      assert.ok(records.length <= limit)
      assert.ok(records.every((record) => record.text.length <= 4000 && record.label.length <= 160))
      if (budget >= 27 && limit > 0) assert.ok(records.some((record) => record.id === `e_${createHash("sha256").update("key:request").digest("hex").slice(0, 24)}`))
    }
  }
  for (const invalid of [-10, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(selectEvidence(input, { budget: invalid }), [])
    assert.deepEqual(selectEvidence(input, { limit: invalid }), [])
  }
})

test("unused reservations fill inventory-only sessions", () => {
  const input = Array.from({ length: 12 }, (_, index) => candidate(`tree-${index}`, "inventory", `workspace-${index}/\n  src/\n  docs/\n  tests/`, index))
  const records = selectEvidence(input, { budget: 4000, limit: 12 })
  assert.equal(records.length, 12)
  assert.ok(records.every((record) => record.label.startsWith("inventory")))
  assert.ok(cost(records) <= 4000)
})

test("large log histories cannot evict separate source and request pools", () => {
  const input = [
    candidate("source", "source", "fn route(event) { queue.send(event); }", 1, "src/route.rs"),
    candidate("request", "request", "Map the queue workflow", 2),
    ...Array.from({ length: 10_000 }, (_, index) => candidate(`log-${index}`, "recent", `completed ${index}`, index + 3)),
  ]
  const records = selectEvidence(input)
  assert.ok(records.some((record) => record.text.includes("fn route")))
  assert.ok(records.some((record) => record.text === "Map the queue workflow"))
  assert.ok(records.some((record) => record.text === "completed 9999"))
  assert.ok(records.length <= 32)
})

test("latest deduplicated value wins even after eviction from another category", () => {
  const input = [
    candidate("old", "source", "obsolete implementation", 1, "same-resource"),
    candidate("updated", "recent", "new implementation", 2, "same-resource"),
    ...Array.from({ length: 400 }, (_, index) => candidate(`log-${index}`, "recent", `output ${index}`, index + 3)),
  ]
  assert.ok(selectEvidence(input).every((record) => !record.text.includes("obsolete implementation")))
})

test("terminal controls are stripped while line labels, tabs, and newlines survive", () => {
  const text = "\x1b[31m1: function run() {\x1b[0m\n2:\treturn queue.next()\x00\n3: }\n\x1b]8;;https://invalid.example\x07link\x1b]8;;\x07"
  const expected = "1: function run() {\n2:\treturn queue.next()\n3: }\nlink"
  assert.equal(structuralExcerpt(text, 4000), expected)
  const records = selectEvidence([{ ...candidate("safe", "source", text, 1), label: "\x1b[32msource\x1b[0m\nfile" }])
  assert.equal(records[0]!.text, expected)
  assert.equal(records[0]!.label, "source file")
  assert.doesNotMatch(JSON.stringify(records), /\\u001b|\\u0000/)
  assert.equal(structuralExcerpt("\x1b7start\x1b8\x1bPignored payload\x1b\\\n\x9b32m\tend\x9b0m", 4000), "start\n\tend")
})

test("excerpt sampling remains bounded for huge inputs and all output limits", () => {
  const text = Array.from({ length: 30_000 }, (_, index) => `${index + 1}: function step_${index}() { return next(${index}) }`).join("\n")
  for (const limit of [0, 1, 17, 18, 35, 36, 37, 50, 100, 600, 1800, 4000]) {
    const excerpt = structuralExcerpt(text, limit)
    assert.ok(excerpt.length <= limit, `${limit}: ${excerpt.length}`)
  }
  const excerpt = structuralExcerpt(text, 4000)
  assert.match(excerpt, /step_\d{4,}/)
  assert.match(excerpt, /\[\.\.\. omitted \.\.\.\]/)
})

test("selection does not mutate candidates or interpret paths and command-looking text", () => {
  const item = Object.freeze(candidate("untrusted", "source", "function task() { return '$(touch /not-executed)' }", 1, "/not-read/private.ts:1-2"))
  const input = Object.freeze([item])
  const before = JSON.stringify(input)
  const records = selectEvidence(input)
  assert.equal(records[0]!.text, item.text)
  assert.equal(JSON.stringify(input), before)
})
