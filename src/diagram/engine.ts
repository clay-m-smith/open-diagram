import { randomUUID } from "node:crypto"
import { candidateWork, digest, type Evidence } from "./evidence.js"
import { analysisViews, initialState, StateSchema, type DiagramAnalysis, type DiagramGraph, type DiagramMode, type DiagramState, type DiagramGranularity } from "./schema.js"
import { validateDiagramOutput } from "./harness.js"
import { affectedViews, evidenceKey, fingerprintKey, evidenceFingerprints, MemoSchema, type AcceptedDiagram, type DiagramMemo, type StoredDiagram } from "./cache.js"
import type { DiagramUpdate } from "./schema.js"

type Entry = {
  state: DiagramState
  evidence: Evidence[]
  hash: string
  generation: number
  pending: boolean
  due: number
  failures: number
  users: number
  dirty: boolean
  memo: DiagramMemo
  workKey?: string
  pendingRetry?: boolean
  unscheduled?: boolean
  authoring?: { key: string; token: string; timer: ReturnType<typeof setTimeout> }
  activeKey?: string
  activeExplicit?: boolean
  displayKey?: string
  saving?: Promise<void>
  publishing?: Promise<void>
  pendingSave?: StoredDiagram
  pendingPublication?: DiagramState
  controller?: AbortController
}
export type EngineDependencies = {
  intervalMs: number
  debounceMs: number
  cacheNamespace?: string
  authoringMs?: number
  analyze?(evidence: readonly Evidence[], previous: DiagramGraph | null, forced: boolean, signal: AbortSignal, granularity: DiagramGranularity, update?: DiagramUpdate): Promise<DiagramAnalysis>
  load(sessionID: string): Promise<unknown>
  save(sessionID: string, state: StoredDiagram): Promise<void>
  publish(state: DiagramState): Promise<void>
}

function changedNodes(before: DiagramGraph | null, after: DiagramGraph | null): string[] {
  if (!after) return []
  const signature = (graph: DiagramGraph | null, id: string) => {
    const node = graph?.nodes.find((node) => node.id === id)
    if (!node) return ""
    const { evidence: _evidence, ...description } = node
    return JSON.stringify([description, graph!.edges.filter((edge) => edge.from === id || edge.to === id)])
  }
  return after.nodes.filter((node) => signature(before, node.id) !== signature(after, node.id)).map((node) => node.id)
}

/** One coalescing, fair, rate-limited request queue per location. No agent-loop awaits. */
export class DiagramEngine {
  private entries = new Map<string, Entry>()
  private loading = new Map<string, { promise: Promise<Entry>; users: number }>()
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private nextRequest = 0
  private disposed = false
  constructor(private readonly deps: EngineDependencies) {}

  private async entry(sessionID: string): Promise<Entry> {
    if (this.disposed) throw new Error("Diagram plugin unloaded")
    const cached = this.entries.get(sessionID)
    if (cached) { cached.users++; return cached }
    const loading = this.loading.get(sessionID)
    if (loading) { loading.users++; return loading.promise }
    // Bound both state and concurrent initial reads. Evict only idle entries.
    if (this.entries.size + this.loading.size >= 64) {
      const idle = [...this.entries].find(([, entry]) => !entry.users && !entry.pending && !entry.controller && !entry.authoring
        && !entry.dirty && !entry.saving && !entry.publishing && !entry.pendingSave && !entry.pendingPublication)
      if (!idle) throw new Error("Diagram session capacity reached")
      // Synchronous eviction of an unleased, fully drained entry. No await gap.
      this.entries.delete(idle[0])
    }
    const reservation = { promise: undefined as unknown as Promise<Entry>, users: 1 }
    const promise = (async () => {
      let state = initialState(sessionID)
      let memo: DiagramMemo = { version: 1, entries: [] }
      try {
        const value = await this.deps.load(sessionID)
        const { memo: storedMemo, ...snapshot } = value && typeof value === "object" ? value as StoredDiagram : {} as StoredDiagram
        const saved = StateSchema.safeParse(snapshot)
        if (value != null && (!saved.success || saved.data.sessionID !== sessionID)) throw new Error("Invalid cache record")
        const parsedMemo = MemoSchema.safeParse(storedMemo)
        if (parsedMemo.success) memo = parsedMemo.data
        if (saved.success && saved.data.sessionID === sessionID) {
          state = { ...saved.data, collectionError: null, phase: saved.data.mode === "off" ? "paused" : saved.data.graph ? "ready" : "watching", stale: !!saved.data.graph }
        }
      } catch { throw new Error("Diagram cache read failed; retry before changing tracking state") }
      // A new incarnation after eviction must not reuse an older revision frontier.
      state.epoch = randomUUID()
      const entry: Entry = { state, evidence: [], hash: "", generation: 0, pending: false, due: 0, failures: 0, users: reservation.users, dirty: false, memo }
      if (!this.disposed) this.entries.set(sessionID, entry)
      return entry
    })()
    reservation.promise = promise
    this.loading.set(sessionID, reservation)
    try { return await promise } finally { this.loading.delete(sessionID) }
  }

