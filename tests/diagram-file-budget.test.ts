import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { collectEvidence, mergeEvidence } from "../src/diagram/evidence.js"
import { evidenceKey } from "../src/diagram/cache.js"

test("established unknown-extension files keep stable material budgets and tied chronology", () => {
  const records: unknown[] = []
  for (let i = 0; i < 10; i++) {
    records.push({ type: "assistant", id: `read${i}`, time: { created: i }, content: [{ type: "tool", id: `read${i}`, name: "read", time: { completed: i },
      state: { status: "completed", input: { path: `/project/data${i}.json` }, content: [{ type: "text", text: `{ "value": "${"x".repeat(3000)}" }` }] } }] })
    records.push({ type: "assistant", id: `edit${i}`, time: { created: i }, content: [{ type: "tool", id: `edit${i}`, name: "edit", time: { completed: i },
      state: { status: "completed", input: { path: `/project/data${i}.json`, oldString: "x", newString: "y" }, content: [{ type: "text", text: "Success" }] } }] })
  }
  const select = (items: unknown[]) => mergeEvidence(collectEvidence(items as SessionMessageInfo[]), [])
  const before = select(records)
  const after = select([...records, { type: "user", id: "chat", time: { created: 20 }, text: "Thanks ".repeat(900) }])
  assert.equal(evidenceKey(before, "overview"), evidenceKey(after, "overview"))
  const paired = select(records.slice(0, 2))
  assert.equal(paired[0].label.startsWith("read"), true)
  assert.equal(paired[1].mutation, true)
})
