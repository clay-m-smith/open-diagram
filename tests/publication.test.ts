import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { DiagramEngine } from "../src/diagram/engine.js"
import { ConfigSchema } from "../src/diagram/config.js"
import { createDiagramClient } from "../src/diagram/client.js"
import type { DiagramAnalysis, DiagramState } from "../src/diagram/schema.js"
import { ViewAnalysisSchema } from "../src/diagram/schema.js"

const evidence = [{ id: "e_source", label: "workflow.ts", text: "Gateway -> Queue -> Worker" }]
const output = (label = "Gateway") => ({ relevant: true, reason: "Implementation", views: [{ id: "system", label: "System", graph: {
  title: label, summary: "", nodes: [{ id: "gateway", label, kind: "service", detail: "Accept orders", status: "observed", evidence: ["e_source"] }], edges: [],
} }] })
const deps = () => {
  const saved = new Map<string, DiagramState>()
  return { saved, intervalMs: 1, debounceMs: 1, load: async (id: string) => saved.get(id),
    save: async (id: string, state: DiagramState) => { saved.set(id, state) }, publish: async () => {} }
}

test("manual snapshots publish atomically, persist views, reject stale evidence/mode/publication and foreign tokens", async () => {
  const d = deps()
  const engine = new DiagramEngine(d)
  try {
    await engine.observe("a", evidence)
    const first = await engine.snapshot("a")
    assert.equal(first.state.phase, "watching")
    const accepted = await engine.submit("a", first.token, output())
    assert.equal(accepted.views[0].graph.title, "Gateway")
    assert.deepEqual(accepted.changedViews.system, ["gateway"])
    assert.deepEqual(d.saved.get("a")?.views, accepted.views)
    await assert.rejects(engine.submit("a", first.token, output("Old")), /snapshot changed/)
    const changed = await engine.snapshot("a")
    await engine.observe("a", [{ ...evidence[0], text: "New workflow" }])
    await assert.rejects(engine.submit("a", changed.token, output()), /snapshot changed/)
    const mode = await engine.snapshot("a")
    await engine.control("a", "off")
    await assert.rejects(engine.submit("a", mode.token, output()), /snapshot changed/)
    const fresh = await engine.snapshot("a")
    await engine.observe("b", evidence)
    await assert.rejects(engine.submit("b", fresh.token, output()), /snapshot changed/)
    assert.equal((await engine.submit("a", fresh.token, output("Paused publication"))).phase, "paused")
    const next = await engine.snapshot("a")
    const bad = output(); bad.views[0].graph.nodes[0].evidence = ["outside"]
    await assert.rejects(engine.submit("a", next.token, bad), /outside current snapshot/)
    assert.equal((await engine.snapshot("a")).token, next.token, "invalid input cannot consume token")
    const abort = new AbortController(); abort.abort()
    await assert.rejects(engine.submit("a", next.token, output(), abort.signal))
    assert.equal((await engine.snapshot("a")).token, next.token)
  } finally { await engine.dispose() }
  const restored = new DiagramEngine(d)
  try {
    assert.equal((await restored.get("a")).views[0].graph.title, "Paused publication")
    assert.equal((await restored.get("a")).mode, "off")
  } finally { await restored.dispose() }
})

test("external publication cancels obsolete automatic analysis and late output cannot overwrite it", async () => {
  let release!: (value: DiagramAnalysis) => void
  let signal: AbortSignal | undefined
  const engine = new DiagramEngine({ ...deps(), analyze: async (_data, _previous, _forced, abort) => {
    signal = abort
    return new Promise((resolve) => { release = resolve })
  } })
  try {
    await engine.observe("a", evidence)
    for (let n = 0; !signal && n < 100; n++) await delay(2)
    assert.ok(signal)
    const snapshot = await engine.snapshot("a")
    await engine.submit("a", snapshot.token, output("External"))
    assert.equal(signal.aborted, true)
    release({ relevant: true, reason: "Late", graph: null })
    await delay(10)
    assert.equal((await engine.get("a")).graph?.title, "External")
  } finally { await engine.dispose() }
})