  private publish(entry: Entry, persist = false) {
    if (this.disposed) return
    entry.state.revision++
    const state = structuredClone(entry.state)
    // Independent bounded drains: one in flight + one latest snapshot each.
    // Slow event subscribers cannot delay durable pause acknowledgement.
    entry.pendingPublication = state
    void this.drainPublications(entry)
    if (persist) {
      entry.dirty = true
      entry.pendingSave = { ...state, cacheError: null, collectionError: null, memo: structuredClone(entry.memo) }
      void this.drainSaves(entry)
    }
  }

  private drainPublications(entry: Entry): Promise<void> {
    if (entry.publishing) return entry.publishing
    return entry.publishing = Promise.resolve().then(async () => {
      while (entry.pendingPublication && !this.disposed) {
        const next = entry.pendingPublication
        entry.pendingPublication = undefined
        await this.deps.publish(next).catch(() => {})
      }
    }).finally(() => {
      entry.publishing = undefined
      if (entry.pendingPublication && !this.disposed) return this.drainPublications(entry)
    })
  }

  private drainSaves(entry: Entry): Promise<void> {
    if (entry.saving) return entry.saving
    return entry.saving = Promise.resolve().then(async () => {
      while (entry.pendingSave) {
        const next = entry.pendingSave
        entry.pendingSave = undefined
        try {
          await this.deps.save(next.sessionID, next)
          if (!entry.pendingSave) {
            entry.dirty = false
            if (entry.state.cacheError) {
              entry.state.cacheError = null
              this.publish(entry)
            }
          }
        } catch {
          // Presentation revisions do not supersede durable writes. Only a
          // queued durable snapshot can cover this failure; otherwise retain it
          // independently of inference status until a later save succeeds.
          if (!entry.pendingSave) {
            entry.state.cacheError = "Diagram cache write failed; changes remain in memory. Retry a control to save."
            this.publish(entry)
          }
        }
      }
    }).finally(() => {
      entry.saving = undefined
      if (entry.pendingSave) return this.drainSaves(entry)
    })
  }

  async get(sessionID: string): Promise<DiagramState> {
    const entry = await this.entry(sessionID)
    try { return structuredClone(entry.state) } finally { entry.users-- }
  }

  /** Capture active input at control admission, before deferred collection. */
  async activeInput(sessionID: string): Promise<string | undefined> {
    const entry = await this.entry(sessionID)
    try { return entry.controller && !entry.controller.signal.aborted ? entry.activeKey : undefined } finally { entry.users-- }
  }

  /** A rejected publication releases its observed change back to tracking. */
  async resume(sessionID: string, rejectedToken?: string) {
    // A late old publisher must not release a newer author's reservation.
    // Cleanup never hydrates a session that has not already been admitted.
    const entry = this.entries.get(sessionID)
    if (this.disposed || !entry || (entry.authoring && entry.authoring.token !== rejectedToken)) return
    this.releaseAuthor(entry)
    if (entry.unscheduled && entry.state.mode !== "off" && entry.evidence.length && !entry.state.collectionError && !this.reuse(entry)) this.queue(entry)
  }

  private token(entry: Entry): string {
    return digest(JSON.stringify([entry.state.epoch, entry.workKey, entry.generation]))
  }

