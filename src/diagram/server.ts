import { Plugin } from "@opencode/plugin"
import { ConfigSchema, type DiagramConfig } from "./config.js"
import { createDiagramClient } from "./client.js"
import { collectEvidence, digest, mergeEvidence, type Evidence } from "./evidence.js"
import { DiagramEngine } from "./engine.js"
import { DiagramRpc } from "./schema.js"
import { diagramRequest } from "./harness.js"
import { registerDiagramTools } from "./tools.js"
import { registerNativeAuthor } from "./native.js"

/** Independent plugin: no provider/agent transforms or offload integration. */
export function generationNamespace(config: DiagramConfig) {
  // Authoring policy revision: re-evaluate pre-policy accepted views on the next
  // observation, without clearing the last-good diagram or changing its schema.
  return digest(JSON.stringify([5, config.backend, config.providerID, config.model, config.variant, config.baseURL,
    config.responseFormat, config.maxTokens, config.thinkingBudget, config.enableThinking, config.cachePrompt]))
}
export function defineDiagramPlugin(defaults: Record<string, unknown>, nativeAuthor = registerNativeAuthor) {
  return Plugin.define({
    id: "open-diagram-server",
    async setup(ctx) {
      const config = ConfigSchema.parse({ ...defaults, ...ctx.options })
      const native = config.backend === "opencode" ? await nativeAuthor(ctx) : undefined
      const abort = new AbortController()
      type Collector = { timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; again: boolean; refresh: boolean; retryBlockedKey?: string }
      const collectors = new Map<string, Collector>()
      const children = new Map<string, { parentID: string; evidence: Evidence[]; at: number }>()
      const controls = new Map<string, symbol>()
      const depthControls = new Map<string, symbol>()
      const key = (sessionID: string) => `diagram/v1/${digest(JSON.stringify([ctx.location.directory, ctx.location.project.id, ctx.location.workspaceID ?? null]))}/${digest(sessionID)}`
      let publish: (state: Awaited<ReturnType<DiagramEngine["get"]>>) => Promise<void> = async () => {}
      const engine = new DiagramEngine({
        ...config,
        cacheNamespace: generationNamespace(config),
        analyze: config.backend === "manual" ? undefined : createDiagramClient(config, fetch, native?.generate),
        load: (sessionID) => ctx.storage.get(key(sessionID)),
        save: (sessionID, state) => ctx.storage.set(key(sessionID), state),
        publish: (state) => publish(state),
      })
      const localSession = async (sessionID: string, signal = abort.signal) => {
        if (native?.owns(sessionID)) throw new Error("Managed diagram author has no diagram panel")
        const session = await ctx.session.get({ sessionID }, { signal })
        // SessionInfo exposes PublicRef (directory only), not transport workspaceID.
        // Workspace routing belongs to the host; additionally bind to public project identity.
        if (session.location.directory !== ctx.location.directory || session.projectID !== ctx.location.project.id) {
          throw new Error("Diagram session belongs to another location")
        }
        return session
      }
      const collectCurrent = async (sessionID: string, refresh: boolean, authoring = false, retryBlockedKey?: string) => {
        const session = await localSession(sessionID)
        const messages = await ctx.session.context({ sessionID }, { signal: abort.signal })
        for (const [id, child] of children) if (child.at < Date.now() - 60 * 60 * 1000) children.delete(id)
        const own = collectEvidence(messages)
        const related = [...children.values()].filter((child) => child.parentID === sessionID)
          .sort((a, b) => a.at - b.at).slice(-4).flatMap((child) => child.evidence)
        // Keep current parent evidence last: the parent request defines the job.
        const evidence = mergeEvidence(own, related)
        await engine.observe(sessionID, evidence, !authoring)
        // Authoring suppresses automatic work, not already-admitted controls.
        if (refresh) await engine.control(sessionID, undefined, true, undefined, undefined, retryBlockedKey)
        // Child work contributes to its parent diagram only inside this same location.
        if (session.parentID) {
          if (children.size >= 64 && !children.has(sessionID)) children.delete(children.keys().next().value!)
          children.set(sessionID, { parentID: session.parentID, at: Date.now(), evidence: own.map((item) => ({
            ...item, label: `Child ${sessionID.slice(-6)} · ${item.label}`.slice(0, 160), text: item.text.slice(0, 1500),
          })) })
          queue(session.parentID)
        }
      }
      const collect = async (sessionID: string, refresh: boolean, authoring = false, retryBlockedKey?: string) => {
        try { await collectCurrent(sessionID, refresh, authoring, retryBlockedKey) }
        catch (error) {
          if (!abort.signal.aborted) engine.collectionFailed(sessionID)
          if (error instanceof Error && error.message === "Diagram session belongs to another location") throw error
          throw new Error("Diagram evidence unavailable; refresh to retry")
        }
      }
      const queue = (sessionID: string, refresh = false, retryBlockedKey?: string): boolean => {
        if (native?.owns(sessionID)) return true
        if (abort.signal.aborted) return false
        const existing = collectors.get(sessionID)
        if (existing) { if (refresh) existing.retryBlockedKey = retryBlockedKey; existing.refresh ||= refresh; if (existing.running) existing.again = true; return true }
        if (collectors.size >= 64) {
          // Only already-admitted engine entries are affected; never hydrate.
          // Dropped hooks and explicit controls both invalidate fresh-evidence
          // confidence, not just publication attempts.
          engine.collectionFailed(sessionID)
          return false
        }
        const item: Collector = { again: false, refresh, retryBlockedKey }
        item.timer = setTimeout(() => {
          item.timer = undefined
          const refresh = item.refresh
          const retryBlockedKey = item.retryBlockedKey
          item.refresh = false
          item.retryBlockedKey = undefined
          item.running = collect(sessionID, refresh, false, retryBlockedKey).catch(() => {}).finally(() => {
            collectors.delete(sessionID)
            if (item.again) queue(sessionID, item.refresh, item.retryBlockedKey)
          })
        }, 150)
        item.timer.unref?.()
        collectors.set(sessionID, item)
        return true
      }
      const collectNow = async (sessionID: string): Promise<void> => {
        abort.signal.throwIfAborted()
        const existing = collectors.get(sessionID)
        if (existing?.running) {
          await existing.running
          // Read again after an existing read: publish must check current evidence.
          return collectNow(sessionID)
        }
        if (existing?.timer) clearTimeout(existing.timer)
        if (!existing && collectors.size >= 64) {
          await localSession(sessionID)
          // Admission may have waited while another collector recovered. Never
          // invalidate newer evidence based on the earlier capacity observation.
          if (collectors.has(sessionID) || collectors.size < 64) return collectNow(sessionID)
          engine.collectionFailed(sessionID)
          throw new Error("Diagram collection capacity reached")
        }
        const item: Collector = existing ?? { again: false, refresh: false }
        collectors.set(sessionID, item)
        const refresh = item.refresh
        const retryBlockedKey = item.retryBlockedKey
        item.refresh = false
        item.retryBlockedKey = undefined
        item.running = collect(sessionID, refresh, true, retryBlockedKey).finally(() => {
          collectors.delete(sessionID)
          if (item.again) queue(sessionID, item.refresh, item.retryBlockedKey)
        })
        await item.running
      }
      const snapshot = async (sessionID: string) => {
        await collectNow(sessionID)
        const { state, evidence, token } = await engine.snapshot(sessionID)
        const request = diagramRequest(evidence, state.graph, state.mode === "on", state.granularity)
        return { version: request.version as 1, sessionID, epoch: state.epoch, token, evidence,
          granularity: state.granularity, views: state.views.map(({ id, label }) => ({ id, label })), instruction: request.instruction, outputSchema: request.outputSchema }
      }
      const submit = async (sessionID: string, token: string, analysis: unknown, signal = abort.signal) => {
        let admitted = false
        let collected = false
        try {
          await localSession(sessionID, signal)
          admitted = true
          await collectNow(sessionID)
          collected = true
          signal.throwIfAborted()
          return await engine.submit(sessionID, token, analysis, signal)
        } catch (error) {
          // Never hydrate or schedule a session rejected by location admission.
          if (admitted) {
            // Capacity rejection can happen before collect() reports failure.
            // Release the matching lease, but never infer from unrefreshed input.
            if (!collected) engine.collectionFailed(sessionID)
            await engine.resume(sessionID, token).catch(() => {})
          }
          throw error
        }
      }
      const rpc = await ctx.rpc.register(DiagramRpc, {
        async snapshot({ sessionID }, request) {
          request.signal.throwIfAborted()
          const result = await snapshot(sessionID)
          request.signal.throwIfAborted()
          return result
        },
        publish: ({ sessionID, token, analysis }, request) => submit(sessionID, token, analysis, AbortSignal.any([abort.signal, request.signal])),
        async get({ sessionID }) {
          await localSession(sessionID)
          // Viewing a saved diagram must never collect evidence or invoke a model.
          return engine.get(sessionID)
        },
        async control({ sessionID, mode, refresh, granularity }, request) {
          const token = Symbol()
          // Refresh has no mode intent and must not supersede a pending pause.
          if (mode !== undefined) controls.set(sessionID, token)
          if (granularity !== undefined) depthControls.set(sessionID, token)
          // Depth-only choices, like refresh, never supersede a pending pause.
          const current = (field?: "mode" | "granularity") => field === "mode" ? controls.get(sessionID) === token
            : field === "granularity" ? depthControls.get(sessionID) === token
            : (mode === undefined && granularity === undefined) || controls.get(sessionID) === token || depthControls.get(sessionID) === token
          try {
            const signal = AbortSignal.any([abort.signal, request.signal])
            await localSession(sessionID, signal)
            if (signal.aborted) throw new Error("Diagram control cancelled")
            if (!current()) return engine.get(sessionID)
            // Apply mode before collection. Every context read uses the same
            // single-flight collector; a timed-out enable cannot undo a newer pause.
            const retryBlockedKey = await engine.activeInput(sessionID)
            const state = await engine.control(sessionID, mode, refresh, { signal, current, deferAnalysis: true }, granularity)
            // Explicit Refresh can recover evidence even while paused; the
            // engine still refuses inference until tracking is resumed.
            if ((state.mode !== "off" || refresh) && !signal.aborted) {
              const explicit = !!refresh || mode !== undefined || granularity !== undefined
              if (!queue(sessionID, explicit, retryBlockedKey) && explicit) {
                // Mode is effective even if its save failed; preserve both diagnostics.
                throw request.error("capacity", `Diagram collection capacity reached; refresh to retry${state.cacheError ? ". Tracking preference is not saved" : ""}`,
                  { mode: state.mode, cacheError: state.cacheError })
              }
            }
            return state
          } finally {
            if (controls.get(sessionID) === token) controls.delete(sessionID)
            if (depthControls.get(sessionID) === token) depthControls.delete(sessionID)
          }
        },
      })
      publish = (state) => rpc.events.emit("updated", state)
      await registerDiagramTools(ctx, { snapshot, publish: submit, rejected: async (sessionID, token) => {
        await localSession(sessionID)
        await engine.resume(sessionID, token)
      } }, abort.signal)
      // Hooks observe only: schedule bounded public-context reads after admission/tool completion.
      await ctx.session.hook("prompt", (event) => { queue(event.sessionID) })
      await ctx.session.hook("context", (event) => { queue(event.sessionID) })
      await ctx.tool.hook("execute.after", (event) => { queue(event.sessionID) })
      const events = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            if (event.location && (event.location.directory !== ctx.location.directory
              || ("workspaceID" in event.location && event.location.workspaceID !== ctx.location.workspaceID))) continue
            if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)
              && "sessionID" in event.data && typeof event.data.sessionID === "string") queue(event.data.sessionID)
          }
        } catch { /* Public reconnect reads recover snapshots; telemetry must never break agent work. */ }
      })()
      return async () => {
        abort.abort()
        for (const item of collectors.values()) if (item.timer) clearTimeout(item.timer)
        await engine.dispose()
        await Promise.allSettled([events, ...[...collectors.values()].map((item) => item.running)])
        collectors.clear()
        children.clear()
        controls.clear()
        depthControls.clear()
      }
    },
  })
}
