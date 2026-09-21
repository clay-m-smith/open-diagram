import type { DiagramGraph } from "../../src/diagram/schema.js"

const nodes = (labels: string[]) => labels.map((label, i) => ({ id: `n${i}`, label, kind: "component", detail: "", status: "observed" as const, evidence: ["e1"] }))
const edges = (rows: [number, number, string][]) => rows.map(([from, to, label]) => ({ from: `n${from}`, to: `n${to}`, label }))

// The two reported shapes: skip/return routes around an expanded card, and a
// mostly linear encoder with a wrapper bypass and residual feedback.
export const runtimeRouting: DiagramGraph = {
  title: "Native diagram runtime boundary", summary: "",
  nodes: nodes(["OpenCode plugin context", "Registered diagram tools", "Snapshot operation", "Publish operation", "Native session adapter", "Public diagram schema", "Diagram state"]),
  edges: edges([[0, 1, "registers"], [1, 2, "invokes"], [1, 3, "invokes"], [1, 4, "uses session context"], [3, 5, "validates against"], [3, 6, "publishes to"], [6, 3, "publication result"]]),
}
runtimeRouting.nodes[6] = { ...runtimeRouting.nodes[6], kind: "storage", detail: "Accepted publication state returned by the publication method.", behavior: "Contains publication epoch, revision, views, and cache status." }

export const encoderRouting: DiagramGraph = {
  title: "Encoder routing regression", summary: "",
  nodes: nodes(["Raw IQ input", "Conv stage 1 · 64 / s4", "Conv stage 2 · 128 / s4", "Conv stage 3 · 256 / s4", "Conv stage 4 · 384 / s4", "CPI positional encoding", "Transformer pre-norm · RMSNorm", "Multi-head self-attention ×6", "Transformer pre-MLP · RMSNorm", "GEGLU MLP ×6", "Final RMSNorm", "Encoded token sequence"]),
  edges: edges([[0, 1, "raw IQ"], [1, 2, "feature map"], [2, 3, "feature map"], [3, 4, "feature map"], [4, 5, "stem tokens"], [5, 6, "position-aware tokens"], [5, 7, "pre-tokenized wrapper path"], [6, 7, "normalized tokens"], [7, 8, "attention residual"], [8, 9, "normalized residual"], [9, 6, "MLP residual to next block"], [9, 10, "final block output"], [10, 11, "encoded tokens"]]),
}