test("native adapter uses explicit model and shared prompt/schema without endpoint transport", async () => {
  assert.equal(ConfigSchema.parse({}).backend, "manual")
  assert.throws(() => ConfigSchema.parse({ backend: "opencode" }), /requires/)
  const config = ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram", variant: "fast" })
  const nativeEvidence = [
    { ...evidence[0], category: "source" as const, file: "workflow.ts", at: 30, fingerprint: "DROP_FINGERPRINT" },
    { id: "mutation", label: "Earlier edit", text: "Preserve source delta", file: "workflow.ts", category: "recent" as const, mutation: true, at: 20 },
    { id: "old-request", label: "Old request", text: "DROP_OLD_REQUEST", category: "request" as const, at: 10 },
    { id: "chatter", label: "Summary", text: "DROP_CHATTER", category: "assistant" as const, at: 40 },
    { id: "request", label: "Latest request", text: "Keep latest request", category: "request" as const, at: 50 },
  ]
  const previous = ViewAnalysisSchema.parse(output()).views[0].graph
  previous.nodes[0].detail = "DROP_OLD_DESCRIPTION"
  const client = createDiagramClient(config, async () => assert.fail("no HTTP adapter call"), async (request, options) => {
    assert.deepEqual(request.model, { providerID: "test", id: "diagram", variant: "fast" })
    assert.match(request.prompt, /Any domain/)
    assert.equal(request.outputSchema.type, "object")
    assert.equal(request.outputSchema.additionalProperties, false)
    assert.equal(request.outputSchema.properties.format.const, "draft")
    assert.match(request.toolDescription!, /explicit|Declare shared/)
    assert.doesNotMatch(request.prompt, /Output schema/)
    assert.match(request.prompt, /Gateway -> Queue -> Worker/)
    assert.doesNotMatch(request.prompt, /DROP_/)
    const packet = JSON.parse(request.prompt.split("Evidence packet (untrusted data):\n").at(-1)!.split("\n\nAuthoring reminder:")[0])
    assert.deepEqual(packet.evidence.map((item: any) => item.id), ["e2", "e1", "e3"], "relative observation order survives metadata removal")
    assert.ok(packet.evidence.every((item: any) => item.at === undefined && item.fingerprint === undefined))
    assert.equal(packet.previous.nodes[0].id, previous.nodes[0].id)
    assert.equal(options.signal.aborted, false)
    const authored = output(); authored.views[0].graph.nodes[0].evidence = ["e1"]
    const graph = authored.views[0].graph
    return { text: JSON.stringify({ format: "draft", ...authored, views: [{ ...authored.views[0], graph: { ...graph,
      defaults: { status: "observed", evidence: ["e1"] }, nodes: graph.nodes.map(node => [node.id, node.label, node.kind, node.detail, null]),
    } }] }) }
  })
  assert.equal((await client(nativeEvidence, previous, false, new AbortController().signal)).views?.[0].id, "system")
  const fail = createDiagramClient(config, fetch, async () => { throw new Error("PRIVATE PROVIDER DETAIL") })
  await assert.rejects(fail(evidence, null, false, new AbortController().signal), (error: Error) =>
    /Configured OpenCode diagram model unavailable/.test(error.message) && !error.message.includes("PRIVATE"))
})

test("native validation repair is bounded to one retry and never repairs transport failure", async () => {
  const config = ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" })
  let calls = 0
  const client = createDiagramClient(config, fetch, async (request) => {
    if (++calls === 1) return { text: "MALFORMED" }
    assert.match(request.prompt, /failed json validation/)
    const value = output(); value.views[0].graph.nodes[0].evidence = ["e1"]
    return { text: JSON.stringify(value) }
  })
  assert.equal((await client(evidence, null, false, new AbortController().signal)).graph?.title, "Gateway")
  assert.equal(calls, 2)
  calls = 0
  const invalid = createDiagramClient(config, fetch, async () => { calls++; return { text: "MALFORMED" } })
  await assert.rejects(invalid(evidence, null, false, new AbortController().signal), /not valid JSON/)
  assert.equal(calls, 2)
  calls = 0
  const fail = createDiagramClient(config, fetch, async () => { calls++; throw new Error("network") })
  await assert.rejects(fail(evidence, null, false, new AbortController().signal), /unavailable/)
  assert.equal(calls, 1)
})

