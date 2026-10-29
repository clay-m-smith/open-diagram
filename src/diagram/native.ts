import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { DiagramServiceError, type NativeGenerate } from "./client.js"
import { digest } from "./evidence.js"
import { AUTHOR_DRAFT_TOOLS, createAuthorDraft } from "./author-draft.js"
import { z } from "zod"

const toolName = "open_diagram_result"
const commitName = "open_diagram_draft_commit"
const primitiveNames = new Set([...Object.keys(AUTHOR_DRAFT_TOOLS).map((name) => `open_diagram_draft_${name}`), commitName])
export const NATIVE_AUTHOR_STEPS = 8
const CommitOutputSchema = z.object({ ok: z.boolean(), committed: z.boolean().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() }).strict()

/** Stock V2 tool-capable session. One managed session per location, never the user's chat. */
export async function registerNativeAuthor(ctx: Plugin.Context) {
  const storageKey = `diagram/native-author/v1/${digest(JSON.stringify([ctx.location.directory, ctx.location.project.id, ctx.location.workspaceID ?? null]))}`
  const saved = await ctx.storage.get(storageKey)
  let sessionID = typeof saved === "string" ? saved : undefined
  let job: { input: Parameters<NativeGenerate>[0]; signal: AbortSignal; token: string; admission: string; prompted: boolean; calls: number; limit: number; value?: unknown; received: boolean; failed?: boolean; draft?: ReturnType<typeof createAuthorDraft>; stop?: () => Promise<void> | undefined } | undefined
  const owns = (id: string) => id === sessionID
  await ctx.tool.transform((editor) => {
    if (editor.get(toolName)) throw new Error("Diagram result tool name is already registered")
    editor.add({ name: toolName, description: "Submit the current diagram result. Available only inside the managed diagram author session.",
      input: { type: "object", additionalProperties: true }, options: { codemode: false, permission: toolName },
      async execute(value, tool) {
        if (!owns(tool.sessionID) || !job || job.received) throw new Error("No active diagram result request")
        job.signal.throwIfAborted()
        job.value = value; job.received = true
        return { content: "Diagram result received. Stop." }
      },
    })
    for (const [operation, definition] of Object.entries(AUTHOR_DRAFT_TOOLS)) {
      const name = `open_diagram_draft_${operation}`
      if (editor.get(name)) throw new Error("Diagram draft tool name is already registered")
      editor.add({ name, description: definition.description, input: definition.input, output: definition.output,
        options: { codemode: true, pinned: operation !== "notation" && operation !== "remove", permission: name },
        async execute(value, tool) {
          if (!owns(tool.sessionID) || !job?.draft || job.received) throw new Error("No active diagram draft")
          job.signal.throwIfAborted()
          tool.signal.throwIfAborted()
          const result = job.draft.execute(operation, value)
          return { output: result, content: JSON.stringify(result) }
        },
      })
    }
    if (editor.get(commitName)) throw new Error("Diagram draft commit tool name is already registered")
    editor.add({ name: commitName, description: "Validate and commit the private diagram draft. On validation failure returns issues and leaves the draft editable. On success stop: edits and further commits are rejected.",
      input: { type: "object", properties: {}, additionalProperties: false },
      output: CommitOutputSchema,
      options: { codemode: true, pinned: true, permission: commitName },
      async execute(_value, tool) {
        if (!owns(tool.sessionID) || !job?.draft || job.received) throw new Error("No active diagram draft")
        job.signal.throwIfAborted()
        tool.signal.throwIfAborted()
        const result = job.draft.validate()
        if (!result.ok) return { output: result, content: JSON.stringify(result) }
        job.value = result.value
        job.received = true
        return { output: { ok: true, committed: true }, content: JSON.stringify({ ok: true, committed: true }) }
      },
    })
  })
  await ctx.session.hook("prompt", (event) => {
    if (!owns(event.sessionID)) return
    if (!job || job.prompted || event.metadata?.openDiagram !== job.admission) throw new Error("Managed diagram session does not accept external prompts")
    job.signal.throwIfAborted()
    job.prompted = true
  })
  await ctx.session.hook("context", async (event) => {
    if (!owns(event.sessionID)) {
      delete event.tools[toolName]
      for (const name of primitiveNames) delete event.tools[name]
      return
    }
    if (!job) throw new Error("No active diagram result request")
    // The previous step has persisted its tool results. Interrupt here, not
    // inside execute (which marks a received result as a failed tool). Await
    // interruption before dispatch so no post-tool narration call can escape.
    if (job.received || job.calls >= (job.draft ? job.limit : 1)) {
      await job.stop?.()
      // Fail closed if the host did not interrupt this hook, including an
      // interrupt error. Never turn a shutdown failure into another paid call.
      throw new Error("Diagram author step completed")
    }
    job.signal.throwIfAborted()
    job.calls++
    if (job.draft) {
      // V2 captures the permission-filtered Code Mode catalog BEFORE context
      // hooks. Preserve its host instructions and executor, not raw tool names.
      const execute = event.tools.execute
      if (!execute) throw new Error("Native Code Mode unavailable for diagram author")
      event.tools = { execute }
      event.system.push({ type: "text", text: "You are the managed diagram author. Use only the private draft tools through native Code Mode. Follow the request's grounding policy. Validate and commit once; do not return a whole diagram as prose. No external tools or network access are authorized." })
      event.system.push({ type: "text", text: `Diagram author step ${job.calls} of ${job.limit}. ${job.limit - job.calls} further model steps remain after this response. The original request deadline still applies. The evidence packet already includes baseline views; inspect only when you need additional draft state. Compose known metadata, node, edge and notation edits in a single execute call and attempt open_diagram_draft_commit in that call when ready. Set a short reason before commit. Tools return objects: check result.ok, not object truthiness; do not JSON.parse tool results. After an edit, use if (!result.ok) return result; then continue edits and commit. Only commit returning {ok:true,committed:true} finishes this request. Use open_diagram_draft_schema for just the notation family/field you need, not a broad schema dump. ${job.calls === job.limit ? "FINAL STEP: make the remaining bounded edits and attempt commit now. Do not spend this step only discovering tools, inspecting, or validating without commit." : "Reserve time to fix validation issues and commit; successful edits alone do not publish."}` })
      // Hooks change outgoing context only. Locate this request's unique inbox
      // marker and retain only its tool turns; old managed jobs never leak in.
      const marker = job.token
      const start = event.messages.findLastIndex((message) => message.role === "user" && JSON.stringify(message.content).includes(marker))
      const turns = start < 0 ? [] : event.messages.slice(start + 1)
      if (job.calls > 1 && start < 0) throw new Error("Diagram request context boundary unavailable")
      event.messages = [{ role: "user", content: [{ type: "text", text: job.input.authoring!.prompt }] }, ...turns]
      return
    }
    const tool = event.tools[toolName]
    if (!tool) throw new Error("Diagram result tool unavailable")
    tool.input = job.input.outputSchema
    tool.description = job.input.toolDescription ?? "Submit the current diagram result. Available only inside the managed diagram author session."
    event.tools = { [toolName]: tool }
    event.system = [{ type: "text", text: `You are the diagram author. Submit your answer by calling ${toolName} exactly once with arguments matching its schema. Do not answer with prose, a code fence, or JSON text. No other tools are available.` }]
    // Evidence is request-local, not copied into the managed session's history.
    // The native hook accepts structural messages. Avoid loading a second AI
    // runtime (and its private Effect transport modules) just to build one.
    event.messages = [{ role: "user", content: [{ type: "text", text: job.input.prompt }] }]
  })
  await ctx.session.hook("title", (event) => { if (owns(event.sessionID)) event.result = "Diagram author (managed)" })
  await ctx.session.hook("compaction", (event) => { if (owns(event.sessionID)) event.result = { summary: "Managed diagram author; each request supplies independent evidence." } })
  await ctx.session.hook("retry", (event) => {
    if (!owns(event.sessionID)) return
    event.decision = { retry: false }
    if (job) job.failed = true
  })
  await ctx.tool.hook("execute.before", (event) => {
    if (!owns(event.sessionID)) return
    if (!job || (job.draft ? !primitiveNames.has(event.tool) && event.tool !== "execute" : event.tool !== toolName)) {
      throw new Error("Diagram author may only use its private draft tools")
    }
  })
  const generate: NativeGenerate = async (input, { signal }) => {
    signal.throwIfAborted()
    if (job) throw new Error("Diagram author is already active")
    const limit = input.authoring?.maxSteps ?? NATIVE_AUTHOR_STEPS
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new DiagramServiceError("Invalid diagram author step budget")
    const active = { input, signal, token: randomUUID(), admission: "", prompted: false, calls: 0, received: false, failed: false, value: undefined as unknown,
      limit,
      draft: input.authoring ? createAuthorDraft(input.authoring) : undefined,
      stop: undefined as (() => Promise<void> | undefined) | undefined }
    job = active
    let interrupted: Promise<void> | undefined
    let interruptError: unknown
    let admitted = false
    let owned = false
    const stop = () => {
      if (!owned) return
      // Attach rejection handling immediately, including the continuation guard.
      return interrupted ??= ctx.session.interrupt({ sessionID: sessionID!, resume: false })
        .then(() => {}, (error) => { interruptError = error })
    }
    active.stop = stop
    const permissions = [
      { action: "*", resource: "*", effect: "deny" as const },
      ...[...(active.draft ? ["execute", ...primitiveNames] : [toolName])].map((action) => ({ action, resource: "*", effect: "allow" as const })),
    ]
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
            metadata: { openDiagram: true }, permissions }, { signal })
        } catch (error) { sessionID = undefined; throw error }
        owned = true
        await ctx.storage.set(storageKey, sessionID)
      } else {
        // A service crash can leave prior inbox/execution state. Drain before reuse.
        stop()
        await interrupted
        await ctx.session.wait({ sessionID }, { signal })
        signal.throwIfAborted()
        await ctx.session.update({ sessionID, permissions }, { signal })
        await ctx.session.switchModel({ sessionID, model: input.model }, { signal })
        interrupted = undefined
      }
      if (signal.aborted) { stop(); signal.throwIfAborted() }
      let text = `Prepare the requested diagram. Request ID: ${active.token}`
      for (;;) {
        // A normal prose stop is not a commit. A bounded corrective admission
        // keeps the same draft, context boundary, step count and original signal.
        const before = active.calls
        active.admission = randomUUID()
        active.prompted = false
        admitted = true
        await ctx.session.prompt({ sessionID, text, metadata: { openDiagram: active.admission } }, { signal })
        signal.throwIfAborted()
        await ctx.session.wait({ sessionID }, { signal })
        signal.throwIfAborted()
        if (active.failed || active.calls === before) throw new Error("Diagram author request failed")
        if (!active.draft || active.received || active.calls >= active.limit) break
        // Only recover a normal stop. A direct user interruption of the managed
        // session need not abort the parent signal; never resume it implicitly.
        const history = await ctx.session.context({ sessionID }, { signal })
        const admission = history.findLastIndex(message => message.type === "user" && message.metadata?.openDiagram === active.admission)
        const ended = admission < 0 ? undefined : history.slice(admission + 1).findLast(message => message.type === "idle")
        if (ended?.type !== "idle" || ended.outcome !== "succeeded") {
          throw new DiagramServiceError("Diagram author stopped before commit; no automatic resume")
        }
        const validation = active.draft.validate()
        const feedback = validation.ok ? "The draft is valid. Call open_diagram_draft_commit now."
          : `Fix these draft issues, then call open_diagram_draft_commit: ${JSON.stringify(validation.issues.slice(0, 4))}`
        // No evidence or model-authored prose is persisted in this correction.
        text = `No successful diagram commit was received. Your previous final answer did not publish anything. ${feedback} ${active.limit - active.calls} model steps remain within the original deadline. Do not end with prose before the commit tool confirms committed:true.`
      }
      if (active.draft && !active.received) {
        const validation = active.draft.validate()
        const detail = validation.ok ? "valid draft was not committed" : validation.issues[0]?.message ?? "draft incomplete"
        throw new DiagramServiceError(`Diagram update stopped without commit after ${active.calls}/${active.limit} steps: ${detail}; last accepted diagram retained`)
      }
      return { text: active.received ? JSON.stringify(active.value) : "" }
    } finally {
      signal.removeEventListener("abort", stop)
      try {
        if (owned) stop()
        await interrupted
        // Admission can commit concurrently with cancellation, even when its
        // Effect rejects. The first interrupt may have hit an idle session.
        // Re-interrupt after admission finalizers drain, before releasing job.
        if (admitted && signal.aborted) { interrupted = undefined; stop(); await interrupted }
        if (admitted) await ctx.session.wait({ sessionID: sessionID! })
        if (interruptError) throw interruptError
      } finally { job = undefined }
    }
  }
  return { generate, owns }
}
