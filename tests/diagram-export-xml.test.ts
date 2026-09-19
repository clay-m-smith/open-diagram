import assert from "node:assert/strict"
import test from "node:test"
import { GraphSchema } from "../src/diagram/schema.js"
import { renderDiagramPNG, renderDiagramSVG } from "../src/diagram/export.js"

test("schema-valid XML-forbidden characters become replacement glyphs in SVG and PNG", async () => {
  const graph = GraphSchema.parse({ title: "Model\uFFFF\uFFFE\uD800", summary: "", nodes: [
    { id: "a", label: "Input\uFFFF", kind: "input", status: "observed", detail: "Detail\uFFFE", evidence: ["s"] },
  ], edges: [{ from: "a", to: "a", label: "Loop\uDFFF" }] })
  const svg = renderDiagramSVG(graph, { selected: "a" })
  assert.doesNotMatch(svg, /[\uFFFE\uFFFF\uD800-\uDFFF]/u)
  assert.match(svg, /Model\uFFFD\uFFFD\uFFFD/)
  const png = await renderDiagramPNG(graph, { selected: "a" })
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(graph.title, "Model\uFFFF\uFFFE\uD800", "persisted graph remains unchanged")
})