test("native validation repair inherits remaining deadline rather than a fresh budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const config = ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram", timeoutMs: 1000 })
  let calls = 0
  let started!: () => void
  const repairing = new Promise<void>((resolve) => { started = resolve })
  let signal!: AbortSignal
  const client = createDiagramClient(config, fetch, async (_request, options) => {
    if (++calls === 1) {
      t.mock.timers.tick(800)
      return { text: "MALFORMED" }
    }
    signal = options.signal
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      started()
    })
  })
  const result = client(evidence, null, false, new AbortController().signal)
  await repairing
  t.mock.timers.tick(199)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await assert.rejects(result, /validation repair timed out after \d+ms total.*budget 1000ms.*initial json: Diagram response is not valid JSON.*Refresh to retry/)
  assert.equal(signal.aborted, true)
  assert.equal(calls, 2)
})

test("native node repair replaces only invalid nodes and keeps full graph/citation validation", async () => {
  const config = ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" })
  const value = output("Untouched architecture")
  value.views[0].graph.nodes = Array.from({ length: 7 }, (_, index) => ({ ...value.views[0].graph.nodes[0], id: `n${index}`, label: `Stage ${index}`, evidence: ["e1"] }))
  const broken = structuredClone(value)
  Reflect.deleteProperty(broken.views[0].graph.nodes[5], "evidence")
  Object.assign(broken.views[0].graph.nodes[5], { kind: "", sources: ["e1"] })
  Object.assign(broken.views[0].graph.nodes[6], { sources: ["e1"] })
  const replacements = [5, 6].map(node => ({ view: 0, node, replacement: value.views[0].graph.nodes[node] }))
  let initialPrompt = "", repairPrompt = ""
  const run = async (repairs: unknown[]) => {
    let calls = 0
    const client = createDiagramClient(config, fetch, async ({ prompt }) => {
      if (++calls === 1) { initialPrompt = prompt; return { text: JSON.stringify(broken) } }
      repairPrompt = prompt
      return { text: JSON.stringify({ repairs }) }
    })
    try { return await client(evidence, null, false, new AbortController().signal) }
    finally { assert.equal(calls, 2, "repair failures cannot trigger a third call") }
  }
  const result = await run(replacements)
  const expected = structuredClone(value)
  for (const node of expected.views[0].graph.nodes) node.evidence = ["e_source"]
  assert.deepEqual(result.views, expected.views)
  assert.match(repairPrompt, /evidence: expected array/)
  assert.match(repairPrompt, /node: unexpected fields/)
  assert.doesNotMatch(repairPrompt, /Untouched architecture|Stage 0/)
  assert.ok(repairPrompt.length < initialPrompt.length, "node repair omits full notation schema and valid draft blocks")
  for (const repairs of [replacements.slice(0, 1), [replacements[0], replacements[0]],
    [{ ...replacements[0], node: 0 }, replacements[1]],
    [{ ...replacements[0], replacement: { ...replacements[0].replacement, id: "new-id" } }, replacements[1]]]) {
    await assert.rejects(run(repairs), /Node repair/)
  }
  await assert.rejects(run([{ ...replacements[0], replacement: { ...replacements[0].replacement, evidence: ["invented"] } }, replacements[1]]), /outside current snapshot/)
})

