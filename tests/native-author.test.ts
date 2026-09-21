import assert from "node:assert/strict"
import test from "node:test"
import type { Plugin } from "@opencode/plugin"
import { registerNativeAuthor } from "../src/diagram/native.js"
import { Effect } from "effect"

test("native cancellation during prompt admission drains the newly admitted run before reuse", async () => {
  const hooks = new Map<string, (event: any) => void>()
  const saved = new Map<string, any>()
  let start!: () => void, admit!: () => void
  const started = new Promise<void>((resolve) => { start = resolve })
  const admission = new Promise<void>((resolve) => { admit = resolve })
  let interrupted = 0, running = false, waitCalls = 0, session: any
  const ctx = {
    location: { directory: "/fixture", project: { id: "project" } },
    storage: { get: async (key: string) => saved.get(key), set: async (key: string, value: any) => { saved.set(key, value) } },
    tool: { transform: async () => {}, hook: async () => {} },
    session: {
      hook: async (name: string, hook: (event: any) => void) => { hooks.set(name, hook) },
      create: async (input: any) => { session = { ...input, projectID: "project", location: { directory: "/fixture" } }; return session },
      get: async () => session, switchModel: async () => {},
      prompt: async (input: any) => {
        hooks.get("prompt")!({ ...input, sessionID: input.sessionID })
        start()
        await admission
        running = true
      },
      interrupt: async () => { interrupted++; running = false },
      wait: async () => { waitCalls++; assert.equal(running, false, "newly admitted provider must be interrupted before waiting") },
    },
  } as unknown as Plugin.Context
  const native = await registerNativeAuthor(ctx)
  const abort = new AbortController()
  const input = { model: { providerID: "fixture", id: "diagram" }, prompt: "source", outputSchema: { type: "object" } }
  const generation = native.generate(input, { signal: abort.signal })
  const rejected = assert.rejects(generation, /abort/i)
  await started
  await assert.rejects(native.generate(input, { signal: new AbortController().signal }), /already active/)
  abort.abort()
  assert.equal(interrupted, 1, "abort may initially interrupt an idle session")
  admit()
  await rejected
  assert.equal(interrupted, 2)
  assert.ok(waitCalls >= 1)
  assert.equal(running, false)
})

test("native deadline interrupts a stalled helper lookup before any prompt is admitted", async () => {
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  let finalized = false
  const ctx = {
    location: { directory: "/fixture", project: { id: "project" } },
    storage: { get: async () => "ses_existing" },
    tool: { transform: async () => {}, hook: async () => {} },
    session: {
      hook: async () => {},
      get: async (_input: unknown, options?: { signal?: AbortSignal }) => {
        began()
        return Effect.runPromise(Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { finalized = true }))), { signal: options?.signal })
      },
      prompt: async () => assert.fail("cancelled lookup must not admit a prompt"),
      interrupt: async () => assert.fail("unverified session ownership must not be interrupted"),
    },
  } as unknown as Plugin.Context
  const native = await registerNativeAuthor(ctx)
  const abort = new AbortController()
  const generation = native.generate({ model: { providerID: "fixture", id: "diagram" }, prompt: "source", outputSchema: { type: "object" } }, { signal: abort.signal })
  await started
  const rejected = assert.rejects(generation)
  abort.abort()
  await rejected
  assert.equal(finalized, true, "lookup finalizer must finish before releasing the generation slot")
})
