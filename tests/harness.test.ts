import assert from "node:assert/strict"
import test from "node:test"
import { diagramOutputSchema, nativeDiagramOutputSchema, diagramRequest, parseDiagramOutput, validateDiagramOutput, ViewAnalysisSchema } from "../src/diagram/harness.js"
import { DiagramEngine } from "../src/diagram/engine.js"
import { SnapshotSchema } from "../src/diagram/schema.js"

const evidence = [{ id: "e_source", label: "Current design", text: "A client sends orders to a queue. A worker stores them." }]
const node = (id: string, kind: string) => ({ id, label: id, kind, detail: "", status: "planned", evidence: ["e_source"] })
const graph = (title: string) => ({ title, summary: "", nodes: [node("client", "person"), node("queue", "message-broker")], edges: [{ from: "client", to: "queue", label: "orders" }] })
const output = () => ({ relevant: true, reason: "Two useful structures", views: [
  { id: "system", label: "System", graph: graph("Order flow") },
  { id: "repository", label: "Repository", graph: graph("Package dependencies") },
] })

test("model-neutral harness accepts multiple views and arbitrary node types", () => {
  const request = diagramRequest(evidence, null, false)
  assert.equal(request.version, 1)
  assert.match(request.instruction, /Any domain/)
  assert.ok(request.outputSchema)
  assert.equal(request.input.evidence, evidence)
  for (const depth of ["overview", "granular"] as const) {
    assert.ok(SnapshotSchema.shape.instruction.safeParse(diagramRequest(evidence, null, false, depth).instruction).success,
      "shared authoring policy must fit the public snapshot contract at both depths")
  }
  const result = parseDiagramOutput(JSON.stringify(output()), evidence)
  assert.equal(result.views?.length, 2)
  assert.equal(result.views[0].graph.title, "Order flow")
  assert.equal(ViewAnalysisSchema.safeParse(result).success, true, "parsed output composes directly with wire publication")
  assert.equal(result.views?.[0].graph.nodes[1].kind, "message-broker")
})

test("strict endpoint schemas require every property without changing legacy runtime acceptance", () => {
  const visit = (schema: any) => {
    if (!schema || typeof schema !== "object") return
    if (schema.type === "object" && schema.properties) {
      assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)))
    }
    for (const value of Object.values(schema)) if (Array.isArray(value)) value.forEach(visit); else visit(value)
  }
  visit(diagramOutputSchema({ strict: true }))
  assert.equal(validateDiagramOutput(output(), evidence).views.length, 2)
  const native = nativeDiagramOutputSchema()
  const expand = (value: any): any => {
    if (Array.isArray(value)) return value.map(expand)
    if (!value || typeof value !== "object") return value
    if (value.$ref) return expand(native.$defs![value.$ref.split("/").at(-1)])
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$defs").map(([key, entry]) => [key, expand(entry)]))
  }
  assert.deepEqual(expand(native), diagramOutputSchema(), "native references preserve every schema constraint")
  assert.ok(JSON.stringify(native).length < JSON.stringify(diagramOutputSchema()).length * 0.75)
})

test("JSON parsing preserves literals and rejects malformed output without echoing values", () => {
  const value = output()
  value.views[0].graph.nodes[0].detail = 'Keep literal ,} and ,] plus "quoted" text unchanged'
  const raw = JSON.stringify(value)
  for (const text of [raw, `\`\`\`json\n${raw}\n\`\`\``]) {
    assert.deepEqual(parseDiagramOutput(text, evidence), value)
  }
  for (const text of [raw.slice(0, -1), `${raw}\n${raw}`, `Diagram: [${raw}]`, '{"relevant":true "views":[]}', raw.slice(0, -1) + ",}",
    '{relevant:true,views:[', '{relevant:process.exit(),views:[]}', '{relevant:true,views:undefined}', '{relevant:true,/* unterminated']) {
    assert.throws(() => parseDiagramOutput(text, evidence), /not valid JSON/)
  }
  assert.throws(() => parseDiagramOutput('{"PRIVATE_FIELD" "PRIVATE_VALUE"}', evidence), (error: Error) =>
    /not valid JSON \(colon; \d+ chars\)/.test(error.message) && !error.message.includes("PRIVATE"))
  const uncited = output(); uncited.views[0].graph.nodes[0].evidence = ["invented"]
  assert.throws(() => parseDiagramOutput(JSON.stringify(uncited), evidence), /outside current snapshot/)
})

