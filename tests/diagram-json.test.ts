import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { collectEvidence, mergeEvidence } from "../src/diagram/evidence.js"

test("public evidence remains JSON-valued when optional dependency metadata is absent", () => {
  const messages = [{ type: "user", id: "user", time: { created: 1 }, text: "Inspect architecture" },
    { type: "assistant", id: "assistant", time: { created: 2 }, content: [{ type: "text", text: "Observed source" },
      { type: "tool", id: "read", name: "read", state: { status: "completed", input: { path: "/project/model.py" },
        content: [{ type: "text", text: "class Encoder: width = 128" }] } }] },
  ] as unknown as SessionMessageInfo[]
  const evidence = mergeEvidence(collectEvidence(messages), [])
  assert.deepEqual(evidence, JSON.parse(JSON.stringify(evidence)), "OpenCode RPC output requires JSON values, not present undefined properties")
})
