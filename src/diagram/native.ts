import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { Message } from "@opencode/ai"
import type { NativeGenerate } from "./client.js"
import { digest } from "./evidence.js"

const toolName = "open_diagram_result"

/** Stock V2 tool-capable session. One managed session per location, never the user's chat. */
export async function registerNativeAuthor(ctx: Plugin.Context) {
  const storageKey = `diagram/native-author/v1/${digest(JSON.stringify([ctx.location.directory, ctx.location.project.id, ctx.location.workspaceID ?? null]))}`
  const saved = await ctx.storage.get(storageKey)
  let sessionID = typeof saved === "string" ? saved : undefined
  let job: { input: Parameters<NativeGenerate>[0]; signal: AbortSignal; token: string; prompted: boolean; calls: number; value?: unknown; received: boolean; failed?: boolean; stop?: () => void } | undefined
  const owns = (id: string) => id === sessionID
  await ctx.tool.transform((editor) => {
    if (editor.get(toolName)) throw new Error("Diagram result tool name is already registered")
    editor.add({ name: toolName, description: "Submit the current diagram result. Available only inside the managed diagram author session.",
      input: { type: "object", additionalProperties: true }, options: { codemode: false, permission: toolName },
      async execute(value, tool) {
        if (!owns(tool.sessionID) || !job || job.received) throw new Error("No active diagram result request")
        job.signal.throwIfAborted()
        job.value = value; job.received = true
        job.stop?.()
        return { content: "Diagram result received. Stop." }
      },
    })
  })
  await ctx.session.hook("prompt", (event) => {
    if (!owns(event.sessionID)) return
    if (!job || job.prompted || event.metadata?.openDiagram !== job.token) throw new Error("Managed diagram session does not accept external prompts")
    job.signal.throwIfAborted()
    job.prompted = true
  })
  await ctx.session.hook("context", (event) => {
    if (!owns(event.sessionID)) { delete event.tools[toolName]; return }
    // Stop the agent loop before another paid step, including post-tool narration.
    if (!job || job.calls++ >= 1) throw new Error("Diagram author step completed")
    job.signal.throwIfAborted()
    const tool = event.tools[toolName]
    if (!tool) throw new Error("Diagram result tool unavailable")
    tool.input = job.input.outputSchema
    tool.description = job.input.toolDescription ?? "Submit the current diagram result. Available only inside the managed diagram author session."
    event.tools = { [toolName]: tool }
    event.system = [{ type: "text", text: `You are the diagram author. Submit your answer by calling ${toolName} exactly once with arguments matching its schema. Do not answer with prose, a code fence, or JSON text. No other tools are available.` }]
    // Evidence is request-local, not copied into the managed session's history.
    event.messages = [Message.user(job.input.prompt)]
  })
  await ctx.session.hook("title", (event) => { if (owns(event.sessionID)) event.result = "Diagram author (managed)" })
  await ctx.session.hook("compaction", (event) => { if (owns(event.sessionID)) event.result = { summary: "Managed diagram author; each request supplies independent evidence." } })
  await ctx.session.hook("retry", (event) => {
    if (!owns(event.sessionID)) return
    event.decision = { retry: false }
    if (job) job.failed = true
  })
  await ctx.tool.hook("execute.before", (event) => {
    if (owns(event.sessionID) && event.tool !== toolName) throw new Error("Diagram author may only submit a result")
  })
  const generate: NativeGenerate = async (input, { signal }) => {
    signal.throwIfAborted()
    if (job) throw new Error("Diagram author is already active")
    const active = { input, signal, token: randomUUID(), prompted: false, calls: 0, received: false, failed: false, value: undefined as unknown, stop: undefined as (() => void) | undefined }
    job = active
    let interrupted: Promise<void> | undefined
    let interruptError: unknown
    let admitted = false
    let owned = false
    const stop = () => {
      if (!owned) return
      // Attach rejection handling immediately, including interrupts from tool execution.
      interrupted ??= ctx.session.interrupt({ sessionID: sessionID!, resume: false })
        .then(() => {}, (error) => { interruptError = error })
    }
    active.stop = stop
    signal.addEventListener("abort", stop, { once: true })
    try {
      if (sessionID) {
        try {
          const session = await ctx.session.get({ sessionID }, { signal })
          if (session.location.directory !== ctx.location.directory || session.projectID !== ctx.location.project.id || session.metadata?.openDiagram !== true) throw new Error("Invalid managed diagram session")
          owned = true
        } catch (error) {
          // Recreate only a positively missing helper, never on transport/storage errors.
          // 2.0.7's in-process adapter preserves the host tag; HTTP uses the protocol tag.
          if (!error || typeof error !== "object" || !("_tag" in error)
            || !["Session.NotFoundError", "SessionNotFoundError"].includes(String(error._tag))) throw error
          sessionID = undefined
          await ctx.storage.remove(storageKey)
        }
      }
      if (!sessionID) {
        signal.throwIfAborted()
        // Remember ownership before create can emit hooks. Never change an existing agent.
        sessionID = `ses_${randomUUID().replaceAll("-", "")}`
        try {
          await ctx.session.create({ id: sessionID, agent: "general", title: "Diagram author (managed)", model: input.model,
            metadata: { openDiagram: true }, permissions: [
              { action: "*", resource: "*", effect: "deny" }, { action: toolName, resource: "*", effect: "allow" },
            ] })
        } catch (error) { sessionID = undefined; throw error }
        owned = true
        await ctx.storage.set(storageKey, sessionID)
      } else {
        // A service crash can leave prior inbox/execution state. Drain before reuse.
        stop()
        await interrupted
        await ctx.session.wait({ sessionID }, { signal })
        signal.throwIfAborted()
        await ctx.session.switchModel({ sessionID, model: input.model }, { signal })
        interrupted = undefined
      }
      if (signal.aborted) { stop(); signal.throwIfAborted() }
      admitted = true
      await ctx.session.prompt({ sessionID, text: "Submit the requested diagram.", metadata: { openDiagram: active.token } })
      // Explicit interrupt is required: the V2 Promise adapter ignores request signals.
      // An abort during admission may have interrupted an idle session; drain that
      // interrupt, then interrupt the newly admitted run as well.
      if (signal.aborted) { await interrupted; interrupted = undefined; stop() }
      await ctx.session.wait({ sessionID }, { signal })
      signal.throwIfAborted()
      if (active.failed || !active.calls) throw new Error("Diagram author request failed")
      return { text: active.received ? JSON.stringify(active.value) : "" }
    } finally {
      signal.removeEventListener("abort", stop)
      try {
        if (owned) stop()
        await interrupted
        if (admitted) await ctx.session.wait({ sessionID: sessionID! })
        if (interruptError) throw interruptError
      } finally { job = undefined }
    }
  }
  return { generate, owns }
}
