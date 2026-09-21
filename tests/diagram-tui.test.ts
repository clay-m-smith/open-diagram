import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { Data, KeymapCommand, KeymapLayer, PanelInput, SlotClaim } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { RGBA, TextAttributes } from "@opentui/core"
import { batch, createComponent, createSignal, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"

import { diagramTextWidth, diagramWireRuns, diagramWires, layoutDiagram, wrapDiagramText } from "../src/diagram/layout.js"
import { diagramLayoutCost } from "../src/diagram/layout-quality.js"
import { runtimeRouting, encoderRouting } from "./fixtures/routing.js"
import { simplifyDiagramRoutes } from "../src/diagram/route-cleanup.js"
import { ARROW_COLORS, diagramArrowColor } from "../src/diagram/arrow-colors.js"
import { notationFixtures } from "./fixtures/notations.js"
import { type DiagramGraph, type DiagramState, initialState } from "../src/diagram/schema.js"
import {
  createDiagramMonitor, DIAGRAM_CACHE_LIMIT, DIAGRAM_TIMEOUT_MS, diagramStatus, diagramColors,
  resolveDiagramSession,
  type DiagramClient, type DiagramSession,
} from "../src/diagram/tui.js"

const graph: DiagramGraph = {
  title: "Branched pipeline",
  summary: "Two paths merge, with a feedback loop.",
  nodes: [
    { id: "a", label: "Input", kind: "input", status: "observed", detail: "Raw inputs", evidence: ["src"] },
    { id: "b", label: "Features", kind: "transform", status: "observed", detail: "Normalize raw inputs", behavior: "Centers each input channel and scales its variance before passing feature vectors to the model.", evidence: ["src"] },
    { id: "c", label: "Model", kind: "model", status: "planned", detail: "Alternative model", evidence: ["src"] },
    { id: "d", label: "Result", kind: "output", status: "planned", detail: "Merge results", evidence: ["src"] },
  ],
  edges: [
    { from: "a", to: "b", label: "left" },
    { from: "a", to: "c", label: "right" },
    { from: "b", to: "d", label: "features" },
    { from: "c", to: "d", label: "predictions" },
    { from: "d", to: "b", label: "feedback" },
    { from: "d", to: "d", label: "retry" },
  ],
}
const alpha: DiagramSession = { id: "alpha", location: { directory: "/remote", workspaceID: "one" } }
const beta: DiagramSession = { id: "beta", location: { directory: "/remote", workspaceID: "two" } }
const ready = (sessionID: string, revision = 1, nextGraph = graph): DiagramState => ({
  ...initialState(sessionID), revision, phase: "ready", relevant: true, graph: nextGraph,
  updatedAt: 100, changed: ["b"], sources: [{ id: "src", label: "read · /project/src/features.py · completed" }],
  reason: "Relevant algorithm chain",
})
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function transport() {
  type Options = Parameters<DiagramClient["get"]>[1]
  const calls: Array<ReturnType<typeof deferred<DiagramState>> & {
    kind: "get" | "control"
    input: { sessionID: string; mode?: DiagramState["mode"]; refresh?: boolean }
    options: Options
  }> = []
  const listeners = new Set<Parameters<DiagramClient["events"]["on"]>[1]>()
  const call = (kind: "get" | "control", input: typeof calls[number]["input"], options: Options) => {
    const pending = { ...deferred<DiagramState>(), kind, input, options }
    calls.push(pending)
    return pending.promise
  }
  const rpc: DiagramClient = {
    get: (input, options) => call("get", input, options),
    control: (input, options) => call("control", input, options),
    events: { on: (_name, listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
  }
  return {
    rpc, calls, listeners,
    emit(data: DiagramState, location?: DiagramSession["location"]) {
      for (const listener of listeners) listener({ data, location })
    },
  }
}

if (!process.execArgv.includes("--conditions=browser")) {
  test("diagram colors preserve legacy strings and current native RGBA theme tokens", () => {
    const expected = { text: "#eeeeee", subdued: "#999999", accent: "#ffaa00", border: "#555555" }
    assert.deepEqual(diagramColors({ text: { default: expected.text, subdued: expected.subdued,
      feedback: { warning: { default: expected.accent } } }, border: { default: expected.border } }), expected)
    const rgba = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, RGBA.fromHex(value)]))
    assert.deepEqual(diagramColors({ text: { base: rgba.text, muted: rgba.subdued,
      feedback: { warning: { base: rgba.accent } } }, border: { base: rgba.border } }), rgba)
  })

  test("content-sized flow preserves edges, routes around cards, and never invents adjacency", async () => {
    const isolated = { ...graph.nodes[0], id: "isolated", label: "Unconnected" }
    const layout = await layoutDiagram({ ...graph, nodes: [...graph.nodes, isolated] }, { columns: 80 })
    assert.equal(layout.nodes.length, 5)
    const edges = layout.edges
    assert.deepEqual(edges.map(({ from, to, label }) => ({ from, to, label })), graph.edges)
    assert.ok(layout.nodes.every((box) => box.width < 30), "short cards never stretch to panel width")
    assert.ok(edges.every((edge) => edge.from !== "isolated" && edge.to !== "isolated"))
    assert.equal(edges.find((edge) => edge.label === "left")!.cycle, false)
    assert.equal(edges.find((edge) => edge.label === "predictions")!.cycle, false)
    assert.equal(edges.find((edge) => edge.label === "features")!.cycle, false)
    assert.equal(edges.find((edge) => edge.label === "feedback")!.cycle, true)
    assert.equal(edges.find((edge) => edge.label === "retry")!.cycle, true)
    assert.doesNotMatch(diagramWires(layout), /\[\d+\]/)
    assert.match(diagramWires(layout), /▼/)
    assert.match(diagramWires(layout), /[◀▶▲]/)
    for (const edge of edges) {
      const target = layout.nodes.find((box) => box.node.id === edge.to)!
      const tip = edge.points.at(-1)!
      assert.equal(edge.targetSide === "left" ? tip.x : edge.targetSide === "right" ? tip.x : tip.y,
        edge.targetSide === "left" ? target.x - 1 : edge.targetSide === "right" ? target.x + target.width : edge.targetSide === "top" ? target.y - 1 : target.y + target.height)
      assert.equal(diagramWires(layout).split("\n")[tip.y][tip.x], { top: "▼", bottom: "▲", left: "▶", right: "◀" }[edge.targetSide])
      for (let i = 1; i < edge.points.length; i++) {
        const a = edge.points[i - 1]; const b = edge.points[i]
        assert.ok(a.x === b.x || a.y === b.y, "orthogonal path")
        for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
          assert.ok(x >= 0 && x < layout.width && y >= 0 && y < layout.height)
          assert.ok(layout.nodes.every((box) => x < box.x || x >= box.x + box.width || y < box.y || y >= box.y + box.height), "connector cannot cross a card")
        }
      }
    }
    const reversed = await layoutDiagram({ ...graph, nodes: [...graph.nodes].reverse(), edges: graph.edges.filter((edge) => edge.from !== "d") })
    assert.equal(reversed.nodes[0].node.id, "a", "flow order does not depend on input array order")
    assert.equal(diagramTextWidth("👩‍💻e\u0301日本"), 7)
    assert.deepEqual(wrapDiagramText("👩‍💻👩‍💻", 2), ["👩‍💻", "👩‍💻"])
    assert.equal(diagramTextWidth("𠮷".repeat(10)), 20)
    assert.deepEqual(wrapDiagramText("𠮷".repeat(10), 10), ["𠮷".repeat(5), "𠮷".repeat(5)])
    const fork = await layoutDiagram({ ...graph, edges: [
      { from: "a", to: "b", label: "next" }, { from: "a", to: "c", label: "red" }, { from: "a", to: "d", label: "blue" },
    ] })
    const crossed = { ...fork, width: 6, height: 6, edges: [
      { ...fork.edges[1], points: [{ x: 2, y: 0 }, { x: 2, y: 4 }] },
      { ...fork.edges[2], points: [{ x: 0, y: 2 }, { x: 4, y: 2 }] },
    ] }
    const crossing = diagramWireRuns(crossed).flatMap((run) => [...run.text].map((text) => ({ text, tone: run.tone })))[2 * 7 + 2]
    assert.deepEqual(crossing, { text: "│", tone: fork.edges[1].tone }, "unavoidable crossings still have no false join or overlap marker")
    assert.doesNotMatch(diagramWires(fork), /╳/)
    const maximum = {
      ...graph,
      nodes: Array.from({ length: 24 }, (_, index) => ({ ...isolated, id: `n${index}` })),
      edges: Array.from({ length: 48 }, (_, index) => ({ from: `n${index % 24}`, to: `n${(index + 1) % 24}`, label: `${index}:${"x".repeat(56)}` })),
    }
    const full = await layoutDiagram(maximum)
    assert.equal(full.nodes.length, 24)
    assert.equal(full.edges.length, 48)
    assert.ok(full.edges.every((edge) => edge.labelLines.join("").replace(/^↺\s*/, "").includes(edge.label)))
    assert.equal(diagramWires(full).split("\n").length, full.height)
  })

  test("arrow hues distinguish routes and remain stable through expansion, resize and edge reorder", async () => {
    const original = structuredClone(graph)
    const base = await layoutDiagram(graph)
    const identities = (layout: Awaited<ReturnType<typeof layoutDiagram>>) => Object.fromEntries(layout.edges.map((edge) =>
      [JSON.stringify([edge.from, edge.to, edge.label]), edge.tone]))
    assert.equal(new Set(base.edges.map((edge) => edge.tone)).size, graph.edges.length)
    assert.deepEqual(identities(await layoutDiagram(graph, { columns: 100, selected: "b", sourceControl: true })), identities(base))
    assert.deepEqual(identities(await layoutDiagram({ ...graph, edges: [...graph.edges].reverse() })), identities(base))
    const pixels = diagramWireRuns(base).flatMap((run) => [...run.text].map((text) => ({ text, tone: run.tone })))
    const arrow = base.edges[0]
    const tip = arrow.points.at(-1)!
    assert.deepEqual(pixels[tip.y * (base.width + 1) + tip.x], {
      text: { top: "▼", bottom: "▲", left: "▶", right: "◀" }[arrow.targetSide], tone: arrow.tone,
    }, "arrow hue survives bent as well as direct compact routes")
    for (let tone = 0; tone < ARROW_COLORS.length; tone++) assert.notEqual(diagramArrowColor(tone), diagramArrowColor(tone, true))
    assert.deepEqual(graph, original, "color assignment never mutates accepted graph")
  })

  test("ELK keeps downward flow, uses available width, and removes former right-lane crossings", async () => {
    const fork = { ...graph, edges: [{ from: "a", to: "b", label: "next" }, { from: "a", to: "c", label: "branch" }, { from: "a", to: "d", label: "skip" }] }
    const compact = await layoutDiagram(fork, { columns: 38 })
    const wide = await layoutDiagram(fork, { columns: 140 })
    assert.ok(wide.height <= compact.height, "more width need not force extra rows")
    assert.ok(compact.width <= 38 && wide.width <= 38, "small forks stay compact instead of spreading to fill a wide viewport")
    const root = wide.nodes.find((box) => box.node.id === "a")!
    assert.ok(wide.nodes.filter((box) => box.node.id !== "a").every((box) => box.y > root.y + root.height), "flow remains vertical, not left-to-right")
    const loop = await layoutDiagram(graph, { columns: 140 })
    assert.ok(loop.width < 53, "tighter horizontal gaps improve the previous 53-column branched layout")
    assert.ok(loop.edges.some((edge) => edge.targetSide === "left" || edge.sourceSide === "left"), "left ports are available for return routes")
    assert.ok(wide.edges.some((edge) => edge.points.some((point) => point.x > root.x + root.width)), "right routing is also available")
    let crossings = 0
    for (let i = 0; i < wide.edges.length; i++) for (const other of wide.edges.slice(i + 1)) {
      const edge = wide.edges[i]
      for (let a = 1; a < edge.points.length; a++) for (let b = 1; b < other.points.length; b++) {
        const p = edge.points[a - 1]; const q = edge.points[a]; const r = other.points[b - 1]; const s = other.points[b]
        const vertical = p.x === q.x; if (vertical === (r.x === s.x)) continue
        const [v, w, h, k] = vertical ? [p, q, r, s] : [r, s, p, q]
        if (v.x > Math.min(h.x, k.x) && v.x < Math.max(h.x, k.x) && h.y > Math.min(v.y, w.y) && h.y < Math.max(v.y, w.y)) crossings++
      }
    }
    assert.equal(crossings, 0, "old right-only fork had a crossing; ELK separates these routes")
    for (const layout of [compact, wide, loop]) for (const edge of layout.edges) for (let line = 0; line < edge.labelLines.length; line++) {
      const y = edge.labelY + line
      const row = diagramWires(layout).split("\n")[y]
      assert.equal(row.slice(edge.labelX, edge.labelX + diagramTextWidth(edge.labelLines[line])).trim(), "", "ELK label clearance survives cell snapping")
      for (let x = edge.labelX; x < edge.labelX + diagramTextWidth(edge.labelLines[line]); x++) {
        assert.ok(layout.nodes.every((box) => x < box.x || x >= box.x + box.width || y < box.y || y >= box.y + box.height), "compact labels cannot overlap cards")
        assert.ok(layout.edges.every((other) => other === edge || x < other.labelX || x >= other.labelX + Math.max(0, ...other.labelLines.map(diagramTextWidth))
          || y < other.labelY || y >= other.labelY + other.labelLines.length), "compact labels cannot overlap each other")
      }
    }
    const again = await layoutDiagram(structuredClone(fork), { columns: 140 })
    assert.deepEqual(again, wide, "same inputs give stable geometry")
    const pending = layoutDiagram(structuredClone(fork), { columns: 81 })
    const latest = layoutDiagram(fork, { columns: 140, selected: "b" })
    await Promise.all([pending, latest])
    assert.deepEqual((await latest).nodes.map((box) => box.node.id), wide.nodes.map((box) => box.node.id), "expansion preserves layer reading order")
  })

  test("long branch labels wrap into a compact downward view rather than adjacent wide lanes", async () => {
    const labeled = { ...graph, nodes: graph.nodes.map((node, i) => ({ ...node, label: `Stage ${i}`, status: "observed" as const })), edges: [
      { from: "a", to: "b", label: "normalized feature representation" },
      { from: "a", to: "c", label: "configured model inference results" },
      { from: "b", to: "d", label: "samples" }, { from: "c", to: "d", label: "samples" },
    ] }
    const original = structuredClone(labeled)
    const compact = await layoutDiagram(labeled, { columns: 38 })
    assert.ok(compact.width <= 38, "previous 46-column label lanes overflowed a 38-column viewport")
    assert.ok(compact.height <= 44, "compactness must not become an unnecessarily tall single column")
    assert.ok(compact.edges.every((edge) => edge.sourceSide === "bottom" && edge.targetSide === "top"), "keep forward flow downward")
    const wires = diagramWires(compact).split("\n")
    for (const edge of compact.edges) {
      assert.equal(edge.labelLines.join("").replace(/\s/g, ""), edge.label.replace(/\s/g, ""), "wrapping preserves the entire label")
      for (const [i, line] of edge.labelLines.entries()) {
        assert.equal(wires[edge.labelY + i].slice(edge.labelX, edge.labelX + diagramTextWidth(line)).trim(), "", "labels stay off arrow paths")
      }
    }
    assert.deepEqual(labeled, original, "reflow never rewrites accepted graph data")
  })

  test("layout objective penalizes crossings and shared wire lengths, and rejects obscured labels", async () => {
    const base = await layoutDiagram(graph)
    const edge = base.edges[0]
    const make = (points: { x: number; y: number }[][]): Awaited<ReturnType<typeof layoutDiagram>> => ({ nodes: [], width: 20, height: 20,
      edges: points.map((points) => ({ ...edge, points, labelLines: [], labelX: 0, labelY: 0 })) })
    const separated = make([[{ x: 2, y: 2 }, { x: 2, y: 12 }], [{ x: 4, y: 10 }, { x: 14, y: 10 }]])
    const crossing = make([[{ x: 8, y: 2 }, { x: 8, y: 12 }], [{ x: 4, y: 10 }, { x: 14, y: 10 }]])
    const shared = make([[{ x: 8, y: 2 }, { x: 8, y: 12 }], [{ x: 8, y: 2 }, { x: 8, y: 12 }]])
    assert.ok(diagramLayoutCost(crossing, 38) > diagramLayoutCost(separated, 38), "crossings cost more than equally short disjoint routes")
    assert.ok(diagramLayoutCost(shared, 38) > diagramLayoutCost(crossing, 38), "coincident edge lengths are not free compaction")
    const elbow = make([[{ x: 2, y: 2 }, { x: 2, y: 12 }, { x: 12, y: 12 }]])
    const stairs = make([[{ x: 2, y: 2 }, { x: 2, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 12 }, { x: 12, y: 12 }]])
    assert.ok(diagramLayoutCost(stairs, 38) > diagramLayoutCost(elbow, 38), "equal dimensions and length must favor fewer turns")
    crossing.edges[1] = { ...crossing.edges[1], labelLines: ["label"], labelX: 6, labelY: 4 }
    assert.equal(diagramLayoutCost(crossing, 38), Infinity, "narrowing may not hide an unrelated wire beneath text")
  })

  test("skip and feedback routes lose gratuitous bends without widening cards or losing arrow approaches", async () => {
    for (const [fixture, selected, columns, width, maxBends] of [[runtimeRouting, "n6", 88, 55, 14], [runtimeRouting, "n6", 38, 46, 16], [encoderRouting, undefined, 88, 59, 2]] as const) {
      const original = structuredClone(fixture)
      const layout = await layoutDiagram(fixture, { columns, selected })
      assert.ok(layout.width <= width, "simpler routing must not buy wider empty lanes")
      assert.ok(layout.edges.reduce((sum, e) => sum + e.points.length - 2, 0) <= maxBends, "reported shapes should not retain avoidable zigzags")
      assert.ok(Number.isFinite(diagramLayoutCost(layout, 88)), "all labels/cards retain clearance")
      for (const edge of layout.edges) {
        for (const [p, q, side] of [[edge.points[0], edge.points[1], edge.sourceSide], [edge.points.at(-1)!, edge.points.at(-2)!, edge.targetSide]] as const) {
          assert.ok(side === "top" ? p.x === q.x && q.y < p.y : side === "bottom" ? p.x === q.x && q.y > p.y
            : side === "left" ? p.y === q.y && q.x < p.x : p.y === q.y && q.x > p.x, "arrow must have an intact, correctly oriented approach")
        }
      }
      assert.deepEqual(fixture, original)
      assert.equal(layout.edges.length, fixture.edges.length)
    }
    const node = runtimeRouting.nodes[0]
    const mixed = { width: 16, height: 20, nodes: [
      { node: { ...node, id: "a" }, x: 2, y: 1, width: 10, height: 3, lines: [] },
      { node: { ...node, id: "b" }, x: 2, y: 14, width: 10, height: 3, lines: [] },
    ], edges: [{ from: "a", to: "b", label: "", cycle: false, direct: false, tone: 0, labelLines: [], labelX: 0, labelY: 0,
      sourceSide: "bottom" as const, targetSide: "top" as const, points: [{ x: 4, y: 4 }, { x: 4, y: 8 }, { x: 9, y: 8 }, { x: 9, y: 13 }] }] }
    for (const source of [true, false]) {
      const result = simplifyDiagramRoutes(structuredClone(mixed), [{ source, target: !source }])
      assert.equal(result.edges[0].points.length, 2, "unnamed end can align even when the other end is named")
      assert.deepEqual(source ? result.edges[0].points[0] : result.edges[0].points.at(-1), source ? mixed.edges[0].points[0] : mixed.edges[0].points.at(-1), "named endpoint stays fixed")
    }
    const fixed = simplifyDiagramRoutes(structuredClone(mixed), [{ source: true, target: true }])
    assert.deepEqual([fixed.edges[0].points[0], fixed.edges[0].points.at(-1)], [mixed.edges[0].points[0], mixed.edges[0].points.at(-1)])
  })

  test("monitor scopes events and initial snapshots; switches abort and reject obsolete responses", async (t) => {
    const wire = transport()
    const monitor = createDiagramMonitor(wire.rpc)
    t.after(() => monitor.dispose())
    monitor.select(alpha)
    await settle()
    assert.deepEqual(monitor.state(), initialState(alpha.id))
    assert.deepEqual(wire.calls[0].options.location, alpha.location)
    wire.emit(ready(alpha.id, 99), beta.location)
    wire.emit(ready(beta.id, 99), alpha.location)
    wire.emit(ready(alpha.id, 99))
    assert.equal(monitor.state()!.revision, 0, "ambiguous or foreign events are ignored")
    wire.emit(ready(alpha.id, 2), alpha.location)
    wire.calls[0].resolve(ready(alpha.id, 1))
    await settle()
    assert.equal(monitor.state()!.revision, 2, "an initial response cannot roll back a live event")
    wire.emit({ ...ready(alpha.id, 2), phase: "updating", reason: "New evidence" }, alpha.location)
    assert.equal(monitor.state()!.phase, "updating", "phase changes may share a graph revision")
    wire.emit(ready(alpha.id, 1), alpha.location)
    assert.equal(monitor.state()!.phase, "updating", "older events are rejected")

    const oldRead = monitor.refresh()
    await settle()
    const cancelled = wire.calls.at(-1)!
    monitor.select(beta)
    await settle()
    assert.equal(cancelled.options.signal.aborted, true)
    assert.equal(await oldRead, false)
    assert.equal(monitor.state()!.sessionID, beta.id)
    assert.equal(monitor.state()!.graph, null)
    cancelled.resolve(ready(alpha.id, 200))
    wire.calls.at(-1)!.resolve(ready(beta.id, 3))
    await settle()
    assert.equal(monitor.state()!.sessionID, beta.id)
    assert.equal(monitor.state()!.revision, 3)

    wire.emit({ ...ready(beta.id, 0), epoch: "reloaded" }, beta.location)
    await settle()
    wire.calls.at(-1)!.resolve({ ...ready(beta.id, 0), epoch: "reloaded" })
    await settle()
    assert.equal(monitor.state()!.epoch, "reloaded", "server reload starts a new revision epoch")
    wire.emit(ready(beta.id, 999), beta.location)
    assert.equal(monitor.state()!.epoch, "reloaded", "late events from a retired server epoch cannot roll back state")

    const oldControl = monitor.control({ mode: "off" })
    await settle()
    const control = wire.calls.at(-1)!
    assert.equal(control.kind, "control")
    assert.deepEqual(control.options.location, beta.location)
    monitor.select({ ...beta, location: { directory: "/moved", workspaceID: "two" } })
    await settle()
    assert.equal(control.options.signal.aborted, true, "moving the same session cancels its old location")
    assert.equal(await oldControl, false)
    wire.emit(ready(beta.id, 500), beta.location)
    control.resolve({ ...ready(beta.id, 500), mode: "off" })
    assert.equal(monitor.state()!.revision, 0)
    const moved = wire.calls.at(-1)!
    monitor.select(undefined)
    moved.resolve(ready(beta.id, 600))
    await settle()
    assert.equal(moved.options.signal.aborted, true)
    assert.equal(monitor.state(), undefined)
    assert.equal(monitor.busy(), false)
    monitor.dispose()
    assert.equal(wire.listeners.size, 0)
  })

  test("cache never polls; reconnect reads once, timeout retains graph until explicit retry", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
    const wire = transport()
    const monitor = createDiagramMonitor(wire.rpc)
    t.after(() => monitor.dispose())
    monitor.select(alpha)
    await settle()
    wire.calls[0].resolve(ready(alpha.id))
    await settle()
    t.mock.timers.tick(60_000)
    await settle()
    assert.equal(wire.calls.length, 1, "idle time causes no RPC")
    monitor.reconnect()
    await settle()
    assert.equal(wire.calls.length, 2)
    const shared = monitor.refresh()
    await settle()
    assert.equal(wire.calls.length, 2, "reconnect and explicit reads share one request")
    wire.calls[1].resolve(ready(alpha.id, 7))
    assert.equal(await shared, true)
    assert.equal(monitor.state()!.revision, 7, "snapshot recovers revisions missed during disconnect")
    monitor.reconnect()
    await settle()
    const hung = wire.calls.at(-1)!
    t.mock.timers.tick(DIAGRAM_TIMEOUT_MS)
    await settle()
    assert.equal(hung.options.signal.aborted, true)
    assert.match(diagramStatus(monitor.state(), monitor.problem()), /Stale snapshot.*timed out/)
    assert.equal(monitor.state()!.revision, 7, "last graph remains available during an outage")
    const countAfterTimeout = wire.calls.length
    t.mock.timers.tick(60_000)
    await settle()
    assert.equal(wire.calls.length, countAfterTimeout, "failure never starts background polling")
    const retry = monitor.refresh()
    await settle()
    wire.calls.at(-1)!.resolve(ready(alpha.id, 8))
    await retry
    assert.equal(monitor.problem(), undefined)
    hung.resolve(ready(alpha.id, 99))
    await settle()
    assert.equal(monitor.state()!.revision, 8, "a timed-out response is permanently cancelled")
    const outstanding = monitor.control({ refresh: true })
    await settle()
    const last = wire.calls.at(-1)!
    const count = wire.calls.length
    monitor.dispose()
    assert.equal(await outstanding, false)
    assert.equal(last.options.signal.aborted, true)
    assert.equal(wire.listeners.size, 0)
    t.mock.timers.tick(60_000)
    await settle()
    assert.equal(wire.calls.length, count)
    assert.equal(await monitor.refresh(), false)
    monitor.dispose()
  })

  test("session cache reuses snapshots, consumes inactive updates, scopes locations and bounds memory", async (t) => {
    const wire = transport()
    const monitor = createDiagramMonitor(wire.rpc)
    t.after(() => monitor.dispose())
    monitor.select(alpha)
    await settle()
    wire.calls.at(-1)!.resolve(ready(alpha.id))
    await settle()
    monitor.select(beta)
    await settle()
    wire.calls.at(-1)!.resolve(ready(beta.id))
    await settle()
    wire.emit(ready(alpha.id, 7), alpha.location)
    wire.emit(ready(alpha.id, 99), beta.location)
    monitor.select(alpha)
    assert.equal(monitor.state()?.revision, 7, "inactive push is cached immediately")
    await settle()
    assert.equal(wire.calls.length, 2, "revisiting a cached tab never reads")
    monitor.select(undefined)
    monitor.select(alpha)
    await settle()
    assert.equal(wire.calls.length, 2)
    monitor.reconnect(beta.location)
    await settle()
    assert.equal(wire.calls.length, 2, "foreign reconnect does not read active location")
    monitor.select(beta)
    assert.equal(monitor.state()?.revision, 1, "reconnect retains graph while reconciling")
    await settle()
    wire.calls.at(-1)!.resolve({ ...ready(beta.id, 1), epoch: "new" })
    await settle()
    const reads = wire.calls.length
    wire.emit(ready(beta.id, 99), beta.location)
    await settle()
    assert.equal(wire.calls.length, reads, "retired events cannot trigger repeated reads")
    for (let i = 0; i < DIAGRAM_CACHE_LIMIT; i++) {
      monitor.select({ id: `cache-${i}`, location: alpha.location })
      await settle()
      wire.calls.at(-1)!.resolve(ready(`cache-${i}`))
      await settle()
    }
    monitor.select(alpha)
    await settle()
    assert.equal(wire.calls.length, reads + DIAGRAM_CACHE_LIMIT + 1, "evicted session hydrates once")
  })

  test("authoritative snapshots reject unseen old epochs; live events cannot suppress control outcomes", async (t) => {
    const wire = transport()
    const monitor = createDiagramMonitor(wire.rpc)
    t.after(() => monitor.dispose())
    monitor.select(alpha)
    await settle()
    wire.calls[0].resolve({ ...ready(alpha.id, 10), epoch: "current" })
    await settle()
    wire.emit({ ...ready(alpha.id, 100), epoch: "unseen-old" }, alpha.location)
    assert.equal(monitor.state()!.epoch, "current")
    await settle()
    wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 10), epoch: "current" })
    await settle()
    assert.equal(monitor.state()!.epoch, "current", "fresh reads remain authoritative after buffered old epochs")
    const pausing = monitor.control({ mode: "off" })
    await settle()
    wire.emit({ ...ready(alpha.id, 11), epoch: "current" }, alpha.location)
    wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 12), epoch: "current", mode: "off", phase: "paused" })
    assert.equal(await pausing, true)
    assert.equal(monitor.state()!.mode, "off", "newer control response applies despite intervening event")
    const failing = monitor.control({ mode: "on" })
    await settle()
    wire.emit({ ...ready(alpha.id, 13), epoch: "current", mode: "off" }, alpha.location)
    wire.calls.at(-1)!.reject(new Error("control failed"))
    assert.equal(await failing, false)
    assert.match(monitor.problem()!, /server unavailable/)
  })

  test("missing event subscription remains visible after cache read and recovers on explicit retry", async (t) => {
    const wire = transport()
    const subscribe = wire.rpc.events.on
    wire.rpc.events.on = () => { throw new Error("no stream") }
    const monitor = createDiagramMonitor(wire.rpc)
    t.after(() => monitor.dispose())
    monitor.select(alpha)
    await settle()
    wire.calls.at(-1)!.resolve(ready(alpha.id))
    await settle()
    assert.match(monitor.problem()!, /Live diagram events unavailable; use Refresh/)
    monitor.select(beta)
    await settle()
    wire.calls.at(-1)!.resolve(ready(beta.id))
    await settle()
    wire.rpc.events.on = subscribe
    const retry = monitor.refresh()
    await settle()
    wire.calls.at(-1)!.resolve(ready(beta.id, 2))
    await retry
    assert.equal(monitor.problem(), undefined)
    assert.equal(wire.listeners.size, 1)
    const reads = wire.calls.length
    monitor.select(alpha)
    assert.equal(monitor.state()?.revision, 1, "missed-event snapshot remains visible during recovery")
    await settle()
    assert.equal(wire.calls.length, reads + 1, "subscription recovery invalidates inactive snapshots")
    wire.calls.at(-1)!.resolve(ready(alpha.id, 3))
    await settle()
    assert.equal(monitor.state()?.revision, 3)
  })

  test("failed cold/reconnect reads retain diagnostics on tab revisits without automatic retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    for (const cold of [false, true]) for (const timeout of [false, true]) {
      const wire = transport()
      const monitor = createDiagramMonitor(wire.rpc)
      try {
        monitor.select(alpha)
        await settle()
        if (!cold) {
          wire.calls.at(-1)!.resolve(ready(alpha.id))
          await settle()
          monitor.reconnect()
          await settle()
        }
        if (timeout) t.mock.timers.tick(DIAGRAM_TIMEOUT_MS)
        else wire.calls.at(-1)!.reject(new Error("unavailable"))
        await settle()
        const error = monitor.problem()
        assert.ok(error)
        monitor.select(beta)
        await settle()
        wire.calls.at(-1)!.resolve(ready(beta.id))
        await settle()
        const reads = wire.calls.length
        monitor.select(alpha)
        await settle()
        assert.equal(wire.calls.length, reads)
        assert.equal(monitor.problem(), error)
        assert.equal(monitor.state()?.graph?.title, cold ? undefined : graph.title)
        monitor.reconnect()
        await settle()
        assert.equal(wire.calls.length, reads + 1, "new recovery boundary permits one retry")
      } finally { monitor.dispose() }
    }
  })

  test("inactive epoch changes and reconnect during control reconcile only at event boundaries", async (t) => {
    const wire = transport()
    const monitor = createDiagramMonitor(wire.rpc)
    t.after(() => monitor.dispose())
    monitor.select(alpha)
    await settle()
    wire.calls.at(-1)!.resolve({ ...ready(alpha.id), epoch: "first" })
    await settle()
    monitor.select(beta)
    await settle()
    wire.calls.at(-1)!.resolve(ready(beta.id))
    await settle()
    wire.emit({ ...ready(alpha.id, 5), epoch: "next" }, alpha.location)
    await settle()
    assert.equal(wire.calls.length, 2, "inactive reload event does not fan out RPCs")
    monitor.select(alpha)
    assert.equal(monitor.state()?.epoch, "first")
    await settle()
    wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 5), epoch: "next" })
    await settle()
    const control = monitor.control({ mode: "off" })
    await settle()
    monitor.reconnect()
    wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 6), epoch: "next", mode: "off" })
    await control
    await settle()
    assert.equal(wire.calls.length, 5, "reconnect after in-flight control gets one fresh snapshot")
    wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 6), epoch: "next", mode: "off" })
    await settle()
    monitor.select(beta)
    await settle()
    assert.equal(wire.calls.length, 6, "inactive reconnect-invalidated entry reads on revisit")
  })

  test("explicit ensure retries unconfirmed warm cache and waits for newest reconciliation", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    for (const timeout of [false, true]) {
      const wire = transport()
      const monitor = createDiagramMonitor(wire.rpc)
      try {
        monitor.select(alpha)
        await settle()
        wire.calls.at(-1)!.resolve({ ...ready(alpha.id), epoch: "server", granularity: "overview" })
        await settle()
        monitor.reconnect()
        await settle()
        if (timeout) t.mock.timers.tick(DIAGRAM_TIMEOUT_MS)
        else wire.calls.at(-1)!.reject(new Error("reconnect failed"))
        await settle()
        const before = wire.calls.length
        let ensured = false
        const fresh = monitor.ensure().then((ok) => { ensured = ok; return ok })
        await settle()
        assert.equal(wire.calls.length, before + 1, "explicit action retries failed warm authority check")
        monitor.reconnect()
        wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 2), epoch: "server", granularity: "granular" })
        await settle()
        assert.equal(ensured, false, "first response is superseded by newer boundary")
        assert.equal(wire.calls.length, before + 2)
        wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 3), epoch: "server", granularity: "overview" })
        assert.equal(await fresh, true)
        assert.equal(monitor.state()?.granularity, "overview")
      } finally { monitor.dispose() }
    }
  })

  test("ensure follows event-admitted successors after rejection/timeout but never retries failure alone", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    for (const timeout of [false, true]) for (const successor of [false, true]) {
      const wire = transport()
      const monitor = createDiagramMonitor(wire.rpc)
      try {
        monitor.select(alpha)
        await settle()
        let result: boolean | undefined
        const ensuring = monitor.ensure().then((ok) => { result = ok; return ok })
        if (successor) monitor.reconnect()
        if (timeout) t.mock.timers.tick(DIAGRAM_TIMEOUT_MS)
        else wire.calls[0].reject(new Error("superseded read failed"))
        await settle()
        assert.equal(wire.calls.length, successor ? 2 : 1)
        if (successor) {
          assert.equal(result, undefined, "intent waits for successor despite failed first GET")
          wire.calls[1].resolve({ ...ready(alpha.id), epoch: "server", granularity: "granular" })
        }
        assert.equal(await ensuring, successor)
      } finally { monitor.dispose() }
    }
  })

  test("public directory-only session uses host workspace ref for RPC and live events", async (t) => {
    const wire = transport()
    const monitor = createDiagramMonitor(wire.rpc)
    t.after(() => monitor.dispose())
    const publicSession = { id: alpha.id, location: { directory: alpha.location.directory } }
    monitor.select(resolveDiagramSession(publicSession, alpha.location, beta.location))
    await settle()
    assert.deepEqual(wire.calls[0].options.location, alpha.location)
    wire.calls[0].resolve(ready(alpha.id, 1))
    await settle()
    wire.emit(ready(alpha.id, 2), alpha.location)
    assert.equal(monitor.state()!.revision, 2)
    wire.emit(ready(alpha.id, 99), beta.location)
    assert.equal(monitor.state()!.revision, 2)
    assert.deepEqual(resolveDiagramSession(publicSession, { directory: "/other" }, alpha.location)?.location, alpha.location)
  })

  test("RPC failure provides an actionable fallback and later get clears it", async (t) => {
    const wire = transport()
    const monitor = createDiagramMonitor(wire.rpc)
    t.after(() => monitor.dispose())
    monitor.select(alpha)
    await settle()
    wire.calls[0].reject(new Error("missing RPC"))
    await settle()
    assert.match(diagramStatus(monitor.state(), monitor.problem()), /Unavailable.*server plugin/)
    const retry = monitor.refresh()
    await settle()
    wire.calls[1].resolve({ ...ready(alpha.id), phase: "unavailable", stale: true, reason: "Model unavailable" })
    await retry
    assert.equal(monitor.problem(), undefined)
    assert.match(diagramStatus(monitor.state()), /unavailable.*stale snapshot.*Model unavailable/)
    assert.match(diagramStatus({ ...ready(alpha.id), cacheError: "cache write failed" }), /cache write failed/)
  })

  test("failed tracking actions survive successful depth controls and polls until explicit retry", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
    for (const timeout of [false, true]) {
      const wire = transport()
      const monitor = createDiagramMonitor(wire.rpc)
      try {
        monitor.select(alpha)
        await settle()
        wire.calls[0].resolve(ready(alpha.id))
        await settle()
        const paused = monitor.control({ mode: "off" })
        await settle()
        if (timeout) t.mock.timers.tick(DIAGRAM_TIMEOUT_MS)
        else wire.calls.at(-1)!.reject(new Error("failed pause"))
        assert.equal(await paused, false)
        const depth = monitor.control({ granularity: "granular" })
        await settle()
        wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 2), granularity: "granular" })
        assert.equal(await depth, true)
        assert.match(monitor.problem()!, /Pause was not confirmed/)
        const poll = monitor.refresh()
        await settle()
        wire.calls.at(-1)!.resolve(ready(alpha.id, 3))
        await poll
        assert.match(monitor.problem()!, /Pause was not confirmed/)
        const retry = monitor.control({ mode: "off" })
        await settle()
        wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 4), mode: "off", phase: "paused" })
        assert.equal(await retry, true)
        assert.equal(monitor.problem(), undefined)
      } finally { monitor.dispose() }
    }
  })

  test("declared capacity errors preserve retry and unsaved-preference diagnostics", async (t) => {
    const wire = transport()
    const monitor = createDiagramMonitor(wire.rpc)
    t.after(() => monitor.dispose())
    monitor.select(alpha)
    await settle()
    wire.calls[0].resolve(ready(alpha.id))
    await settle()
    const control = monitor.control({ mode: "on" })
    await settle()
    wire.calls.at(-1)!.reject({ type: "capacity", message: "PRIVATE", data: { mode: "on", cacheError: "PRIVATE" } })
    assert.equal(await control, false)
    assert.match(monitor.problem()!, /capacity reached; refresh to retry/)
    assert.match(monitor.problem()!, /Effective mode: on/)
    assert.match(monitor.problem()!, /preference is not saved.*cache write failed/)
    assert.doesNotMatch(monitor.problem()!, /server unavailable|PRIVATE/)
    wire.emit({ ...ready(alpha.id, 2), mode: "on" }, alpha.location)
    assert.match(monitor.problem()!, /capacity reached/, "delayed mode event is not collection admission")
    const recovered = monitor.control({ refresh: true })
    await settle()
    wire.calls.at(-1)!.resolve({ ...ready(alpha.id, 2), mode: "on", cacheError: null })
    assert.equal(await recovered, true)
    assert.equal(monitor.problem(), undefined, "successful suggested Refresh clears known-effective capacity failure")
    const pause = monitor.control({ mode: "off" })
    await settle()
    wire.calls.at(-1)!.reject(new Error("pause failed"))
    await pause
    const depth = monitor.control({ granularity: "granular" })
    await settle()
    wire.calls.at(-1)!.reject({ type: "capacity", data: { mode: "on", cacheError: "cache write failed" } })
    await depth
    assert.match(monitor.problem()!, /Pause was not confirmed/)
    assert.match(monitor.problem()!, /capacity reached/)
    assert.match(monitor.problem()!, /preference is not saved/)
  })

  const [major, minor] = process.versions.node.split(".").map(Number)
  test("diagram mounts and updates through Solid's real OpenTUI renderer", {
    skip: major > 26 || (major === 26 && minor >= 4) ? false : "Native OpenTUI rendering requires Node >=26.4 with --experimental-ffi",
  }, () => {
    const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env
    const result = spawnSync(process.execPath, [
      "--experimental-ffi", "--conditions=browser", "--import", "tsx", "--test", fileURLToPath(import.meta.url),
    // Whole interaction traversal, not a single solve. Each layout still has its
    // own 5-second deadline below; allow headroom when suites share the runner.
    ], { encoding: "utf8", timeout: 60_000, env })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /tests 1\b/)
  })
} else {
  test("mounted diagram renders branches, updates reactively, respects dismissal, and switches sessions", async (t) => {
    const root = fileURLToPath(new URL("../", import.meta.url))
    const temporary = await mkdtemp(join(tmpdir(), "open-diagram-render-"))
    t.after(() => rm(temporary, { recursive: true, force: true }))
    await symlink(join(root, "node_modules"), join(temporary, "node_modules"))
    const require = createRequire(import.meta.resolve("@opentui/solid"))
    const babel = require("@babel/core")
    for (const name of ["view", "tui"]) {
    const transformed = await babel.transformFileAsync(join(root, `src/diagram/${name}.tsx`), {
      configFile: false, babelrc: false,
      presets: [
        [require.resolve("babel-preset-solid"), { generate: "universal", moduleName: "@opentui/solid" }],
        [require.resolve("@babel/preset-typescript"), { allExtensions: true, isTSX: true }],
      ],
    })
    assert.ok(transformed?.code)
    const compiled = transformed.code.replace(/from (["'])(\.\/[^"']+)\1/g, (_match: string, _quote: string, path: string) =>
      `from ${JSON.stringify(path === "./view.js" ? "./view.mjs" : pathToFileURL(resolve(root, "src/diagram", path.replace(/\.js$/, ".ts"))).href)}`)
    await writeFile(join(temporary, `${name}.mjs`), compiled)
    }
    const { default: plugin } = await import(pathToFileURL(join(temporary, "tui.mjs")).href)
    const { sourceCaption } = await import(pathToFileURL(join(temporary, "view.mjs")).href)
    assert.equal(sourceCaption("read · package.json · completed"), "package.json")
    assert.equal(sourceCaption("Child abc123 · edit · /project/src/features.py · completed"), "src/features.py")
    assert.equal(sourceCaption("shell · completed"), "Development context")
    assert.equal(sourceCaption("execute · error"), "Development context")
    const host = await babel.transformAsync(`import { Show } from "solid-js";
      export function Host(props) { return <box width="100%" height="100%" flexDirection="column">
        {props.app.render({})}<Show when={props.panel()} fallback={<scrollbox width={42} height="100%" scrollX={false}>
          {props.header.render({ get sessionID() { return props.sessionID() } })}
          <Show when={props.replacement()} keyed fallback={<text>Native sidebar contents</text>}>
            {(slot) => slot.render({ get sessionID() { return props.sessionID() } })}
          </Show></scrollbox>}>{props.renderPanel()}</Show></box> }`, {
      configFile: false, babelrc: false, presets: [[require.resolve("babel-preset-solid"), { generate: "universal", moduleName: "@opentui/solid" }]],
    })
    await writeFile(join(temporary, "host.mjs"), host.code)
    const { Host } = await import(pathToFileURL(join(temporary, "host.mjs")).href)

    type Session = NonNullable<ReturnType<Data["session"]["get"]>>
    const sessions: Session[] = [alpha, beta].map((session) => ({
      ...session, location: { directory: session.location.directory }, projectID: "project", title: session.id, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 },
    }))
    const otherGraph = { ...graph, title: "Beta pipeline", nodes: [{ ...graph.nodes[0], label: "Beta input" }], edges: [] }
    const nativeReady = (...args: Parameters<typeof ready>): DiagramState => {
      const state = ready(...args)
      return { ...state, epoch: "server", views: [{ id: "model", label: "Model", graph: state.graph! },
        { id: "repo", label: "Files", graph: { ...otherGraph, title: "Repository view", nodes: [{ ...graph.nodes[0], label: "package.json" }] } }] }
    }
    const states = new Map([[alpha.id, nativeReady(alpha.id)], [beta.id, nativeReady(beta.id, 1, otherGraph)]])
    const [selected, setSelected] = createSignal<string | undefined>(alpha.id)
    const [panel, setPanel] = createSignal<{ name: string; sessionID: string }>()
    const [fullscreen, setFullscreen] = createSignal(false)
    const [preferences, updatePreferences] = createStore<{ sidebarVisible: boolean; exportTheme?: "system" | "dark" | "light" }>({ sidebarVisible: true })
    const [themeText, setThemeText] = createSignal<string | RGBA>("#eeeeee")
    const slots: SlotClaim[] = []
    const [replacement, setReplacement] = createSignal<SlotClaim>()
    const commands = new Map<string, KeymapCommand>()
    const listeners = new Set<Parameters<DiagramClient["events"]["on"]>[1]>()
    const opened: string[] = []
    const removed: SlotClaim[] = []
    const toasts: string[] = []
    const hostListeners = new Map<string, (event: { location?: DiagramSession["location"] }) => void>()
    const reconnect = () => hostListeners.get("server.connected")!({})
    const controls: Array<Parameters<DiagramClient["control"]>[0]> = []
    let focusCount = 0
    let writeFailure = false
    let themeChoice: "system" | "dark" | "light" | undefined = "dark"
    let readCount = 0
    let held: (ReturnType<typeof deferred<DiagramState>> & { signal?: AbortSignal }) | undefined
    let heldControl: (ReturnType<typeof deferred<DiagramState>> & { afterApply: boolean }) | undefined
    const transportLocation = (id: string) => (id === alpha.id ? alpha : beta).location
    const emit = (state: DiagramState, location = transportLocation(state.sessionID)) => {
      states.set(state.sessionID, state)
      for (const listener of listeners) listener({ data: state, location })
    }
    const rpc: DiagramClient = {
      async get(input, options) {
        readCount++
        assert.deepEqual(options.location, transportLocation(input.sessionID))
        if (held && input.sessionID === alpha.id) { held.signal = options.signal; return held.promise }
        return states.get(input.sessionID)!
      },
      async control(input, options) {
        controls.push(input)
        assert.deepEqual(options.location, transportLocation(input.sessionID))
        if (heldControl && !heldControl.afterApply) return heldControl.promise
        const old = states.get(input.sessionID)!
        const mode = input.mode ?? old.mode
        const next: DiagramState = { ...old, mode, granularity: input.granularity ?? old.granularity, revision: old.revision + 1, phase: mode === "off" ? "paused" : "ready" }
        emit(next)
        if (heldControl) return heldControl.promise
        return next
      },
      events: { on: (_name, listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    }
    const cleanup = await plugin.setup({
      get location() { return selected() ? transportLocation(selected()!) : undefined },
      client: { rpc: (definition: { id: string }) => { assert.equal(definition.id, "open-diagram"); return rpc } },
      storage: { store: (key: string, options: { initial: object }) => {
        assert.equal(key, "diagram-preferences")
        assert.deepEqual(options.initial, { sidebarVisible: true, exportTheme: "system" })
        return [preferences, async (mutate: (draft: typeof preferences) => void) => {
          if (writeFailure) throw new Error("storage unavailable")
          updatePreferences(produce(mutate))
        }]
      } },
      data: { on: (type: string, fn: (event: {}) => void) => { hostListeners.set(type, fn); return () => hostListeners.delete(type) },
        location: { default: () => transportLocation(selected() ?? alpha.id) }, session: { get: (id: string) => sessions.find((session) => session.id === id) } },
      keymap: { layer: (layer: () => KeymapLayer) => {
        for (const command of layer().commands ?? []) {
          const key = command.id ?? (typeof command.bind === "string" ? command.bind : undefined)
          if (key) commands.set(key, command)
        }
      } },
      theme: { text: { get default() { return themeText() }, subdued: "#aaaaaa", feedback: { warning: { default: "#ffff00" } } }, border: { default: "#888888" } },
      themeMode: "dark",
      ui: {
        dialog: { select: async (input: { title: string; current: string }) => {
          assert.equal(input.title, "Diagram export theme")
          assert.equal(input.current, preferences.exportTheme ?? "system")
          return themeChoice
        } },
        slot: (slot: SlotClaim) => {
          slots.push(slot)
          if (slot.replace === "sidebar.content") setReplacement(slot)
          return () => { removed.push(slot); if (slot.replace === "sidebar.content") setReplacement(undefined) }
        },
        toast: { show: ({ message }: { message: string }) => { toasts.push(message) } },
        router: { current: () => selected() ? { type: "session", sessionID: selected() } : { type: "home" } },
        panel: {
          current: panel,
          open: (name: string, options?: { presentation: string }) => {
            if (!selected()) return false
            opened.push(selected()!)
            if (options?.presentation === "fullscreen") setFullscreen(true)
            setPanel({ name, sessionID: selected()! })
            return true
          },
          close: () => { setPanel(undefined) },
        },
      },
    })
    t.after(() => cleanup())
    const app = slots.find((slot) => slot.append === "app")!
    const panelSlot = slots.find((slot) => slot.append === "session.panel")!
    const [panelWidth, setPanelWidth] = createSignal(80)
    const input: PanelInput = {
      get name() { return panel()?.name ?? "" },
      get sessionID() { return selected() ?? "" },
      get width() { return panelWidth() },
      get presentation() { return fullscreen() ? "fullscreen" : "panel" },
      focused: true,
      focus: () => { focusCount++ },
      close: () => { setPanel(undefined) },
      toggleFullscreen: () => { setFullscreen(!fullscreen()) },
    }
    const rendered = await testRender(() => createComponent(Host, {
      app, panel, sessionID: selected, header: slots.find((slot) => slot.before === "sidebar.content"), replacement,
      renderPanel: () => panelSlot.render(input as never),
    }), { width: 80, height: 50 })
    t.after(() => rendered.renderer.destroy())
    const flush = async () => {
      await settle(); await rendered.flush()
      // Renderer flush drains microtasks only; the real ELK worker needs event
      // loop turns, not more synchronous frame passes.
      const deadline = Date.now() + 5_000
      while (rendered.renderer.root.findDescendantById("open-diagram-layout-pending")) {
        assert.ok(Date.now() < deadline, "ELK layout completed")
        await new Promise((resolve) => setTimeout(resolve, 10))
        await rendered.flush()
      }
      await rendered.flush()
    }
    const run = async (id: string, argument?: string) => { await commands.get(id)!.run(argument); await flush() }
    await flush()
    assert.equal(opened.length, 0, "default uses sidebar rather than opening a wide panel")
    assert.ok(slots.some((slot) => slot.before === "sidebar.content"), "tab anchor survives content replacement")
    assert.ok(slots.some((slot) => slot.replace === "sidebar.content"), "diagram uses reversible native slot")
    assert.match(rendered.captureCharFrame(), /Branched pipeline/)
    const toolbarSpan = (label: string) => rendered.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(`[${label}]`))!
    const selectedStyle = TextAttributes.BOLD | TextAttributes.UNDERLINE
    assert.equal(toolbarSpan("Model").attributes & selectedStyle, selectedStyle, "active view has a non-color-only indicator")
    assert.equal(toolbarSpan("Overview").attributes & selectedStyle, selectedStyle, "depth uses the same active style")
    assert.equal(toolbarSpan("Files").attributes & selectedStyle, 0)
    const header = rendered.captureCharFrame().split("\n")
    for (const [group, button] of [["View", "Model"], ["Depth", "Overview"], ["Tools", "Pause"], ["Export", "PNG"]]) {
      const row = header.find((line) => line.startsWith(group))!
      assert.ok(row, `${group} has a consistent group label`)
      assert.equal(row.indexOf(`[${button}]`), 7, "group controls align on the same column")
    }
    assert.match(rendered.captureCharFrame(), /\[Refresh\]/, "sidebar uses the same explicit action label as the panel")
    assert.match(rendered.captureCharFrame(), /\[Theme: System\]/, "old preferences without export theme follow host")
    const themeRow = rendered.captureCharFrame().split("\n").findIndex((line) => line.includes("[Theme: System]"))
    await rendered.mockMouse.click(rendered.captureCharFrame().split("\n")[themeRow].indexOf("[Theme: System]") + 2, themeRow)
    await flush()
    assert.equal(preferences.exportTheme, "dark")
    assert.match(rendered.captureCharFrame(), /\[Theme: Dark\]/)
    themeChoice = undefined
    await run("open-diagram", "export-theme")
    assert.equal(preferences.exportTheme, "dark", "cancel keeps preference")
    themeChoice = "light"; writeFailure = true
    await run("open-diagram", "export-theme")
    assert.equal(preferences.exportTheme, "dark", "failed preference write keeps previous mode")
    assert.match(toasts.at(-1)!, /Could not save diagram export theme/)
    writeFailure = false; themeChoice = "system"
    await run("open-diagram-export-theme")
    assert.equal(preferences.exportTheme, "system")
    assert.equal(readCount, 1, "export theme controls neither fetch nor regenerate")
    const clickTab = async (label: string) => {
      const lines = rendered.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes(`[${label}]`))
      assert.ok(row >= 0, `${label} tab is visible`)
      await rendered.mockMouse.click(lines[row].indexOf(`[${label}]`) + 2, row)
      await flush()
    }
    await clickTab("Files")
    assert.equal(toolbarSpan("Files").attributes & selectedStyle, selectedStyle)
    assert.equal(toolbarSpan("Model").attributes & selectedStyle, 0, "old view clears its selected style")
    assert.match(rendered.captureCharFrame(), /Repository view/)
    assert.doesNotMatch(rendered.captureCharFrame(), /Branched pipeline/)
    await clickTab("Classic sidebar")
    assert.match(rendered.captureCharFrame(), /Native sidebar contents/)
    assert.equal(replacement(), undefined, "native slot restored rather than imitated")
    await clickTab("Model")
    assert.equal(readCount, 1, "view and native sidebar tabs are cache-only")
    assert.match(rendered.captureCharFrame(), /Branched pipeline/)
    assert.doesNotMatch(rendered.captureCharFrame(), /Native sidebar contents/)
    await run("open-diagram", "panel")
    assert.equal(readCount, 1, "opening panel does not fetch or recollect")
    let frame = rendered.captureCharFrame()
    assert.deepEqual(opened, [alpha.id], "panel opens only by explicit request")
    assert.match(frame, /Drag divider to resize/)
    assert.match(frame, /\[Classic sidebar\]/)
    assert.match(frame, /\[Fullscreen\]/, "panel action uses a full, consistent label")
    rendered.resize(32, 50); setPanelWidth(32)
    await flush()
    const narrowHeader = rendered.captureCharFrame().split("\n").slice(0, 14).join("\n")
    for (const label of ["Model", "Files", "Classic sidebar", "Overview", "Granular", "Pause", "Refresh", "Fullscreen", "Close", "PNG", "SVG", "Save", "Theme: System"]) {
      assert.ok(narrowHeader.includes(`[${label}]`), `narrow toolbar keeps ${label} whole and reachable`)
    }
    const beforeWrapped = states.get(alpha.id)!
    const wrappedGraph = { ...notationFixtures.architecture,
      title: "Convolution stem and transformer encoder with complete title",
      summary: "Validated inputs pass through convolution stages and position encoding before transformer blocks and final normalization.",
    }
    const warning = "Diagram repair timed out within the configured generation budget; previous validated diagram remains available. Refresh to retry."
    emit({ ...beforeWrapped, graph: wrappedGraph, views: [{ id: "model", label: "Model", graph: wrappedGraph }], updateError: warning, stale: true })
    await flush()
    const wrappedFrame = rendered.captureCharFrame().replace(/[\s█]/g, "")
    for (const text of [warning, wrappedGraph.title, wrappedGraph.summary]) {
      assert.ok(wrappedFrame.includes(text.replace(/\s/g, "")), `narrow panel wraps complete warning, title and summary instead of clipping: ${text}\n${rendered.captureCharFrame()}`)
    }
    assert.equal(readCount, 1, "cached text wrapping needs no RPC or generation")
    emit(beforeWrapped)
    await flush()
    const narrowRows = narrowHeader.split("\n")
    const narrowFull = narrowRows.findIndex((line) => line.includes("[Fullscreen]"))
    await rendered.mockMouse.click(narrowRows[narrowFull].indexOf("[Fullscreen]") + 2, narrowFull)
    await flush()
    assert.equal(fullscreen(), true, "wrapped control remains clickable")
    await run("open-diagram-panel-fullscreen")
    const shortLabels = states.get(alpha.id)!
    const longLabels = { ...shortLabels, views: shortLabels.views.map((view, i) => ({ ...view,
      label: i === 0 ? "模型".repeat(12) : "Repository configuration" })) }
    emit(longLabels)
    await flush()
    const compactTabs = rendered.captureCharFrame().split("\n").filter((line) => line.includes("模型") || line.includes("Repository"))
    assert.equal(compactTabs.length, 2)
    for (const line of compactTabs) assert.match(line, /\[[^\[\]]+…\]/u, "long ASCII and wide Unicode labels keep whole brackets on one row")
    const repoRow = rendered.captureCharFrame().split("\n").findIndex((line) => line.includes("[Repository"))
    await rendered.mockMouse.click(9, repoRow)
    await flush()
    assert.match(rendered.captureCharFrame(), /Repository view/, "ellipsized tab still selects the original view ID")
    rendered.resize(80, 50); setPanelWidth(80)
    await flush()
    assert.ok(rendered.captureCharFrame().includes(`[${"模型".repeat(12)}]`), "widening restores the complete Unicode caption")
    assert.ok(rendered.captureCharFrame().includes("[Repository configuration]"))
    emit(shortLabels)
    await flush()
    await clickTab("Model")
    frame = rendered.captureCharFrame()
    for (const label of ["left", "right", "feedback", "retry"]) assert.ok(frame.includes(label), `${label}\n${frame}`)
    assert.match(frame, /▼/)
    assert.match(frame, /[◀▶▲]/)
    assert.doesNotMatch(frame, /\[\d+\]/)
    const spans = () => rendered.captureSpans().lines.flatMap((line) => line.spans)
    const labelColor = (label: string) => spans().find((span) => span.text.trim() === label)!.fg.toInts().slice(0, 3)
    assert.notDeepEqual(labelColor("left"), labelColor("right"), "native branch labels have distinct colors")
    assert.ok(spans().some(span => /[▼▲◀▶]/.test(span.text) && span.fg.toInts().slice(0, 3).every((value, i) => value === labelColor("left")[i])),
      "native arrowhead matches its label independently of which routed arrow appears first")
    const leftTone = (await layoutDiagram(graph)).edges[0].tone
    assert.deepEqual(labelColor("left"), RGBA.fromHex(diagramArrowColor(leftTone, true)).toInts().slice(0, 3))
    setThemeText(RGBA.fromHex("#172033"))
    await flush()
    assert.deepEqual(labelColor("left"), RGBA.fromHex(diagramArrowColor(leftTone)).toInts().slice(0, 3), "native light theme uses darker hue")
    setThemeText("#eeeeee")
    await flush()
    assert.doesNotMatch(frame, /transform · observed|Arrows reference|No additional detail/)
    assert.match(frame, /Features \*/)
    const row = frame.split("\n").findIndex((line) => line.includes("Features"))
    await rendered.mockMouse.click(frame.split("\n")[row].indexOf("Features") + 1, row)
    await flush()
    assert.match(rendered.captureCharFrame(), /Normalize raw inputs/)
    assert.match(rendered.captureCharFrame(), /Centers each input channel/)
    assert.doesNotMatch(rendered.captureCharFrame(), /features\.py|read ·|completed/)
    const sourceRow = rendered.captureCharFrame().split("\n").findIndex((line) => line.includes("[Sources]"))
    await rendered.mockMouse.click(rendered.captureCharFrame().split("\n")[sourceRow].indexOf("[Sources]") + 2, sourceRow)
    await flush()
    assert.match(rendered.captureCharFrame(), /src\/features\.py/)
    assert.doesNotMatch(rendered.captureCharFrame(), /read ·|completed/)
    assert.match(rendered.captureCharFrame(), /Normalize raw inputs/, "source toggle never collapses the block")
    emit(structuredClone(states.get(alpha.id)!))
    await flush()
    assert.match(rendered.captureCharFrame(), /src\/features\.py/, "unchanged cloned polling snapshots preserve source disclosure")
    assert.equal(focusCount, 1)

    const updated = nativeReady(alpha.id, 2, { ...graph, nodes: graph.nodes.map((node) => node.id === "b"
      ? { ...node, label: "Features v2", kind: "train", status: "planned" } : node) })
    emit(updated)
    await flush()
    frame = rendered.captureCharFrame()
    assert.match(frame, /Features v2 ~ \*/)
    assert.match(frame, /train · planned/)
    assert.doesNotMatch(frame, /features\.py/, "new graph resets source disclosure")
    assert.equal(opened.length, 1, "live updates never reopen or refocus a visible panel")
    assert.equal(focusCount, 1)

    setPanel(undefined)
    await flush()
    emit({ ...updated, revision: 3 })
    await flush()
    assert.equal(panel(), undefined, "host dismissal suppresses automatic reopening")
    batch(() => { setSelected(beta.id); setPanel(undefined) })
    await flush()
    await run("open-diagram", "panel")
    assert.match(rendered.captureCharFrame(), /Beta pipeline/)
    batch(() => { setSelected(alpha.id); setPanel(undefined) })
    await flush()
    assert.equal(panel(), undefined, "dismissal survives visiting another session")
    await run("open-diagram", "panel")
    assert.match(rendered.captureCharFrame(), /Features v2/)
    const cachedVisible = states.get(alpha.id)!
    emit({ ...cachedVisible, revision: cachedVisible.revision + 1, phase: "ready", updateError: "Update failed; cached diagram retained", stale: true })
    await flush()
    assert.match(rendered.captureCharFrame(), /Update failed; cached diagram/)
    assert.match(rendered.captureCharFrame(), /Features v2/, "update warning never replaces the working graph")
    emit({ ...cachedVisible, revision: cachedVisible.revision + 2, updateError: null })
    await flush()
    assert.equal(readCount, 2, "session-tab revisit reuses cached diagram")
    await run("open-diagram-panel-fullscreen")
    assert.equal(fullscreen(), true)
    assert.match(rendered.captureCharFrame(), /\[Restore\]/)
    await run("open-diagram", "on")
    await run("open-diagram-panel-pause")
    assert.equal(controls.at(-1)!.mode, "off")
    assert.match(rendered.captureCharFrame(), /Diagram · paused/)
    assert.match(rendered.captureCharFrame(), /\[Resume\]/)
    await run("open-diagram-panel-pause")
    assert.equal(controls.at(-1)!.mode, "on", "resume restores the previous mode")
    await run("open-diagram-auto")
    assert.equal(controls.at(-1)!.mode, "auto")
    await run("open-diagram-refresh")
    assert.equal(controls.at(-1)!.refresh, true)
    await run("open-diagram-off")
    assert.equal(controls.at(-1)!.mode, "off")

    await run("open-diagram", "on")
    const beforeToggle = states.get(alpha.id)!
    held = deferred<DiagramState>()
    const toggle = commands.get("open-diagram-panel-pause")!.run()
    await settle()
    emit({ ...beforeToggle, revision: beforeToggle.revision + 1 })
    held.resolve(beforeToggle)
    held = undefined
    await toggle
    await flush()
    assert.equal(controls.at(-1)!.mode, "off", "a live event overtaking GET cannot discard a warm pause")

    await run("open-diagram", "on")
    heldControl = { ...deferred<DiagramState>(), afterApply: true }
    const slowPause = commands.get("open-diagram-panel-pause")!.run()
    await flush()
    assert.match(rendered.captureCharFrame(), /\[Resume\]/)
    const quickResume = commands.get("open-diagram-panel-pause")!.run()
    await settle()
    heldControl.resolve(states.get(alpha.id)!)
    heldControl = undefined
    await Promise.all([slowPause, quickResume])
    await flush()
    assert.equal(states.get(alpha.id)?.mode, "on", "opposite displayed action survives delayed acknowledgement")

    heldControl = { ...deferred<DiagramState>(), afterApply: false }
    const failedPause = commands.get("open-diagram-panel-pause")!.run()
    await settle()
    await clickTab("Granular")
    heldControl.reject(new Error("Pause transport failed"))
    heldControl = undefined
    await failedPause
    await flush()
    assert.equal(states.get(alpha.id)?.mode, "on")
    assert.equal(states.get(alpha.id)?.granularity, "granular")
    assert.match(rendered.captureCharFrame(), /Pause was not confirmed/)
    emit({ ...states.get(alpha.id)!, cacheError: "Diagram cache write failed; preference is not saved" })
    await flush()
    assert.match(rendered.captureCharFrame(), /Pause was not confirmed/)
    assert.match(rendered.captureCharFrame(), /cache write\s+failed/)
    emit({ ...states.get(alpha.id)!, cacheError: null })
    await run("open-diagram", "on")

    heldControl = { ...deferred<DiagramState>(), afterApply: false }
    const capacityFailure = commands.get("open-diagram")!.run("on")
    await settle()
    heldControl.reject({ type: "capacity", data: { mode: "on", cacheError: "cache write failed" } })
    heldControl = undefined
    await capacityFailure
    await flush()
    assert.match(rendered.captureCharFrame(), /capacity reached/)
    assert.match(rendered.captureCharFrame(), /preference is\s+not saved/)
    assert.doesNotMatch(rendered.captureCharFrame(), /server unavailable/)
    await run("open-diagram", "on")

    for (const mode of ["on", "off"] as const) {
      await run("open-diagram", mode)
      held = deferred<DiagramState>()
      const action = commands.get("open-diagram-panel-pause")!.run()
      await settle()
      const concurrent = { ...states.get(alpha.id)!, revision: states.get(alpha.id)!.revision + 1,
        mode: mode === "on" ? "off" as const : "on" as const }
      emit(concurrent)
      held.resolve(concurrent)
      held = undefined
      await action
      await flush()
      assert.equal(states.get(alpha.id)?.mode, mode === "on" ? "off" : "on", "warm preflight cannot invert displayed action")
    }

    await run("open-diagram", "off")
    const coldPaused = states.get(alpha.id)!
    batch(() => { setSelected(beta.id); setPanel(undefined) })
    await flush()
    held = deferred<DiagramState>()
    batch(() => { setSelected(alpha.id); setPanel(undefined) })
    reconnect()
    const coldResume = commands.get("open-diagram-panel-pause")!.run()
    heldControl = { ...deferred<DiagramState>(), afterApply: true }
    held.resolve(coldPaused)
    held = undefined
    await flush()
    assert.notEqual(states.get(alpha.id)?.mode, "off")
    const coldThenPause = commands.get("open-diagram-panel-pause")!.run()
    heldControl.resolve(states.get(alpha.id)!)
    heldControl = undefined
    await Promise.all([coldResume, coldThenPause])
    await flush()
    assert.equal(states.get(alpha.id)?.mode, "off", "cold resolved Resume cannot swallow subsequent Pause")
    await run("open-diagram", "panel")

    for (const timeout of [false, true]) {
      await run("open-diagram", "on")
      held = deferred<DiagramState>()
      const preflight = commands.get("open-diagram-panel-pause")!.run()
      await settle()
      await clickTab("Granular")
      if (timeout) await new Promise((resolve) => setTimeout(resolve, DIAGRAM_TIMEOUT_MS + 30))
      else held.reject(new Error("preflight unavailable"))
      held = undefined
      await preflight
      await flush()
      assert.equal(states.get(alpha.id)?.mode, "on")
      assert.match(rendered.captureCharFrame(), /Pause was not confirmed/)
      await run("open-diagram")
      assert.match(rendered.captureCharFrame(), /Pause was not confirmed/, "poll cannot erase failed preflight action")
      await run("open-diagram", "off")
      assert.doesNotMatch(rendered.captureCharFrame(), /Pause was not confirmed/)
    }

    for (const navigate of [false, true]) {
      await run("open-diagram", "on")
      await run("open-diagram", "overview")
      const before = states.get(alpha.id)!
      const count = controls.length
      held = deferred<DiagramState>()
      const pausing = commands.get("open-diagram-panel-pause")!.run()
      await settle()
      await clickTab("Granular")
      assert.equal(held.signal?.aborted, false, "depth waits without cancelling pending Pause read")
      assert.equal(controls.length, count)
      if (navigate) {
        batch(() => { setSelected(beta.id); setPanel(undefined) })
        await flush()
        assert.equal(held.signal?.aborted, true, "navigation still cancels waiting actions")
      }
      held.resolve(before)
      held = undefined
      await pausing
      await flush()
      if (navigate) assert.equal(controls.length, count, "queued depth cannot move to another session")
      else {
        assert.equal(controls[count].mode, "off")
        assert.equal(controls[count + 1].granularity, "granular")
        assert.equal(states.get(alpha.id)?.mode, "off", "depth selection preserves Pause")
      }
      batch(() => { setSelected(alpha.id); setPanel(undefined) })
      await flush()
      await run("open-diagram", "panel")
    }

    await run("open-diagram", "on")
    const beforeColdPause = states.get(alpha.id)!
    batch(() => { setSelected(beta.id); setPanel(undefined) })
    await flush()
    held = deferred<DiagramState>()
    batch(() => { setSelected(alpha.id); setPanel(undefined) })
    reconnect()
    await settle()
    const hydrationSignal = held.signal!
    await run("open-diagram", "pause")
    assert.equal(controls.at(-1)!.mode, "off", "explicit cold pause need not await hydration")
    assert.equal(hydrationSignal.aborted, true)
    held.resolve(beforeColdPause)
    held = undefined
    await run("open-diagram", "resume")
    assert.equal(controls.at(-1)!.mode, "on", "placeholder mode cannot overwrite previously acknowledged forced tracking")
    await run("open-diagram", "auto")
    await run("open-diagram", "off")

    held = deferred<DiagramState>()
    reconnect()
    const waiting = commands.get("open-diagram")!.run()
    await settle()
    assert.ok(held.signal)
    batch(() => { setSelected(beta.id); setPanel(undefined) })
    await flush()
    assert.equal(held.signal.aborted, true)
    await waiting
    held.resolve(nativeReady(alpha.id, 999, { ...graph, title: "OBSOLETE ALPHA RESPONSE" }))
    held = undefined
    await flush()
    await run("open-diagram", "panel")
    assert.match(rendered.captureCharFrame(), /Beta pipeline/)
    assert.doesNotMatch(rendered.captureCharFrame(), /OBSOLETE ALPHA|Features v2/)

    for (const action of ["resume", "toggle"]) {
      for (const navigate of [false, true]) {
        const paused: DiagramState = { ...states.get(alpha.id)!, mode: "off", phase: "paused" }
        emit(paused)
        held = deferred<DiagramState>()
        batch(() => { setSelected(alpha.id); setPanel(undefined) })
        reconnect()
        const count = controls.length
        const resuming = action === "resume"
          ? commands.get("open-diagram")!.run("resume")
          : commands.get("open-diagram-panel-pause")!.run()
        await settle()
        assert.equal(controls.length, count, "mode-dependent action waits for the cold snapshot")
        assert.ok(held.signal)
        if (navigate) {
          batch(() => { setSelected(beta.id); setPanel(undefined) })
          await flush()
          assert.equal(held.signal.aborted, true)
        }
        held.resolve(paused)
        held = undefined
        await resuming
        await flush()
        if (navigate) assert.equal(controls.length, count, "navigation cannot redirect a waiting resume")
        else {
          assert.equal(controls.at(-1)!.sessionID, alpha.id)
          assert.equal(controls.at(-1)!.mode, "auto", "cached paused snapshot resumes after reconciliation")
        }
        batch(() => { setSelected(beta.id); setPanel(undefined) })
        await flush()
      }
    }

    await run("open-diagram", "panel")
    const large = { ...otherGraph, nodes: Array.from({ length: 24 }, (_, index) => ({
      ...graph.nodes[0], id: `n${index}`, label: `Visible node ${index + 1}`,
    })) }
    emit(nativeReady(beta.id, 2, { ...large, nodes: large.nodes.map((node) => ({ ...node, label: "Obsolete layout" })) }))
    await settle() // Start a real worker job, then supersede it before completion.
    const staleFrames: string[] = []
    const observeLayout = () => { if (rendered.captureCharFrame().includes("Obsolete layout")) staleFrames.push(rendered.captureCharFrame()) }
    rendered.renderer.on("frame", observeLayout)
    emit(nativeReady(beta.id, 2, large))
    await flush()
    rendered.renderer.off("frame", observeLayout)
    assert.deepEqual(staleFrames, [], "late layout cannot replace the newest requested graph")
    assert.match(rendered.captureCharFrame(), /Visible node 1\b/)
    assert.doesNotMatch(rendered.captureCharFrame(), /Visible node 24/)
    for (let tick = 0; tick < 160; tick++) await rendered.mockMouse.scroll(4, 25, "down")
    await flush()
    assert.match(rendered.captureCharFrame(), /Visible node 24/, "the final node is reachable by scrolling")
    for (let index = 0; index < 24; index++) {
      await run("j")
      assert.match(rendered.captureCharFrame(), new RegExp(`Visible node ${index + 1}\\b`), "keyboard selection enters viewport")
    }
    for (let index = 22; index >= 0; index--) {
      await run("k")
      assert.match(rendered.captureCharFrame(), new RegExp(`Visible node ${index + 1}\\b`), "reverse keyboard selection enters viewport")
    }
    const unsorted = { ...otherGraph, nodes: [
      { ...graph.nodes[1], detail: "Second selected", behavior: undefined },
      { ...graph.nodes[0], detail: "First selected" },
    ], edges: [{ from: "a", to: "b", label: "next" }] }
    emit(nativeReady(beta.id, 3, unsorted))
    await flush()
    await run("j")
    assert.match(rendered.captureCharFrame(), /First selected/)
    await run("j")
    assert.match(rendered.captureCharFrame(), /Second selected/)
    await run("k")
    assert.match(rendered.captureCharFrame(), /First selected/)
    const dense = { ...unsorted, nodes: [
      { ...graph.nodes[0], id: "aa", label: "𠮷".repeat(10) }, { ...graph.nodes[1], id: "bb" }, { ...graph.nodes[2], id: "cc" },
    ], edges: [{ from: "aa", to: "bb", label: "next" }, { from: "bb", to: "cc", label: "next" },
      ...Array.from({ length: 40 }, (_, index) => ({ from: "cc", to: "aa", label: `route ${index}` }))] }
    emit(nativeReady(beta.id, 4, dense))
    await flush()
    const firstRow = rendered.captureCharFrame().split("\n").find(line => line.includes("𠮷"))!
    assert.ok(firstRow && firstRow.indexOf("𠮷") <= 4, "overflowing diagrams open with first block against the left viewport edge")
    const denseLayout = await layoutDiagram(dense, { columns: 80 })
    assert.ok(denseLayout.width > 80)
    assert.ok(denseLayout.nodes.every((box) => box.width <= 34), "dense ports do not stretch compact cards")
    await run("j")
    const selectedRow = rendered.captureCharFrame().split("\n").findIndex((line) => line.includes("𠮷"))
    assert.ok(selectedRow >= 0)
    assert.equal((rendered.captureCharFrame().match(/𠮷/gu) ?? []).length, 10, "native fixed-height rows preserve supplementary CJK")
    const beforePan = rendered.captureCharFrame()
    for (let tick = 0; tick < 60; tick++) await rendered.mockMouse.scroll(40, selectedRow, "right")
    await flush()
    const afterPan = rendered.captureCharFrame()
    assert.notEqual(afterPan, beforePan)
    assert.match(afterPan, /[┌┐└┘]/, "horizontal input reveals orthogonal return routing")
    await run("k")
    // Same-selection navigation changes scrolling after the frame, not Solid
    // state; observe the next painted frame rather than the pre-scroll buffer.
    const revealed = await rendered.waitForFrame((frame) => (frame.match(/𠮷/gu) ?? []).length === 10)
    assert.equal((revealed.match(/𠮷/gu) ?? []).length, 10, "keyboard reveals horizontally panned card even when selection stays at first node")
    assert.match(rendered.captureCharFrame(), /Raw inputs/)
    const restoredPan = rendered.captureCharFrame()
    for (let tick = 0; tick < 3; tick++) await rendered.mockMouse.scroll(4, 0, "down", { modifiers: { shift: true } })
    await flush()
    assert.notEqual(rendered.captureCharFrame(), restoredPan, "Shift-wheel over toolbar pans graph, not toolbar or vertical content")
    assert.equal(rendered.captureCharFrame().split("\n")[0], restoredPan.split("\n")[0])
    await run("k")
    await rendered.waitForFrame(frame => (frame.match(/𠮷/gu) ?? []).length === 10)
    rendered.resize(140, 50)
    setPanelWidth(140)
    await flush()
    assert.equal((rendered.captureCharFrame().match(/𠮷/gu) ?? []).length, 10, "resize keeps the selected card visible and clamps horizontal offset")
    const wideFrame = rendered.captureCharFrame()
    const wideRow = wideFrame.split("\n").findIndex((line) => line.includes("𠮷"))
    await rendered.mockMouse.click(wideFrame.split("\n")[wideRow].indexOf("𠮷") + 1, wideRow)
    await flush()
    assert.doesNotMatch(rendered.captureCharFrame(), /Raw inputs/, "resized cards remain interactive: clicking selection collapses details")
    const beforeNotations = { reads: readCount, controls: controls.length }
    setPanelWidth(200)
    rendered.resize(200, 85)
    for (const [family, fixture] of Object.entries(notationFixtures)) {
      emit(nativeReady(beta.id, 4, fixture))
      await flush()
      const frame = rendered.captureCharFrame()
      assert.match(frame, new RegExp(fixture.title), family)
      assert.doesNotMatch(frame, /layout unavailable|Arranging diagram/, family)
      for (const node of fixture.nodes) assert.ok(frame.includes(node.label), `${family}: ${node.label}`)
      if (family === "circuit") { assert.match(frame, /NC/); assert.match(frame, /unassigned/); assert.match(frame, /●/); assert.match(frame, /Controller board/); }
      if (family === "sequence") { assert.match(frame, /loop/); assert.match(frame, /poll/); }
      if (family === "timing") assert.match(frame, /not to scale/)
      await run("j")
      assert.match(rendered.captureCharFrame(), /\[Sources\]/)
    }
    assert.deepEqual({ reads: readCount, controls: controls.length }, beforeNotations, "notation navigation and resizing remain cache-only")
    rendered.resize(80, 50)
    setPanelWidth(80)
    emit(nativeReady(beta.id, 5, large))
    await flush()
    await clickTab("Granular")
    assert.equal(controls.at(-1)?.granularity, "granular")
    assert.equal(controls.at(-1)?.refresh, undefined)
    assert.equal(states.get(beta.id)?.granularity, "granular")
    const countBeforeSameDepth = controls.length
    await clickTab("Granular")
    assert.equal(controls.length, countBeforeSameDepth, "selected depth tab never regenerates")
    // Cold/reconnecting depth requests must compare against authoritative depth,
    // not the placeholder's Overview or an invalidated cached snapshot.
    for (const action of ["overview", "granular"] as const) {
      const saved = { ...states.get(alpha.id)!, granularity: "granular" as const }
      emit(saved)
      held = deferred<DiagramState>()
      batch(() => { setSelected(alpha.id); setPanel(undefined) })
      reconnect()
      const before = controls.length
      const choosing = commands.get("open-diagram")!.run(action)
      await settle()
      assert.equal(controls.length, before, "depth intent waits for current reconciliation")
      held.resolve(saved)
      held = undefined
      await choosing
      await flush()
      assert.equal(states.get(alpha.id)?.granularity, action)
      assert.equal(controls.length, before + (action === "overview" ? 1 : 0))
    }
    // A genuinely new session has the pending Overview placeholder.
    const freshID = "cold-depth"
    sessions.push({ ...sessions[1], id: freshID })
    const savedDepth = { ...nativeReady(freshID), granularity: "granular" as const }
    states.set(freshID, savedDepth)
    const oldGet = rpc.get
    const depthRead = deferred<DiagramState>()
    rpc.get = (input, options) => input.sessionID === freshID ? depthRead.promise : oldGet(input, options)
    batch(() => { setSelected(freshID); setPanel(undefined) })
    const coldChoice = commands.get("open-diagram")!.run("overview")
    await settle()
    depthRead.resolve(savedDepth)
    await coldChoice
    await flush()
    assert.equal(states.get(freshID)?.granularity, "overview", "cold Overview intent is not discarded")
    rpc.get = oldGet
    for (const pausing of [false, true]) {
      const id = pausing ? "depth-then-pause" : "opposite-depths"
      sessions.push({ ...sessions[1], id })
      const saved = { ...nativeReady(id), mode: "on" as const, granularity: pausing ? "overview" as const : "granular" as const }
      states.set(id, saved)
      const gate = deferred<DiagramState>()
      rpc.get = (input, options) => input.sessionID === id ? gate.promise : oldGet(input, options)
      batch(() => { setSelected(id); setPanel(undefined) })
      const before = controls.length
      const first = commands.get("open-diagram")!.run(pausing ? "granular" : "overview")
      const last = pausing ? commands.get("open-diagram-panel-pause")!.run() : commands.get("open-diagram")!.run("granular")
      await settle()
      gate.resolve(saved)
      await Promise.all([first, last])
      await flush()
      assert.equal(states.get(id)?.granularity, "granular")
      if (pausing) {
        assert.equal(states.get(id)?.mode, "off", "Pause arriving after depth during hydration cannot be overtaken")
        assert.equal(controls[before].mode, "off")
        assert.equal(controls[before + 1].granularity, "granular")
      } else assert.equal(controls.length, before, "latest shared-hydration depth intent wins without unnecessary control")
      rpc.get = oldGet
    }
    // A failed first read cannot discard depth while a newer recovery event has
    // already admitted a successor. Apply the intent only after that read.
    {
      const id = "failed-read-depth-successor"
      sessions.push({ ...sessions[1], id })
      const saved = nativeReady(id)
      states.set(id, saved)
      const firstRead = deferred<DiagramState>()
      const successorRead = deferred<DiagramState>()
      let reads = 0
      rpc.get = (input, options) => input.sessionID === id
        ? (++reads === 1 ? firstRead.promise : successorRead.promise) : oldGet(input, options)
      batch(() => { setSelected(id); setPanel(undefined) })
      const before = controls.length
      let finished = false
      const depth = Promise.resolve(commands.get("open-diagram")!.run("granular")).then(() => { finished = true })
      reconnect()
      await settle()
      firstRead.reject(new Error("superseded read failed"))
      await flush()
      assert.equal(reads, 2)
      assert.equal(finished, false)
      assert.equal(controls.length, before)
      successorRead.resolve(saved)
      await depth
      assert.equal(states.get(id)?.granularity, "granular")
      assert.equal(controls.length, before + 1)
      rpc.get = oldGet
    }
    // Combine a newer recovery boundary with concurrent depth/Pause. Pause may
    // cancel the successor GET; depth must follow Pause rather than lose intent.
    {
      const id = "reconnect-depth-pause"
      sessions.push({ ...sessions[1], id })
      const saved = { ...nativeReady(id), mode: "on" as const }
      states.set(id, saved)
      const firstRead = deferred<DiagramState>()
      const successorRead = deferred<DiagramState>()
      let reads = 0
      rpc.get = (input, options) => input.sessionID === id
        ? (++reads === 1 ? firstRead.promise : successorRead.promise) : oldGet(input, options)
      batch(() => { setSelected(id); setPanel(undefined) })
      const before = controls.length
      const depth = commands.get("open-diagram")!.run("granular")
      const pausing = commands.get("open-diagram-panel-pause")!.run()
      reconnect()
      await settle()
      firstRead.resolve(saved)
      await Promise.all([depth, pausing])
      await flush()
      assert.equal(states.get(id)?.mode, "off")
      assert.equal(states.get(id)?.granularity, "granular", "Pause cancellation of successor GET cannot discard depth intent")
      assert.equal(controls[before].mode, "off")
      assert.equal(controls[before + 1].granularity, "granular")
      successorRead.resolve(saved)
      rpc.get = oldGet
    }
    // Depth-before-Pause navigation must not let the abandoned action retry a
    // failed destination's cached read, even after Pause cancellation settles.
    {
      const destination = "failed-destination"
      const origin = "departing-depth-pause"
      for (const id of [destination, origin]) {
        sessions.push({ ...sessions[1], id })
        states.set(id, { ...nativeReady(id), mode: "on" })
      }
      let destinationReads = 0
      const originRead = deferred<DiagramState>()
      rpc.get = (input, options) => input.sessionID === destination
        ? (destinationReads++, Promise.reject(new Error("destination unavailable")))
        : input.sessionID === origin ? originRead.promise : oldGet(input, options)
      batch(() => { setSelected(destination); setPanel(undefined) })
      await flush()
      assert.equal(destinationReads, 1)
      batch(() => { setSelected(origin); setPanel(undefined) })
      heldControl = { ...deferred<DiagramState>(), afterApply: false }
      const before = controls.length
      const depth = commands.get("open-diagram")!.run("granular")
      const pausing = commands.get("open-diagram-panel-pause")!.run()
      await settle()
      originRead.resolve(states.get(origin)!)
      await flush()
      assert.equal(controls.length, before + 1, "Pause is held while depth waits")
      batch(() => { setSelected(destination); setPanel(undefined) })
      await Promise.all([depth, pausing])
      await flush()
      assert.equal(destinationReads, 1, "abandoned depth cannot retry destination GET")
      assert.equal(controls.length, before + 1, "abandoned depth cannot issue control")
      heldControl.resolve(states.get(origin)!)
      heldControl = undefined
      rpc.get = oldGet
    }
    // Explicit depth intent after a failed warm reconciliation cannot compare
    // against the stale matching Overview value.
    emit({ ...states.get(alpha.id)!, granularity: "overview" })
    batch(() => { setSelected(alpha.id); setPanel(undefined) })
    await flush()
    held = deferred<DiagramState>()
    reconnect()
    await settle()
    held.reject(new Error("lost reconciliation"))
    await settle()
    held = deferred<DiagramState>()
    const repairDepth = commands.get("open-diagram")!.run("overview")
    await settle()
    assert.ok(held.signal, "explicit depth retries unresolved snapshot authority")
    const serverDepth = { ...states.get(alpha.id)!, granularity: "granular" as const }
    states.set(alpha.id, serverDepth)
    held.resolve(serverDepth)
    held = undefined
    await repairDepth
    await flush()
    assert.equal(states.get(alpha.id)?.granularity, "overview")
    batch(() => { setSelected(beta.id); setPanel(undefined) })
    await flush()
    await run("open-diagram", "overview")
    assert.equal(controls.at(-1)?.granularity, "overview")
    await run("open-diagram-sidebar")
    assert.equal(preferences.sidebarVisible, false)
    assert.deepEqual(Object.keys(preferences).sort(), ["exportTheme", "sidebarVisible"], "storage holds UI preferences only")
    batch(() => { setSelected(alpha.id); setPanel(undefined) })
    await flush()
    await run("open-diagram", "off")
    held = deferred<DiagramState>()
    const hiddenResume = commands.get("open-diagram")!.run("resume")
    await settle()
    held.reject(new Error("hidden preflight failure"))
    held = undefined
    await hiddenResume
    await flush()
    assert.equal(panel(), undefined)
    assert.equal(replacement(), undefined)
    assert.match(toasts.at(-1)!, /Resume was not confirmed/)
    heldControl = { ...deferred<DiagramState>(), afterApply: false }
    const hiddenControl = commands.get("open-diagram")!.run("on")
    await settle()
    heldControl.reject(new Error("hidden control failure"))
    heldControl = undefined
    await hiddenControl
    assert.match(toasts.at(-1)!, /Resume was not confirmed/)
    writeFailure = true
    await run("open-diagram-sidebar")
    assert.match(toasts.at(-1)!, /Could not save diagram display preference/)
    await run("open-diagram", "nonsense")
    assert.match(toasts.at(-1)!, /Usage:/)
    writeFailure = false
    await run("open-diagram-sidebar")
    for (const unavailable of [false, true]) {
      const id = unavailable ? "empty-unavailable" : "empty-manual"
      sessions.push({ ...sessions[1], id })
      states.set(id, { ...initialState(id), epoch: "server", revision: 1,
        phase: unavailable ? "unavailable" : "watching", reason: unavailable ? "Model unavailable" : "Awaiting a diagram author" })
      batch(() => { setSelected(id); setPanel(undefined) })
      await flush()
      assert.match(rendered.captureCharFrame(), /Native sidebar contents/)
      await run("open-diagram")
      assert.match(rendered.captureCharFrame(), unavailable ? /Model unavailable/ : /Awaiting a diagram author/)
      assert.ok(replacement(), "explicit open selects Diagram even without an accepted graph")
      assert.equal(panel(), undefined)
    }
    batch(() => { setSelected(undefined); setPanel(undefined) })
    await flush()
    const readsBefore = readCount
    await run("open-diagram", "refresh")
    assert.match(toasts.at(-1)!, /Select a loaded session/)
    assert.equal(readCount, readsBefore)
    await cleanup()
    assert.equal(listeners.size, 0)
    assert.equal(hostListeners.size, 0)
    assert.equal(new Set(removed).size, slots.length, "all dynamic and fixed slots disposed")
  })
}