  async snapshot(sessionID: string) {
    const entry = await this.entry(sessionID)
    try {
      if (this.disposed) throw new Error("Diagram plugin unloaded")
      if (this.deps.analyze && entry.state.mode !== "off" && entry.workKey && !(entry.pending && entry.pendingRetry)
        && !(entry.controller && !entry.controller.signal.aborted && entry.activeExplicit)
        && (entry.unscheduled || entry.pending || entry.controller)) {
        this.releaseAuthor(entry)
        entry.controller?.abort()
        entry.pending = false
        entry.pendingRetry = false
        entry.unscheduled = true
        const key = entry.workKey
        const timer = setTimeout(() => {
          if (entry.authoring?.timer !== timer) return
          entry.authoring = undefined
          if (!this.disposed && entry.unscheduled && entry.workKey === key && entry.state.mode !== "off" && entry.evidence.length) this.queue(entry)
        }, this.deps.authoringMs ?? 120_000)
        timer.unref?.()
        entry.authoring = { key, token: this.token(entry), timer }
        entry.state.phase = entry.state.graph ? "ready" : "watching"
        entry.state.reason = "Awaiting main-agent diagram publication"
        this.publish(entry)
      }
      return { token: this.token(entry), state: structuredClone(entry.state), evidence: structuredClone(entry.evidence) }
    } finally { entry.users-- }
  }

  private releaseAuthor(entry: Entry) {
    if (entry.authoring) clearTimeout(entry.authoring.timer)
    entry.authoring = undefined
  }

  async submit(sessionID: string, token: string, value: unknown, signal?: AbortSignal): Promise<DiagramState> {
    const entry = await this.entry(sessionID)
    try {
      if (this.disposed) throw new Error("Diagram plugin unloaded")
      signal?.throwIfAborted()
      if (token !== this.token(entry)) throw new Error("Diagram snapshot changed; obtain a fresh snapshot before publishing")
      const wire = validateDiagramOutput(value, entry.evidence)
      if (!wire.relevant && entry.state.graph) throw new Error("No grounded update returned; cached diagram retained")
      const analysis = { ...wire, graph: wire.views[0]?.graph ?? null }
      entry.controller?.abort()
      entry.pending = false
      entry.pendingRetry = false
      this.applyAnalysis(entry, analysis, entry.evidence, false)
      await entry.saving
      return structuredClone(entry.state)
    } finally { entry.users-- }
  }

  private applyAnalysis(entry: Entry, analysis: DiagramAnalysis, evidence: Evidence[], stale: boolean, key = evidenceKey(evidence, entry.state.granularity, this.deps.cacheNamespace)) {
    const before = new Map(analysisViews(entry.state).map((view) => [view.id, view.graph]))
    const views = analysisViews(analysis)
    entry.generation++
    entry.failures = 0
    if (!stale) { entry.unscheduled = false; this.releaseAuthor(entry) }
    entry.state.changedViews = Object.fromEntries(views.map((view) => [view.id, changedNodes(before.get(view.id) ?? null, view.graph)]))
    entry.state.changed = changedNodes(entry.state.graph, analysis.graph)
    entry.state.graph = analysis.graph
    entry.state.views = views
    entry.state.relevant = analysis.relevant
    entry.state.reason = analysis.reason
    entry.state.updateError = null
    entry.state.updatedAt = Date.now()
    entry.state.sources = evidence.map(({ id, label }) => ({ id, label }))
    entry.state.stale = stale
    entry.state.phase = entry.state.mode === "off" ? "paused" : entry.pending ? "queued" : analysis.relevant ? "ready" : "watching"
    const accepted: AcceptedDiagram = { key, granularity: entry.state.granularity, fingerprints: evidenceFingerprints(evidence),
      analysis: { relevant: analysis.relevant, reason: analysis.reason, views }, sources: entry.state.sources, updatedAt: entry.state.updatedAt }
    entry.memo.entries = [...entry.memo.entries.filter((item) => item.granularity !== accepted.granularity), accepted]
    entry.memo.failed = entry.memo.failed?.filter((item) => item.key !== key || item.granularity !== accepted.granularity)
    entry.displayKey = key
    this.publish(entry, true)
  }

  private reuse(entry: Entry, unverified = false, recovered = false): boolean {
    if (entry.state.collectionError) return false
    const accepted = entry.memo.entries.find((item) => (unverified || item.key === entry.workKey) && item.granularity === entry.state.granularity)
    if (!accepted) return false
    if (!unverified && !recovered && !entry.pending && !entry.controller && !entry.state.stale && !entry.state.updateError
      && entry.displayKey === accepted.key) return true
    entry.generation++
    entry.controller?.abort()
    entry.pending = false
    entry.pendingRetry = false
    entry.unscheduled = false
    this.releaseAuthor(entry)
    entry.displayKey = accepted.key
    Object.assign(entry.state, { graph: accepted.analysis.views[0]?.graph ?? null, views: structuredClone(accepted.analysis.views),
      relevant: accepted.analysis.relevant, reason: accepted.analysis.reason, updatedAt: accepted.updatedAt,
      sources: structuredClone(accepted.sources), changed: [], changedViews: {}, stale: unverified, updateError: null,
      phase: entry.state.mode === "off" ? "paused" : accepted.analysis.relevant ? "ready" : "watching" })
    this.publish(entry, true)
    return true
  }