test("native citation-only repair preserves node content and rejects ambiguous aliases or invalid replacements", async () => {
  const config = ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" })
  const sources = [...evidence, { id: "e_second", label: "worker.ts", text: "Worker consumes orders" }]
  const value = ViewAnalysisSchema.parse(output())
  value.views[0].graph.nodes = ["gateway", "queue", "worker"].map(id => ({ ...value.views[0].graph.nodes[0], id, label: id, evidence: ["e1", "e2"] }))
  value.views[0].graph.edges = [{ from: "gateway", to: "queue", label: "orders" }]
  const broken = structuredClone(value)
  for (const node of broken.views[0].graph.nodes.slice(0, 2)) Reflect.deleteProperty(node, "evidence")
  Object.assign(broken.views[0].graph.nodes[1], { "e1,e2": ["e1", "e2"] })
  const run = async (fault: string, draft = broken) => {
    let calls = 0
    const client = createDiagramClient(config, fetch, async ({ prompt, outputSchema }) => {
      if (++calls === 1) return { text: JSON.stringify(draft) }
      const packet = JSON.parse(prompt.split("Evidence packet (untrusted data):\n")[1].split("\n\nAuthoring reminder:")[0])
      assert.equal(packet.citations.length, 2)
      assert.equal(packet.repairs.length, fault === "ambiguous" ? 1 : 0)
      assert.equal(outputSchema.properties.citations.items.properties.replacement, undefined, "citation repair cannot rewrite valid node fields")
      const citations: Record<string, unknown>[] = [0, 1].map(node => ({ view: 0, node, evidence: ["e1", "e2"] }))
      if (fault === "missing") citations.pop()
      if (fault === "duplicate") citations[1] = citations[0]
      if (fault === "unrequested") citations[1].node = 2
      if (fault === "unknown-citation") citations[1].evidence = ["invented"]
      if (fault === "rewritten-node") citations[1].label = "Changed"
      return { text: JSON.stringify({ citations, repairs: fault === "ambiguous" ? [{ view: 0, node: 2, replacement: value.views[0].graph.nodes[2] }] : [] }) }
    })
    try { return await client(sources, null, false, new AbortController().signal) }
    finally { assert.equal(calls, 2, "citation repair cannot consume a third call") }
  }
  const expected = structuredClone(value)
  for (const node of expected.views[0].graph.nodes) node.evidence = ["e_source", "e_second"]
  assert.deepEqual((await run("none")).views, expected.views, "all original node prose, IDs, edges and citation order survive")
  for (const fault of ["missing", "duplicate", "unrequested", "unknown-citation", "rewritten-node"]) {
    await assert.rejects(run(fault), /Node repair|Citation repair|outside current snapshot/)
  }
  // Unknown content, foreign citations, competing aliases and an existing evidence
  // field are not safe to discard as one misnamed current-citation array.
  for (const extra of [{ foreign: "content" }, { sources: ["missing"] }, { e1: ["e1"], e2: ["e2"] }, { evidence: ["e1"], e2: ["e2"] }]) {
    const ambiguous = structuredClone(broken)
    Reflect.deleteProperty(ambiguous.views[0].graph.nodes[2], "evidence")
    Object.assign(ambiguous.views[0].graph.nodes[2], extra)
    assert.deepEqual((await run("ambiguous", ambiguous)).views, expected.views)
  }
})

