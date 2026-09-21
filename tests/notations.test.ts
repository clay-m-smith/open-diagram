import assert from "node:assert/strict"
import test from "node:test"
import { authorRequest } from "../src/diagram/author.js"
import { affectedViews, evidenceFingerprints, type AcceptedDiagram } from "../src/diagram/cache.js"
import { DiagramEngine } from "../src/diagram/engine.js"
import { validateDiagramOutput } from "../src/diagram/harness.js"
import { GraphSchema, type DiagramGraph, type DiagramView } from "../src/diagram/schema.js"
import { notationEvidence, notationFixtures } from "./fixtures/notations.js"
import { diagramTextWidth, diagramWires, layoutDiagram } from "../src/diagram/layout.js"
import { sceneWireRuns } from "../src/diagram/scene.js"
import { draftOutputSchema, expandDiagramDraft } from "../src/diagram/draft.js"

const clone = <T>(value: T): T => structuredClone(value)
const legacy = { title: "Legacy", summary: "No notation", nodes: [{ id: "old", label: "Old", kind: "service", detail: "", status: "observed" as const, evidence: ["e_design"] }], edges: [] }

test("eight notation families validate while legacy graphs remain byte-exact", () => {
  assert.deepEqual(Object.keys(notationFixtures).sort(), ["architecture", "circuit", "class", "er", "flowchart", "sequence", "state", "timing"])
  for (const fixture of Object.values(notationFixtures)) assert.ok(GraphSchema.safeParse(fixture).success)
  assert.deepEqual(GraphSchema.parse(legacy), legacy)
  for (const invalid of ["unknown", "architecture"]) {
    const value: any = clone(notationFixtures.architecture)
    if (invalid === "unknown") value.notation.family = invalid
    else value.notation.version = 3
    assert.equal(GraphSchema.safeParse(value).success, false)
  }
})

function draftGraph(fixture: DiagramGraph): any {
  const graph: any = clone(fixture)
  graph.defaults = { status: graph.nodes[0].status, evidence: [...graph.nodes[0].evidence] }
  for (const node of graph.nodes) if (node.status === graph.defaults.status) delete node.status
  const notation = graph.notation
  if (notation) {
    delete notation.version
    for (const collection of ["steps", "states", "records"]) {
      if (!notation[collection]) continue
      for (const { node, ...annotation } of notation[collection]) graph.nodes.find((item: any) => item.id === node).annotation = annotation
      delete notation[collection]
    }
    for (const collection of ["links", "branches", "transitions", "relationships"]) {
      if (!notation[collection]) continue
      for (const { edge, ...annotation } of notation[collection]) graph.edges[edge].annotation = annotation
      delete notation[collection]
    }
  }
  const inherit = (value: any) => {
    if (!value || typeof value !== "object") return
    if (JSON.stringify(value.evidence) === JSON.stringify(graph.defaults.evidence)) delete value.evidence
    for (const item of Object.values(value)) if (Array.isArray(item)) item.forEach(inherit); else inherit(item)
  }
  inherit(graph.nodes); inherit(graph.edges); inherit(notation)
  return graph
}