  async observe(sessionID: string, evidence: Evidence[], automatic = true) {
    const entry = await this.entry(sessionID)
    try {
      if (this.disposed) return
      const hash = digest(JSON.stringify(evidence))
      const legacyBaseline = !entry.hash && !!entry.state.graph && !entry.memo.entries.length
      const recovered = !!entry.state.collectionError
      if (entry.hash === hash && !recovered) {
        if (automatic && entry.unscheduled && !entry.authoring && entry.state.mode !== "off" && entry.evidence.length) this.queue(entry)
        return
      }
      entry.state.collectionError = null
      entry.hash = hash
      entry.evidence = evidence
      const workKey = evidenceKey(evidence, entry.state.granularity, this.deps.cacheNamespace)
      const changed = workKey !== entry.workKey
      entry.workKey = workKey
      if (entry.authoring && entry.authoring.key !== workKey) this.releaseAuthor(entry)
      if (this.reuse(entry, false, recovered)) return
      if (recovered) this.publish(entry)
      if (entry.state.mode === "off") {
        if (entry.state.graph) entry.state.stale = true
        if (recovered || entry.state.graph) this.publish(entry)
        return
      }
      if (!evidence.length) {
        // Compaction/temporary empty context is not proof that code vanished.
        entry.generation++
        entry.controller?.abort()
        entry.pending = false
        entry.pendingRetry = false
        entry.unscheduled = false
        this.releaseAuthor(entry)
        if (entry.state.graph) { entry.state.stale = true; entry.state.phase = "ready"; this.publish(entry); return }
        entry.state = { ...initialState(sessionID), epoch: entry.state.epoch, mode: entry.state.mode, granularity: entry.state.granularity,
          revision: entry.state.revision, cacheError: entry.state.cacheError }
        this.publish(entry, true)
        return
      }
      if (entry.state.mode === "auto" && !entry.state.relevant && !entry.controller && !entry.pending && !candidateWork(evidence)) {
        entry.state.phase = "watching"
        this.publish(entry)
        return
      }
      // Legacy records lack accepted input fingerprints. Keep displaying them;
      // initial observation establishes a baseline, not an automatic rebuild.
      if (changed && !legacyBaseline) entry.unscheduled = true
      if (!automatic && entry.unscheduled && entry.state.graph) { entry.state.stale = true; this.publish(entry) }
      if (automatic && !legacyBaseline && (changed || recovered || entry.unscheduled)) this.queue(entry)
    } finally { entry.users-- }
  }

  /** Failed collection must not make a previously accepted graph look current. */
  collectionFailed(sessionID: string) {
    const entry = this.entries.get(sessionID)
    if (this.disposed || !entry || entry.state.collectionError) return
    // Cancellation is not completion. A same-input authoring recollection must
    // still reserve (and eventually release) the work that collection failure
    // interrupted, even when no new material fingerprint arrives.
    if (entry.pending || (entry.controller && !entry.controller.signal.aborted)) entry.unscheduled = true
    entry.generation++
    entry.controller?.abort()
    entry.pending = false
    entry.pendingRetry = false
    entry.state.collectionError = "Diagram evidence unavailable; refresh to retry"
    entry.state.stale = !!entry.state.graph
    entry.state.phase = entry.state.mode === "off" ? "paused" : entry.state.graph ? "ready" : "unavailable"
    this.publish(entry)
  }