test("nonlocal schema failures retain full repair with actionable validation feedback", async () => {
  const value = output(); value.views[0].graph.nodes[0].evidence = ["e1"]
  const broken = structuredClone(value); broken.views.push(structuredClone(broken.views[0]))
  let calls = 0
  const client = createDiagramClient(ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" }), fetch, async ({ prompt }) => {
    if (++calls === 1) return { text: JSON.stringify(broken) }
    assert.match(prompt, /Validation details: Invalid diagram schema: views \(inconsistent structure or references\)/)
    assert.match(prompt, /corrected COMPLETE object through the result tool/)
    return { text: JSON.stringify(value) }
  })
  assert.equal((await client(evidence, null, false, new AbortController().signal)).views?.length, 1)
  assert.equal(calls, 2)
  const notationValue = structuredClone(value)
  const id = notationValue.views[0].graph.nodes[0].id
  const edge = { from: id, to: id, label: "feedback" }
  const valid = { ...notationValue, views: [{ ...notationValue.views[0], graph: { ...notationValue.views[0].graph, edges: [edge],
    notation: { version: 2, family: "architecture", groups: [], ports: [], links: [
      { edge: 0, fromPort: null, toPort: null, direction: "forward", role: "data", evidence: ["e1"] },
    ] },
  } }] }
  for (const malformedNode of [false, true]) for (const fault of ["none", "duplicate", "unrequested", "citation", "port"] as const) {
    const missingLink = structuredClone(valid); missingLink.views[0].graph.notation.links = []
    if (malformedNode) { Reflect.deleteProperty(missingLink.views[0].graph.nodes[0], "evidence"); missingLink.reason = "x".repeat(241) }
    calls = 0
    const repair = createDiagramClient(ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" }), fetch, async ({ prompt }) => {
      if (++calls === 1) return { text: JSON.stringify(missingLink) }
      assert.match(prompt, /Notation must describe every graph edge exactly once/, "node type errors cannot hide reference faults from the single repair")
      const { edge: _edge, ...replacement } = valid.views[0].graph.notation.links[0]
      if (fault === "citation") replacement.evidence = ["missing"]
      if (fault === "port") Object.assign(replacement, { fromPort: "missing" })
      const links = [{ view: 0, edge: fault === "unrequested" ? 1 : 0, replacement }]
      if (fault === "duplicate") links.push(links[0])
      if (malformedNode) assert.match(prompt, /corrected top-level reason/)
      return { text: JSON.stringify({ repairs: [],
        ...(malformedNode ? { reason: "Repaired concise explanation", citations: [{ view: 0, node: 0, evidence: ["e1"] }] } : {}), links }) }
    })
    if (fault !== "none") {
      await assert.rejects(repair(evidence, null, false, new AbortController().signal), /Invalid diagram|Node repair|Link repair|outside current snapshot/)
      assert.equal(calls, 2, "invalid link repairs cannot trigger a third call")
      continue
    }
    const result = await repair(evidence, null, false, new AbortController().signal)
    assert.equal(result.views?.[0].graph.edges.length, 1)
    assert.equal(result.views?.[0].graph.nodes[0].label, valid.views[0].graph.nodes[0].label, "diagnostic stand-ins never enter accepted data")
    if (malformedNode) assert.equal(result.reason, "Repaired concise explanation")
    assert.equal(calls, 2, "exact reference-rule feedback retains the two-call limit")
  }
})

test("native field repair fixes oversized tabs and draft defaults without rewriting valid content", async () => {
  const config = ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" })
  const sources = Array.from({ length: 7 }, (_, i) => ({ id: `source_${i}`, label: `Source ${i}`, text: `Stage ${i}` }))
  for (const draft of [false, true]) for (const fault of ["none", "missing", "extra", "invalid", "citation"]) {
    const value: any = output()
    value.views[0].label = "Tab label over 24 characters"
    value.views[0].graph.nodes[0].evidence = ["e1"]
    if (draft) {
      value.format = "draft"
      value.views[0].graph.defaults = { status: "observed", evidence: sources.map((_, i) => `e${i + 1}`) }
      value.views[0].graph.nodes = value.views[0].graph.nodes.map((n: any) => [n.id, n.label, n.kind, n.detail, n.behavior ?? null, null])
    }
    const original = structuredClone(value)
    let calls = 0
    const run = createDiagramClient(config, fetch, async ({ prompt, outputSchema }) => {
      if (++calls === 1) return { text: JSON.stringify(value) }
      assert.equal(outputSchema.properties.views, undefined, "field repair cannot replace graphs")
      const fields: any = { f0: "Short tab", ...(draft ? { f1: ["e1"] } : {}) }
      if (!draft) assert.doesNotMatch(prompt, /Gateway accepts|Untouched/, "text-only repair needs no source or graph replay")
      if (fault === "missing") delete fields.f0
      if (fault === "extra") fields.f2 = "unrequested"
      if (fault === "invalid") fields.f0 = "x".repeat(25)
      if (fault === "citation") { if (draft) fields.f1 = ["foreign"]; else fields.f0 = "\n" }
      return { text: JSON.stringify(fields) }
    })
    if (fault !== "none") await assert.rejects(run(sources, null, false, new AbortController().signal), /Field repair/)
    else {
      const result = await run(sources, null, false, new AbortController().signal)
      assert.equal(result.views![0].label, "Short tab")
      assert.equal(result.views![0].graph.nodes[0].detail, output().views[0].graph.nodes[0].detail)
      assert.deepEqual(result.views![0].graph.nodes[0].evidence, ["source_0"])
    }
    assert.equal(calls, 2, "failed field repair cannot obtain a third call")
    assert.deepEqual(value, original)
  }
})