test("native drafts expand all families losslessly with explicit defaults and co-located annotations", () => {
  const schema = draftOutputSchema(notationEvidence)
  assert.deepEqual(schema.$defs.EvidenceIDs.items.enum, notationEvidence.map(item => item.id))
  assert.equal(schema.properties.format.const, "draft")
  assert.equal(schema.properties.views.items.properties.graph.properties.nodes.items.prefixItems.length, 6)
  const rows = (draft: any) => ({ ...draft,
    nodes: draft.nodes.map(({ id, label, kind, detail, behavior, ...overrides }: any) => [id, label, kind, detail, behavior ?? null, ...(Object.keys(overrides).length ? [overrides] : [])]),
    edges: draft.edges.map(({ from, to, label, annotation }: any) => [from, to, label, ...(annotation ? [annotation] : [])]),
  })
  const read = (graph: any) => validateDiagramOutput(JSON.parse(expandDiagramDraft(JSON.stringify({ format: "draft", relevant: true, reason: "Fixture", views: [{ id: "diagram", label: "Diagram", graph }] }), notationEvidence)), notationEvidence).views[0].graph
  for (const [family, fixture] of Object.entries({ ...notationFixtures, legacy })) {
    const expected: DiagramGraph = clone(fixture)
    if (expected.nodes.length > 1) expected.nodes[1].status = "planned"
    const draft = draftGraph(expected)
    const before = JSON.stringify(draft)
    assert.deepEqual(read(draft), expected, family)
    assert.deepEqual(read(rows(draft)), expected, `${family} fixed rows`)
    const nullable = rows(draft)
    for (const node of nullable.nodes) if (node.length === 5) node.push(null)
    for (const edge of nullable.edges) if (edge.length === 3) edge.push(null)
    assert.deepEqual(read(nullable), expected, "null optional row slots mean absent, without dropping required family annotations")
    assert.equal(JSON.stringify(draft), before, "author input is not mutated")
    const canonical = JSON.stringify({ relevant: true, reason: "Fixture", views: [{ id: "diagram", label: "Diagram", graph: fixture }] })
    assert.equal(expandDiagramDraft(canonical, notationEvidence), canonical, "canonical compatibility is byte-exact")
  }
  const reordered = draftGraph(notationFixtures.architecture)
  reordered.edges.reverse(); reordered.edges.pop()
  const result = read(reordered)
  assert.equal(result.edges[0].from, "plant")
  assert.ok(result.notation?.family === "architecture")
  assert.deepEqual(result.notation.links, [{ ...((notationFixtures.architecture.notation as any).links[1]), edge: 0 }], "annotation follows its own edge, not its old index")
  for (const mutate of [
    (g: any) => { delete g.defaults },
    (g: any) => { g.defaults.extra = "unknown" },
    (g: any) => { g.defaults.evidence = ["unknown"] },
    (g: any) => {
      g.defaults.evidence = ["unknown"]
      for (const item of [...g.nodes, ...g.edges.map((edge: any) => edge.annotation), ...g.notation.groups, ...g.notation.ports]) item.evidence = ["e_design"]
    },
    (g: any) => { g.nodes[0].evidence = null },
    (g: any) => { delete g.edges[0].annotation },
    (g: any) => { g.edges[0].annotation = null },
    (g: any) => { g.edges[0].annotation.edge = 0 },
    (g: any) => { g.notation.links = [] },
    (g: any) => { g.edges[0].annotation.fromPort = "force" },
    (g: any) => { g.edges[0].annotation.extra = "unknown" },
  ]) {
    const draft = draftGraph(notationFixtures.architecture); mutate(draft)
    assert.throws(() => read(draft), /Invalid diagram|outside current snapshot/, "draft expansion cannot guess missing metadata or bypass strict validation")
  }
  for (const mutate of [
    (g: any) => { g.nodes[0].push({}, "extra") },
    (g: any) => { g.nodes[0][5] = { id: "replacement" } },
    (g: any) => { g.edges[0] = ["mcu", "plant"] },
  ]) {
    const draft = rows(draftGraph(notationFixtures.architecture)); mutate(draft)
    assert.throws(() => read(draft), /Invalid diagram draft/, "positional input cannot silently discard extra fields or overwrite node identity")
  }
})

test("notation references reject invalid owners, memberships, ranges, and samples", () => {
  const invalid: [string, DiagramGraph, (value: any) => void][] = [
    ["architecture port owner", notationFixtures.architecture, (v) => { v.notation.links[0].fromPort = "force" }],
    ["group cycle", notationFixtures.architecture, (v) => { v.notation.groups[0].parent = "physical" }],
    ["multiply grouped node", notationFixtures.architecture, (v) => { v.notation.groups[1].nodes.push("mcu") }],
    ["duplicate circuit terminal", notationFixtures.circuit, (v) => { v.notation.nets[1].terminals.push({ node: "mcu", pin: "sda" }) }],
    ["NC circuit pin", notationFixtures.circuit, (v) => { v.notation.nets[0].terminals[0].pin = "nc" }],
    ["dangling circuit pin", notationFixtures.circuit, (v) => { v.notation.nets[0].terminals[0].pin = "missing" }],
    ["local circuit scope escape", notationFixtures.circuit, (v) => { v.notation.groups[0].nodes = ["mcu"] }],
    ["timing order", notationFixtures.timing, (v) => { v.notation.signals[0].samples[1].at = 1 }],
    ["digital timing value", notationFixtures.timing, (v) => { v.notation.signals[0].samples[0].value = "HIGH" }],
    ["sequence participant", notationFixtures.sequence, (v) => { v.notation.messages[0].to = "missing" }],
    ["sequence range", notationFixtures.sequence, (v) => { v.notation.activations[0].to = 9 }],
  ]
  for (const [name, fixture, mutate] of invalid) {
    const value = clone(fixture) as any; mutate(value)
    assert.equal(GraphSchema.safeParse(value).success, false, name)
  }
})