  async control(sessionID: string, mode?: DiagramMode, refresh = false, admission?: { signal: AbortSignal; current(field?: "mode" | "granularity"): boolean; deferAnalysis?: boolean }, granularity?: DiagramGranularity, retryBlockedKey?: string): Promise<DiagramState> {
    const entry = await this.entry(sessionID)
    try {
      if (this.disposed) throw new Error("Diagram plugin unloaded")
      if (admission?.signal.aborted) throw new Error("Diagram control cancelled")
      if (admission && !admission.current()) return structuredClone(entry.state)
      // Recheck each independent intent after hydration, not only at RPC admission.
      if (admission && !admission.current("mode")) mode = undefined
      if (admission && !admission.current("granularity")) granularity = undefined
      if ((mode !== undefined && mode !== entry.state.mode) || (granularity !== undefined && granularity !== entry.state.granularity)) {
        entry.generation++
        entry.controller?.abort()
        entry.pending = false
        entry.pendingRetry = false
        this.releaseAuthor(entry)
        entry.state.mode = mode ?? entry.state.mode
        entry.state.granularity = granularity ?? entry.state.granularity
        if (entry.evidence.length) entry.workKey = evidenceKey(entry.evidence, entry.state.granularity, this.deps.cacheNamespace)
        entry.state.phase = entry.state.mode === "off" ? "paused" : "watching"
        entry.state.stale = !!entry.state.graph
        entry.state.reason = entry.state.mode === "off" ? "Diagram tracking paused" : "Watching current development evidence"
        this.publish(entry, true)
      }
      if (entry.dirty && !entry.saving) this.publish(entry, true)
      if (granularity !== undefined) this.reuse(entry, !entry.evidence.length)
      // Explicit ownership is separate from permission to retry after failure.
      if (refresh && entry.controller && !entry.controller.signal.aborted && entry.activeKey === entry.workKey) entry.activeExplicit = true
      if (!admission?.deferAnalysis && (refresh || mode !== undefined || granularity !== undefined) && entry.evidence.length) {
        if (!this.reuse(entry) && entry.state.mode !== "off") this.queue(entry, refresh && entry.workKey !== retryBlockedKey)
      }
      await entry.saving
      return structuredClone(entry.state)
    } finally { entry.users-- }
  }

  private queue(entry: Entry, retry = false) {
    if (entry.authoring?.key === entry.workKey && !retry) return
    if (retry) this.releaseAuthor(entry)
    entry.unscheduled = false
    if (entry.workKey === entry.activeKey && entry.controller && !entry.controller.signal.aborted) {
      // A -> B -> A while A is active supersedes the reservation for B.
      entry.pending = false
      entry.pendingRetry = false
      return
    }
    const failed = this.failedInput(entry)
    if (failed && !retry) {
      // Superseded work cannot later erase the current failed-input warning.
      if (entry.controller && !entry.controller.signal.aborted) { entry.generation++; entry.controller.abort() }
      entry.pending = false
      entry.pendingRetry = false
      const error = failed.error ?? "Previous diagram update failed; Refresh to retry"
      const phase = entry.state.graph ? "ready" : "unavailable"
      const changed = entry.state.updateError !== error || entry.state.stale !== !!entry.state.graph || entry.state.phase !== phase
      entry.state.updateError = error
      entry.state.stale = !!entry.state.graph
      entry.state.phase = phase
      if (changed) this.publish(entry, true)
      return
    }
    if (entry.state.collectionError) {
      entry.state.phase = entry.state.graph ? "ready" : "unavailable"
      this.publish(entry)
      return
    }
    if (!this.deps.analyze) {
      entry.state.stale = !!entry.state.graph
      entry.state.phase = "watching"
      entry.state.reason = "Awaiting a diagram author"
      this.publish(entry)
      return
    }
    // Leading deadline + latest snapshot: sustained tool activity cannot starve a refresh.
    if (!entry.pending) entry.due = Date.now() + Math.max(this.deps.debounceMs, entry.failures ? this.deps.intervalMs * 2 ** Math.min(entry.failures, 4) : 0)
    entry.pending = true
    entry.pendingRetry = retry
    entry.state.stale = !!entry.state.graph
    entry.state.phase = entry.controller ? "updating" : "queued"
    this.publish(entry)
    this.schedule()
  }

  private failedInput(entry: Entry) {
    return entry.memo.failed?.find((item) => item.key === entry.workKey && item.granularity === entry.state.granularity)
  }

  private schedule() {
    if (this.disposed || this.running) return
    if (this.timer) clearTimeout(this.timer)
    const pending = [...this.entries.values()].filter((entry) => entry.pending)
    if (!pending.length) return
    const due = Math.max(this.nextRequest, Math.min(...pending.map((entry) => entry.due)))
    this.timer = setTimeout(() => {
      this.timer = undefined
      const next = [...this.entries.values()].filter((entry) => entry.pending && entry.due <= Date.now()).sort((a, b) => a.due - b.due)[0]
      if (!next) { this.schedule(); return }
      this.running = this.run(next).finally(() => { this.running = undefined; this.schedule() })
    }, Math.max(0, due - Date.now()))
    this.timer.unref?.()
  }