test("native incremental shorthand preserves cached detail and validates the complete expanded graph", async () => {
  const before = ViewAnalysisSchema.parse(output())
  before.views[0].graph.nodes.push({ ...before.views[0].graph.nodes[0], id: "other", label: "Other", detail: "Preserve exact cached detail" })
  before.views[0].graph.edges = [{ from: before.views[0].graph.nodes[0].id, to: "other", label: "request" }]
  const update = { views: before.views, maxNodes: 2 }
  const changed = { id: before.views[0].graph.nodes[0].id, label: "Changed", evidence: ["e1"] }
  const value = { reason: "Changed source", updates: [{ id: before.views[0].id, graph: { nodes: [changed, "other"] } }] }
  let calls = 0
  const run = async (result: unknown, selected = update) => {
    const client = createDiagramClient(ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" }), fetch, async ({ prompt }) => {
      calls++
      const packet = JSON.parse(prompt.split("Evidence packet (untrusted data):\n").at(-1)!.split("\n\nAuthoring reminder:")[0])
      if (packet.fields) return { text: JSON.stringify(result) } // deliberately invalid field-repair response
      assert.equal(packet.previous, undefined, "incremental baseline is sent once, never duplicated as previous")
      assert.equal(packet.update.views[0].graph.nodes[0].evidence[0], "e1")
      return { text: JSON.stringify(result) }
    })
    return client(evidence, before.views[0].graph, false, new AbortController().signal, "granular", selected)
  }
  const result = await run(value)
  assert.equal(calls, 1)
  assert.deepEqual(result.views?.[0].graph.nodes[1], before.views[0].graph.nodes[1])
  assert.deepEqual(result.views?.[0].graph.edges, before.views[0].graph.edges)
  assert.equal(result.views?.[0].graph.nodes[0].label, "Changed")
  assert.equal(result.views?.[0].graph.nodes[0].detail, before.views[0].graph.nodes[0].detail, "sparse edits cannot erase unmentioned descriptions")
  assert.equal(result.views?.[0].label, before.views[0].label, "omitted captions retain current label")
  const renamed = await run({ reason: "Correct view subject", updates: [{ id: before.views[0].id, label: "Dependencies", graph: {} }] })
  assert.equal(renamed.views?.[0].label, "Dependencies", "a caption correction does not require reprinting the graph")
  assert.equal(renamed.views?.[0].id, before.views[0].id, "stable view identity survives rename")
  assert.deepEqual(renamed.views?.[0].graph, before.views[0].graph)
  for (const label of ["", "x".repeat(25), "bad\nlabel"]) {
    await assert.rejects(run({ reason: "Invalid caption", updates: [{ id: before.views[0].id, label, graph: {} }] }), /Field repair/)
  }
  let repairCalls = 0
  const repairCaption = createDiagramClient(ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" }), fetch, async ({ outputSchema }) => {
    if (++repairCalls === 1) return { text: JSON.stringify({ reason: "Correct caption", updates: [{ id: before.views[0].id, label: "x".repeat(25), graph: {} }] }) }
    assert.equal(outputSchema.properties.views, undefined, "invalid incremental caption never requests a full graph rewrite")
    return { text: JSON.stringify({ f0: "Dependencies" }) }
  })
  const repairedCaption = await repairCaption(evidence, before.views[0].graph, false, new AbortController().signal, "overview", update)
  assert.equal(repairCalls, 2)
  assert.equal(repairedCaption.views?.[0].label, "Dependencies")
  assert.deepEqual(repairedCaption.views?.[0].graph, before.views[0].graph)
  const secondary = { ...before.views[0], id: "secondary", label: "Secondary" }
  const ranked = await run({ reason: "Current model first", updates: [{ id: secondary.id, graph: {} }, { id: before.views[0].id, graph: {} }] },
    { views: [...before.views, secondary], maxNodes: 4, replaceAll: true } as typeof update)
  assert.deepEqual(ranked.views?.map(view => view.id), ["secondary", before.views[0].id], "all-view shorthand can reorder tabs without graph rewrites")
  assert.ok(JSON.stringify(value).length < JSON.stringify(before).length * 0.7, "wire shorthand avoids reprinting cached nodes and edges")
  for (const graph of [{ nodes: ["unknown"] }, { nodes: [{ id: "new", label: "Incomplete" }] }, { nodes: ["other", "other"] }, { edges: [{ from: "missing", to: "other", label: "" }] }]) {
    await assert.rejects(run({ reason: "Fixture", updates: [{ id: before.views[0].id, graph }] }), /Incremental|Invalid diagram/)
  }
  await assert.rejects(run(value, { ...update, maxNodes: 1 }), /remaining 1-node/)
  const missing = structuredClone(before.views); missing[0].graph.nodes[1].evidence = ["stale-source"]
  await assert.rejects(run(value, { views: missing, maxNodes: 2 }), /Field repair|outside current snapshot/)
  await assert.rejects(run({ ...value, updates: [value.updates[0], value.updates[0]] }), /exactly once/)
  await assert.rejects(run({ ...value, updates: [{ ...value.updates[0], id: "unrequested" }] }), /exactly once/)
  assert.deepEqual(before.views[0].graph.nodes[1].evidence, ["e_source"], "baseline is immutable")
})