test("notation citations validate and author remaps nested citation arrays", () => {
  const foreign: any = clone(notationFixtures.architecture)
  foreign.notation.ports[0].evidence = ["outside"]
  assert.throws(() => validateDiagramOutput({ relevant: true, reason: "x", views: [{ id: "architecture", label: "Architecture", graph: foreign }] }, notationEvidence), /outside current snapshot/)
  const { request, parse } = authorRequest(notationEvidence, notationFixtures.circuit, false)
  assert.doesNotMatch(JSON.stringify(request.input), /e_design|e_wiring/, "prior citation hints are stripped")
  const authored: any = clone(notationFixtures.circuit)
  const remap = (ids: string[]) => ids.map((id) => id === "e_design" ? "e1" : "e2")
  for (const item of authored.nodes) item.evidence = remap(item.evidence)
  for (const group of authored.notation.groups) group.evidence = remap(group.evidence)
  for (const component of authored.notation.components) component.evidence = remap(component.evidence)
  for (const net of authored.notation.nets) net.evidence = remap(net.evidence)
  const result = parse(JSON.stringify({ relevant: true, reason: "Circuit", views: [{ id: "circuit", label: "Circuit", graph: authored }] }))
  const notation = result.views[0].graph.notation
  assert.ok(notation?.family === "circuit")
  assert.deepEqual(notation.nets[0].evidence, ["e_wiring"])
  assert.deepEqual(result.views[0].graph.nodes[0].evidence, ["e_design"])
})

test("circuit publication reload, net highlights, and cache dependencies retain notation", async () => {
  let saved: unknown
  const legacyView: DiagramView = { id: "legacy", label: "Legacy", graph: legacy }
  const circuitView: DiagramView = { id: "circuit", label: "Circuit", graph: notationFixtures.circuit }
  const analysis = (circuit = notationFixtures.circuit) => ({ relevant: true, reason: "Wiring", views: [{ ...circuitView, graph: circuit }, legacyView] })
  const deps = { intervalMs: 1, debounceMs: 1, load: async () => saved, save: async (_id: string, state: unknown) => { saved = state }, publish: async () => {} }
  let engine = new DiagramEngine(deps)
  try {
    await engine.observe("notations", notationEvidence, false)
    const snapshot = await engine.snapshot("notations")
    await engine.submit("notations", snapshot.token, analysis())
    const changed = clone(notationFixtures.circuit) as any
    changed.notation.nets[1].label = "VDD_3V3"
    const update = await engine.submit("notations", (await engine.snapshot("notations")).token, analysis(changed))
    assert.deepEqual(update.changedViews.circuit, ["mcu", "pullup"])
    assert.equal(update.views[0].graph.notation?.family, "circuit")
  } finally { await engine.dispose() }
  engine = new DiagramEngine(deps)
  try { assert.equal((await engine.get("notations")).views[0].graph.notation?.family, "circuit") }
  finally { await engine.dispose() }
  const accepted: AcceptedDiagram = { key: "fixture", granularity: "overview", fingerprints: evidenceFingerprints(notationEvidence), analysis: analysis(), sources: notationEvidence.map(({ id, label }) => ({ id, label })), updatedAt: 0 }
  const affected = affectedViews(accepted, [{ ...notationEvidence[0] }, { ...notationEvidence[1], text: "Changed SDA wiring" }])
  assert.deepEqual(affected.map((view) => view.id), ["circuit"])
})

test("specialized geometry preserves family semantics and bounded shared scene coordinates", async () => {
  for (const [family, graph] of Object.entries(notationFixtures)) {
    const before = clone(graph)
    for (const columns of [32, 88]) {
      const layout = await layoutDiagram(graph, { columns, selected: graph.nodes[0].id })
      assert.deepEqual(new Set(layout.nodes.map((box) => box.node.id)), new Set(graph.nodes.map((node) => node.id)))
      assert.equal(diagramWires(layout).split("\n").length, layout.height, family)
      for (const box of layout.nodes) assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= layout.width && box.y + box.height <= layout.height)
      for (const text of layout.scene!.texts) assert.ok(text.x >= 0 && text.y >= 0 && text.y < layout.height)
      for (const region of layout.scene!.regions.filter(region => region.style === "group")) {
        assert.ok(region.width >= diagramTextWidth(region.label) + 4, "group title fits its region border")
      }
      if (graph.notation?.family === "sequence") {
        assert.deepEqual(layout.nodes.map((box) => box.node.id), graph.notation.participants)
        const messages = layout.scene!.paths.filter((path) => path.owner.startsWith("message:"))
        assert.deepEqual(messages.map((path) => path.owner), graph.notation.messages.map((message) => `message:${message.id}`))
        assert.ok(messages.every((path, i) => !i || path.points[0].y > messages[i - 1].points[0].y))
      }
      if (graph.notation?.family === "timing") {
        const labels = layout.scene!.texts.map((text) => text.text)
        assert.ok(labels.includes("Event-spaced timing (not to scale)"))
        for (const signal of graph.notation.signals) for (const sample of signal.samples) assert.ok(labels.includes(`t=${sample.at}${graph.notation.unit}`))
        assert.ok(labels.includes("X") && labels.includes("Z"))
      }
      if (graph.notation?.family === "circuit") {
        for (const net of graph.notation.nets) assert.equal(layout.scene!.dots.filter((dot) => dot.owner === `net:${net.id}`).length, net.terminals.length)
        assert.ok(layout.nodes.flatMap((box) => box.lines).some((line) => line.text.includes("NC")))
        assert.ok(layout.nodes.flatMap((box) => box.lines).some((line) => line.text.includes("unassigned")))
        assert.equal(layout.edges.length, 0)
      }
    }
    assert.deepEqual(graph, before, "layout cannot mutate accepted data")
  }
  const crossed = { paths: [
    { owner: "a", points: [{ x: 2, y: 0 }, { x: 2, y: 4 }] },
    { owner: "b", points: [{ x: 0, y: 2 }, { x: 4, y: 2 }] },
  ], texts: [], regions: [], dots: [] }
  assert.equal(sceneWireRuns(crossed, 5, 5).map((run) => run.text).join("").split("\n")[2][2], "│", "crossing different nets cannot join")
  assert.equal(sceneWireRuns({ ...crossed, dots: [{ x: 2, y: 2, owner: "a" }] }, 5, 5).map((run) => run.text).join("").split("\n")[2][2], "●", "explicit junction remains visible")
})

