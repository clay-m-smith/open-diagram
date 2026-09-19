import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { collectEvidence, mergeEvidence } from "../src/diagram/evidence.js"
import { evidenceKey } from "../src/diagram/cache.js"

function tool(id: string, name: string, input: unknown, text: string, at: number): SessionMessageInfo {
  return { type: "assistant", id, time: { created: at }, content: [{ type: "tool", id, name, time: { completed: at },
    state: { status: "completed", input, content: [{ type: "text", text }] } }] } as unknown as SessionMessageInfo
}
const read = (id: string, at: number) => tool(id, "read", { path: "/project/model.py", offset: 1 }, "class Model: width = 128", at)
const edit = (at: number) => tool("edit", "edit", { path: "/project/model.py", oldString: "128", newString: "256" }, "Success", at)

test("material identity includes semantic read/mutation precedence, not absolute timestamps", () => {
  const edited = mergeEvidence(collectEvidence([read("read", 1), edit(2)]), [])
  const restored = mergeEvidence(collectEvidence([read("read", 1), edit(2), read("reread", 3)]), [])
  assert.notEqual(evidenceKey(edited, "overview"), evidenceKey(restored, "overview"), "authoritative reread can supersede prior mutation")
  assert.equal(evidenceKey(restored, "overview"), evidenceKey(restored.map((item) => ({ ...item, at: item.at! + 1000 })), "overview"))
})

test("timestamp ties preserve winning read position relative to distinct mutation", () => {
  const items = mergeEvidence(collectEvidence([read("old", 1), edit(1), read("new", 1)]), [])
  const mutationIndex = items.findIndex((item) => item.mutation)
  const readIndex = items.findIndex((item) => item.label.startsWith("read"))
  assert.ok(mutationIndex >= 0 && readIndex > mutationIndex, "later reread follows older edit even with tied completion times")
})

test("newest tied reread survives material capacity and unknown-extension reads stay material", () => {
  const reads = Array.from({ length: 24 }, (_, i) => tool(`other${i}`, "read", { path: `/project/other${i}.py` }, `class Other${i}: pass`, 1))
  const items = collectEvidence([read("old", 0), ...reads, read("new", 1)])
  assert.ok(items.some((item) => item.text.includes("class Model: width = 128")))
  for (const path of ["/project/data.json", "/project/styles.css"]) {
    const mutation = tool("edit", "edit", { path, oldString: "128", newString: "256" }, "Success", 1)
    const before = collectEvidence([mutation, tool("read1", "read", { path }, "value = 256", 2)])
    const after = collectEvidence([mutation, tool("read2", "read", { path }, "value = 512", 3)])
    assert.notEqual(evidenceKey(before, "overview"), evidenceKey(after, "overview"))
  }
})