test("incremental mixed group-membership, citation and prose faults use one exact-field repair", async () => {
  const before = ViewAnalysisSchema.parse(output())
  const id = before.views[0].graph.nodes[0].id
  const sources = Array.from({ length: 7 }, (_, i) => ({ id: i ? `s${i}` : "e_source", label: "Source", text: "Observed enclosing structure" }))
  const group = (id: string, parent: string | null, nodes: string[]) => ({ id, label: id, kind: "directory", parent, nodes, evidence: ["e1"] })
  const bad = { reason: "Group update", updates: [{ id: before.views[0].id, graph: {
    nodes: [{ id, detail: "x".repeat(241) }],
    notation: { family: "architecture", version: 2, ports: [], links: [], groups: [
      { ...group("root", null, [id]), evidence: sources.map((_, i) => `e${i + 1}`) }, group("child", "root", [id, "unknown"]),
    ] },
  } }] }
  for (const conflict of [false, true]) {
    let calls = 0
    const client = createDiagramClient(ConfigSchema.parse({ backend: "opencode", providerID: "test", model: "diagram" }), fetch, async ({ prompt, outputSchema }) => {
      if (++calls === 1) return { text: JSON.stringify(bad) }
      assert.equal(outputSchema.properties.views, undefined)
      const packet = JSON.parse(prompt.split("Evidence packet (untrusted data):\n")[1].split("\n\nAuthoring reminder:")[0])
      assert.equal(packet.fields.length, 4, "repair only detail, two memberships and one citation array")
      return { text: JSON.stringify(Object.fromEntries(packet.fields.map((field: any) => [field.field,
        field.path.at(-1) === "detail" ? "Concise purpose" : field.path.at(-1) === "evidence" ? ["e1"] : field.path.at(-2) === 0 ? conflict ? [id] : [] : [id]]))) }
    })
    const run = () => client(sources, before.views[0].graph, false, new AbortController().signal, "overview", { views: before.views })
    if (conflict) await assert.rejects(run(), /Unknown or multiply grouped node/, "a repair cannot bypass final cross-reference validation")
    else {
      const result = (await run()).views![0].graph
      assert.deepEqual(result.nodes[0], { ...before.views[0].graph.nodes[0], detail: "Concise purpose" })
      assert.deepEqual(result.edges, before.views[0].graph.edges)
      assert.ok(result.notation?.family === "architecture")
      assert.deepEqual(result.notation.groups.map(group => group.nodes), [[], [id]])
      assert.deepEqual(result.notation.groups[0].evidence, ["e_source"])
    }
    assert.equal(calls, 2)
  }
})
