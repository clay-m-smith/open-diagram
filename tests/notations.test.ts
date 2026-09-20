import assert from "node:assert/strict"
import test from "node:test"
import { authorRequest } from "../src/diagram/author.js"
import { affectedViews, evidenceFingerprints, type AcceptedDiagram } from "../src/diagram/cache.js"
import { DiagramEngine } from "../src/diagram/engine.js"
import { validateDiagramOutput } from "../src/diagram/harness.js"
import { GraphSchema, type DiagramGraph, type DiagramView } from "../src/diagram/schema.js"
import { notationEvidence, notationFixtures } from "./fixtures/notations.js"
import { diagramWires, layoutDiagram } from "../src/diagram/layout.js"
import { sceneWireRuns } from "../src/diagram/scene.js"

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
