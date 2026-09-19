import assert from "node:assert/strict"
import test from "node:test"
import { authorRequest } from "../src/diagram/author.js"

test("short model citations map exactly back to stable source IDs, never fuzzily", () => {
  const evidence = [{ id: "e_long_original_123", label: "source", text: "Gateway -> Worker" }]
  const { request, parse } = authorRequest(evidence, null, false)
  assert.equal(request.input.evidence[0].id, "e1")
  const value = { relevant: true, reason: "Flow", views: [{ id: "flow", label: "Flow", graph: { title: "Flow", summary: "",
    nodes: [{ id: "worker", label: "Worker", kind: "service", detail: "", status: "observed", evidence: ["e1"] }], edges: [],
  } }] }
  const result = parse(JSON.stringify(value))
  assert.deepEqual(result.graph?.nodes[0].evidence, [evidence[0].id])
  assert.deepEqual(result.views?.[0].graph.nodes[0].evidence, [evidence[0].id])
  value.views[0].graph.nodes[0].evidence = ["e_long_original_123"]
  assert.throws(() => parse(JSON.stringify(value)), /outside current snapshot/)
  value.views[0].graph.nodes[0].evidence = ["e2"]
  assert.throws(() => parse(JSON.stringify(value)), /outside current snapshot/)
  assert.equal(evidence[0].id, "e_long_original_123")
})
