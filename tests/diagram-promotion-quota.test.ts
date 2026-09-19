import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { collectEvidence, mergeEvidence } from "../src/diagram/evidence.js"
import { evidenceKey } from "../src/diagram/cache.js"

test("material promotion survives dropping establishing mutation at record quota", () => {
  const messages: any[] = [{ type: "user", id: "request", text: "Diagram configuration", time: { created: 0 } },
    { type: "assistant", id: "edit", time: { created: 1 }, content: [{ type: "tool", id: "edit", name: "edit", state: {
      status: "completed", input: { path: "/project/data.json", oldString: "old", newString: "new" }, content: [{ type: "text", text: "Success" }] } }] }]
  for (let i = 0; i < 24; i++) messages.push({ type: "assistant", id: `read${i}`, time: { created: i + 2 }, content: [{ type: "tool", id: `read${i}`, name: "read", state: {
    status: "completed", input: { path: "/project/data.json", offset: i * 10 + 1 }, content: [{ type: "text", text: `{ "value": ${i} }` }] } }] })
  const select = () => mergeEvidence(collectEvidence(messages as SessionMessageInfo[]), [])
  const before = select()
  assert.equal(before.some((item) => item.mutation), false)
  assert.ok(before.filter((item) => item.label.startsWith("read")).every((item) => item.category === "source"))
  const later = structuredClone(messages.at(-1)); later.id = "latest"; later.time.created = 100
  later.content[0].id = "latest"; later.content[0].state.content[0].text = '{ "value": 256 }'; messages.push(later)
  assert.notEqual(evidenceKey(before, "overview"), evidenceKey(select(), "overview"))
})

test("chat cannot age established unknown-extension reads out of material retention", () => {
  const messages: any[] = [{ type: "assistant", id: "edit", time: { created: 1 }, content: [{ type: "tool", id: "edit", name: "edit", state: {
    status: "completed", input: { path: "/project/data.json", oldString: "old", newString: "new" }, content: [{ type: "text", text: "Success" }] } }] },
    { type: "assistant", id: "read", time: { created: 2 }, content: [{ type: "tool", id: "read", name: "read", state: {
      status: "completed", input: { path: "/project/data.json" }, content: [{ type: "text", text: '{ "value": "new" }' }] } }] }]
  const before = mergeEvidence(collectEvidence(messages), [])
  for (let i = 0; i < 130; i++) messages.push({ type: "user", id: `chat${i}`, time: { created: 10 + i }, text: "Continue checking" })
  assert.equal(evidenceKey(mergeEvidence(collectEvidence(messages), []), "overview"), evidenceKey(before, "overview"))
})