test("sequence labels use local wrapped gaps and timing axes never stretch to viewport width", async () => {
  const graph = clone(notationFixtures.sequence)
  assert.ok(graph.notation?.family === "sequence")
  graph.nodes.push({ ...graph.nodes[1], id: "sensor", label: "sensor" })
  graph.notation.participants.push("sensor")
  graph.notation.messages[0].label = "Read current sensor status and return the complete measurement payload"
  const layout = await layoutDiagram(GraphSchema.parse(graph), { columns: 38 })
  assert.ok(layout.width <= 50, "one long message must not widen every participant slot")
  assert.deepEqual(layout.nodes.map((box) => box.node.id), graph.notation.participants)
  const first = layout.scene!.paths.find((path) => path.owner === "message:poll1")!
  const lines = layout.scene!.texts.filter((text) => text.y < first.points[0].y)
  assert.equal(lines.map((line) => line.text).join(" "), graph.notation.messages[0].label, "long message remains complete")
  assert.ok(lines.length > 1, "use vertical label space instead of horizontal stretching")
  const wires = diagramWires(layout).split("\n")
  for (const text of layout.scene!.texts) assert.equal(wires[text.y].slice(text.x, text.x + text.text.length).trim(), "", "labels avoid lifelines, messages and activations")
  const narrow = await layoutDiagram(notationFixtures.timing, { columns: 38 })
  const wide = await layoutDiagram(notationFixtures.timing, { columns: 140 })
  assert.equal(wide.width, narrow.width, "more viewport space must not add an empty timing-axis tail")
})

test("compound architecture titles reserve header space, not empty left lanes or default layer gaps", async () => {
  const nodes = Array.from({ length: 9 }, (_, i) => ({ ...legacy.nodes[0], id: `stage${i}`, label: `Stage ${i}` }))
  for (const nested of [false, true]) {
    const graph = GraphSchema.parse({ title: "Encoder", summary: "Grouped layer chain", nodes,
      edges: nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id, label: "stage features" })),
      notation: { version: 2, family: "architecture", ports: [],
        links: nodes.slice(1).map((_, edge) => ({ edge, fromPort: null, toPort: null, direction: "forward", role: "data", evidence: ["e_design"] })),
        groups: [
          { id: "encoder", label: "Encoder trunk", kind: "neural model", parent: nested ? "outer" : null, nodes: nodes.map(node => node.id), evidence: ["e_design"] },
          ...(nested ? [{ id: "outer", label: "Model", kind: "container", parent: null, nodes: [], evidence: ["e_design"] }] : []),
        ],
      },
    })
    const before = clone(graph)
    const layout = await layoutDiagram(graph, { columns: 38 })
    assert.ok(layout.width <= (nested ? 42 : 38), "group label cannot become a wide empty column")
    assert.ok(layout.nodes[0].x < 15 && layout.nodes[0].y < 10, "first card stays near the group header")
    for (let i = 1; i < layout.nodes.length; i++) {
      assert.ok(layout.nodes[i].y - layout.nodes[i - 1].y - layout.nodes[i - 1].height <= 10, "nested groups inherit compact edge spacing")
    }
    assert.equal(layout.edges.length, graph.edges.length)
    assert.deepEqual(layout.scene!.regions.map(region => region.label), graph.notation!.family === "architecture"
      ? graph.notation!.groups.map(group => `${group.label} (${group.kind})`) : [])
    assert.deepEqual(graph, before)
  }
})