test("public harness rejects unknown citations, duplicate views and malformed output without echoing bodies", () => {
  const uncited = output()
  uncited.views[1].graph.nodes[0].evidence = ["invented"]
  assert.throws(() => validateDiagramOutput(uncited, evidence), /outside current snapshot/)
  const duplicate = output()
  duplicate.views[1].id = duplicate.views[0].id
  assert.throws(() => validateDiagramOutput(duplicate, evidence), /Invalid diagram schema/)
  assert.throws(() => parseDiagramOutput("PRIVATE_NOT_JSON", evidence), (error: Error) => !error.message.includes("PRIVATE_NOT_JSON") && /not valid JSON/.test(error.message))
  assert.throws(() => validateDiagramOutput({ ...output(), extra: "PRIVATE" }, evidence), /Invalid diagram schema/)
  const malformed = output()
  Object.assign(malformed.views[0].graph.nodes[0], { evidence: null, PRIVATE_PROPERTY: "PRIVATE_VALUE" })
  assert.throws(() => validateDiagramOutput(malformed, evidence), (error: Error) =>
    /nodes.0.evidence \(expected array\)/.test(error.message) && /unexpected fields/.test(error.message) && !/PRIVATE/.test(error.message))
})

test("empty unrelated result and legacy single-view adapters remain valid", () => {
  assert.deepEqual(validateDiagramOutput({ relevant: false, reason: "No structure", views: [] }, evidence).views, [])
  assert.equal(validateDiagramOutput({ relevant: true, reason: "Design", graph: graph("Workflow") }, evidence).views[0].graph.title, "Workflow")
})

test("functional explanation is optional, bounded, plain text and preserved through publication", async () => {
  const value = output()
  const target = value.views[0].graph.nodes[0] as ReturnType<typeof node> & { behavior?: string }
  target.behavior = "Validates order fields, then sends accepted orders to the queue for asynchronous processing."
  assert.equal(validateDiagramOutput(value, evidence).views[0].graph.nodes[0].behavior, target.behavior)
  for (const invalid of ["x".repeat(601), "hidden\u001b[31mcontrol", "two\nlines"]) {
    assert.throws(() => validateDiagramOutput({ ...value, views: [{ ...value.views[0], graph: { ...value.views[0].graph,
      nodes: [{ ...target, behavior: invalid }], edges: [],
    } }] }, evidence), /Invalid diagram schema/)
  }
  let saved: unknown
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, load: async () => saved, save: async (_id, state) => { saved = state }, publish: async () => {} })
  try {
    await engine.observe("a", evidence)
    const snapshot = await engine.snapshot("a")
    const result = await engine.submit("a", snapshot.token, parseDiagramOutput(JSON.stringify(value), evidence))
    assert.equal(result.views[0].graph.nodes[0].behavior, target.behavior)
  } finally { await engine.dispose() }
  const reloaded = new DiagramEngine({ intervalMs: 1, debounceMs: 1, load: async () => saved, save: async () => {}, publish: async () => {} })
  try { assert.equal((await reloaded.get("a")).views[0].graph.nodes[0].behavior, target.behavior) }
  finally { await reloaded.dispose() }
})

test("public parsed output publishes without undocumented field stripping", async () => {
  const engine = new DiagramEngine({ intervalMs: 1, debounceMs: 1, load: async () => undefined, save: async () => {}, publish: async () => {} })
  try {
    await engine.observe("a", evidence)
    for (const input of [output(), { relevant: true, reason: "Legacy", graph: graph("Legacy") }]) {
      const snapshot = await engine.snapshot("a")
      const analysis = parseDiagramOutput(JSON.stringify(input), snapshot.evidence)
      assert.ok(ViewAnalysisSchema.safeParse(analysis).success)
      assert.equal((await engine.submit("a", snapshot.token, analysis)).views.length, analysis.views.length)
    }
  } finally { await engine.dispose() }
})