  private async run(entry: Entry) {
    entry.pending = false
    const retry = entry.pendingRetry
    entry.pendingRetry = false
    if (!entry.evidence.length || entry.state.mode === "off" || entry.state.collectionError || (this.failedInput(entry) && !retry)) return
    const evidence = structuredClone(entry.evidence)
    const generation = entry.generation
    const workKey = entry.workKey!
    entry.activeKey = workKey
    entry.activeExplicit = !!retry
    const controller = new AbortController()
    entry.controller = controller
    entry.state.phase = "updating"
    this.nextRequest = Date.now() + this.deps.intervalMs
    this.publish(entry)
    try {
      const previous = entry.memo.entries.find((item) => item.granularity === entry.state.granularity
        && item.key === fingerprintKey(item.fingerprints, item.granularity, this.deps.cacheNamespace))
      const affected = previous ? affectedViews(previous, evidence) : undefined
      const currentIDs = new Set(evidence.map((item) => item.id))
      const targeted = affected?.length && previous && affected.length < previous.analysis.views.length
        && previous.analysis.views.every((view) => affected.some((item) => item.id === view.id)
          || view.graph.nodes.every((node) => node.evidence.every((id) => currentIDs.has(id)))) ? affected : undefined
      const selectedIDs = new Set(targeted?.flatMap((view) => view.graph.nodes.flatMap((node) => node.evidence)))
      const selectedFiles = new Set(evidence.filter((item) => selectedIDs.has(item.id) && item.file).map((item) => item.file))
      const input = targeted ? evidence.filter((item) => selectedIDs.has(item.id) || (item.file && selectedFiles.has(item.file)) || item.category === "request") : evidence
      const maxNodes = 48 - (previous?.analysis.views.filter((view) => !targeted?.some((item) => item.id === view.id)).reduce((sum, view) => sum + view.graph.nodes.length, 0) ?? 0)
      let analysis = await this.deps.analyze!(input, targeted?.[0]?.graph ?? entry.state.graph, entry.state.mode === "on", controller.signal, entry.state.granularity, targeted ? { views: targeted, maxNodes } : undefined)
      if (this.disposed || controller.signal.aborted || generation !== entry.generation) return
      if (targeted && previous) {
        const updates = analysisViews(analysis)
        if (!analysis.relevant || updates.length !== targeted.length || updates.some((view) => !targeted.some((old) => old.id === view.id))) throw new Error("Invalid targeted diagram update; cached views retained")
        const views = previous.analysis.views.map((view) => updates.find((next) => next.id === view.id) ?? view)
        const validated = validateDiagramOutput({ relevant: true, reason: analysis.reason, views }, evidence)
        analysis = { ...validated, graph: validated.views[0]?.graph ?? null }
      }
      if (!analysis.relevant && entry.state.graph) throw new Error("No grounded update returned; cached diagram retained")
      if (entry.workKey === workKey) entry.pending = false
      this.applyAnalysis(entry, analysis, evidence, workKey !== entry.workKey, workKey)
    } catch (error) {
      if (this.disposed || controller.signal.aborted || generation !== entry.generation) return
      entry.failures++
      entry.state.phase = entry.state.graph ? "ready" : "unavailable"
      entry.state.stale = !!entry.state.graph
      entry.state.updateError = error instanceof Error ? error.message.slice(0, 240).replace(/[\x00-\x1f\x7f-\x9f]/g, " ") : "Diagram update failed"
      if (!entry.state.graph) entry.state.reason = entry.state.updateError
      entry.memo.failed = [...(entry.memo.failed ?? []).filter((item) => item.key !== workKey || item.granularity !== entry.state.granularity),
        { key: workKey, granularity: entry.state.granularity, error: entry.state.updateError }].slice(-32)
      if (entry.workKey === workKey) { entry.pending = false; entry.pendingRetry = false }
      if (entry.pending) entry.due = Date.now() + this.deps.intervalMs * 2 ** Math.min(entry.failures, 4)
      this.publish(entry, true)
    } finally { entry.controller = undefined; entry.activeKey = undefined; entry.activeExplicit = undefined }
  }

  async dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    for (const entry of this.entries.values()) { entry.controller?.abort(); this.releaseAuthor(entry) }
    // Accepted durable writes drain even after admission stops. Event delivery is
    // disposable presentation and must not hold plugin shutdown hostage.
    for (const entry of this.entries.values()) entry.pendingPublication = undefined
    await Promise.allSettled([this.running, ...[...this.loading.values()].map((load) => load.promise), ...[...this.entries.values()].map((entry) => entry.saving)])
    this.entries.clear()
  }
}
