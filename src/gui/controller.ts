import type { LocationRef } from "@opencode/client/promise"
import { analysisViews, type DiagramState } from "../diagram/model.js"
import type { DiagramHistoryEntry, DiagramHistorySummary } from "../diagram/history-model.js"

export type Control = { mode?: DiagramState["mode"]; granularity?: DiagramState["granularity"]; refresh?: boolean }
type Options = { location: LocationRef; signal: AbortSignal }
export type RenderInput = { sessionID: string; viewID: string; epoch: string; revision: number; selected?: string; colorMode: "light" | "dark" }
export interface DiagramClient {
  get(input: { sessionID: string }, options: Options): Promise<DiagramState>
  control(input: Control & { sessionID: string }, options: Options): Promise<DiagramState>
  render(input: RenderInput, options: Options): Promise<{ sessionID: string; viewID: string; epoch: string; revision: number; svg: string }>
  history(input: { sessionID: string }, options: Options): Promise<DiagramHistorySummary[]>
  historyGet(input: { sessionID: string; snapshotID: string }, options: Options): Promise<DiagramHistoryEntry>
  renderHistory(input: { sessionID: string; snapshotID: string; selected?: string; colorMode: "light" | "dark" }, options: Options): Promise<{ sessionID: string; snapshotID: string; svg: string }>
  events: { on(name: "updated", listener: (event: { data: DiagramState; location?: LocationRef }) => void): () => void }
}
export type Route = { server: string; sessionID: string; location: LocationRef; client: DiagramClient; incarnation?: object }
export type Presentation = { state?: DiagramState; svg?: string; viewID?: string; selected?: string; problem?: string; busy: boolean; rendering: boolean;
  history?: DiagramHistorySummary[]; snapshotID?: string; historical?: DiagramHistoryEntry; historyLoading?: boolean; historyProblem?: string }
export const sameLocation = (a: LocationRef, b: LocationRef) => a.directory === b.directory && a.workspaceID === b.workspaceID

/** No framework, host globals, renderer or model calls. Every async result has an owner. */
export function createDiagramController(changed: (value: Presentation) => void) {
  let route: Route | undefined
  let value: Presentation = { busy: false, rendering: false }
  let generation = 0
  let readVersion = 0
  let renderVersion = 0
  let readAbort: AbortController | undefined
  let renderAbort: AbortController | undefined
  let historyAbort: AbortController | undefined
  let pickAbort: AbortController | undefined
  let historyVersion = 0
  let pickVersion = 0
  let unsubscribe: (() => void) | undefined
  let disposed = false
  let colorMode: "light" | "dark" = "light"
  let renderKey = ""
  let eventProblem: string | undefined
  const retired = new Set<string>()
  const emit = (patch: Partial<Presentation>) => { value = { ...value, ...patch }; changed(value) }
  const current = (owner: Route, version: number) => !disposed && route === owner && generation === version

  async function bounded<T>(abort: AbortController, work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("cancelled"))
      abort.signal.addEventListener("abort", cancel, { once: true })
      timer = setTimeout(() => abort.abort(), 10_000)
    })
    try { return await Promise.race([Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new Error("cancelled")
      return work()
    }), cancelled]) }
    finally { clearTimeout(timer); abort.signal.removeEventListener("abort", cancel) }
  }

  function render() {
    const owner = route
    const state = value.state
    const historical = value.snapshotID ? value.historical : undefined
    const view = value.snapshotID ? historical?.view : state && analysisViews(state).find((view) => view.id === value.viewID)
    const key = owner && state && view ? JSON.stringify([generation, historical?.id ?? [state.epoch, state.revision], view.id, value.selected, colorMode]) : ""
    if (key === renderKey) return
    renderKey = key
    const serial = ++renderVersion
    renderAbort?.abort()
    if (!owner || !state || !view) { emit({ svg: undefined, rendering: false }); return }
    const version = generation
    const abort = renderAbort = new AbortController()
    const input: RenderInput = { sessionID: owner.sessionID, viewID: view.id, epoch: state.epoch, revision: state.revision, selected: value.selected, colorMode }
    emit({ rendering: true })
    void bounded<Awaited<ReturnType<DiagramClient["render"]>> | Awaited<ReturnType<DiagramClient["renderHistory"]>>>(abort, () => historical
      ? owner.client.renderHistory({ sessionID: owner.sessionID, snapshotID: historical.id, selected: input.selected, colorMode: input.colorMode }, { location: owner.location, signal: abort.signal })
      : owner.client.render(input, { location: owner.location, signal: abort.signal })).then((result) => {
      if (!current(owner, version) || serial !== renderVersion || abort.signal.aborted) return
      const matches = historical ? "snapshotID" in result && result.snapshotID === historical.id
        : "viewID" in result && result.viewID === input.viewID && result.epoch === input.epoch && result.revision === input.revision
      if (result.sessionID !== input.sessionID || !matches) {
        emit({ rendering: false, problem: "Diagram render identity mismatch; retry reading." }); return
      }
      emit({ svg: result.svg, rendering: false })
    }, () => {
      if (current(owner, version) && serial === renderVersion) emit({ rendering: false, problem: "Diagram image unavailable or stale; retry reading." })
    })
  }

  async function listHistory() {
    const owner = route
    if (!owner || disposed) return
    const version = generation
    const serial = ++historyVersion
    historyAbort?.abort()
    const abort = historyAbort = new AbortController()
    try {
      const history = await bounded(abort, () => owner.client.history({ sessionID: owner.sessionID }, { location: owner.location, signal: abort.signal }))
      if (!current(owner, version) || serial !== historyVersion || abort.signal.aborted) return
      const expired = value.snapshotID && !history.some(item => item.id === value.snapshotID)
      emit({ history, historyProblem: expired ? "Cached diagram expired; showing Live." : undefined })
      if (expired) live()
    } catch {
      if (current(owner, version) && serial === historyVersion) emit({ historyProblem: "Recent diagrams unavailable; retry reading." })
    }
  }

  function live(viewID = value.viewID) {
    pickVersion++; pickAbort?.abort()
    emit({ viewID, snapshotID: undefined, historical: undefined, historyLoading: false, selected: undefined, svg: undefined, problem: eventProblem })
    renderKey = ""
    render()
  }

  async function chooseHistory(snapshotID: string) {
    const owner = route
    if (!owner || disposed || (snapshotID === value.snapshotID && (value.historical || value.historyLoading))) return
    const version = generation
    const serial = ++pickVersion
    pickAbort?.abort(); renderVersion++; renderAbort?.abort(); renderKey = ""
    const abort = pickAbort = new AbortController()
    emit({ snapshotID, historical: undefined, selected: undefined, svg: undefined, rendering: false, historyLoading: true, problem: eventProblem })
    try {
      const historical = await bounded(abort, () => owner.client.historyGet({ sessionID: owner.sessionID, snapshotID }, { location: owner.location, signal: abort.signal }))
      if (!current(owner, version) || serial !== pickVersion || abort.signal.aborted) return
      if (historical.id !== snapshotID) throw new Error("Cached diagram identity mismatch")
      emit({ historical, historyLoading: false })
      render()
    } catch {
      if (current(owner, version) && serial === pickVersion) emit({ historyLoading: false, problem: "Cached diagram is unavailable; choose Live or another recent diagram." })
    }
  }

  function apply(next: DiagramState, authoritative: boolean) {
    if (!route || next.sessionID !== route.sessionID) return
    const previous = value.state
    if (previous?.epoch === next.epoch && next.revision < previous.revision) return
    if (previous && previous.epoch !== next.epoch) {
      if (!authoritative || retired.has(next.epoch)) return
      retired.add(previous.epoch)
    }
    const views = analysisViews(next)
    const viewID = views.find((view) => view.id === value.viewID)?.id ?? views[0]?.id
    const inspected = value.snapshotID ? value.historical?.view : views.find(view => view.id === viewID)
    const selected = inspected?.graph.nodes.some((node) => node.id === value.selected) ? value.selected : undefined
    const imageChanged = !value.snapshotID && (previous?.epoch !== next.epoch || previous?.revision !== next.revision || viewID !== value.viewID || selected !== value.selected)
    emit({ state: next, viewID, selected, problem: value.snapshotID ? value.problem : eventProblem, ...(imageChanged ? { svg: undefined } : {}) })
    render()
    void listHistory()
  }

  async function read(control?: Control) {
    const owner = route
    if (!owner || disposed || (control && value.busy)) return false
    if (!unsubscribe) subscribe()
    const version = generation
    const serial = ++readVersion
    readAbort?.abort()
    const abort = readAbort = new AbortController()
    emit({ busy: true })
    try {
      const options = { location: owner.location, signal: abort.signal }
      const next = await bounded(abort, () => control ? owner.client.control({ sessionID: owner.sessionID, ...control }, options) : owner.client.get({ sessionID: owner.sessionID }, options))
      if (!current(owner, version) || serial !== readVersion || abort.signal.aborted) return false
      apply(next, true)
      return next.sessionID === owner.sessionID
    } catch {
      if (current(owner, version) && serial === readVersion) emit({ problem: "Diagram server unavailable; last snapshot retained. Retry reading or enable the server plugin." })
      return false
    } finally {
      if (current(owner, version) && serial === readVersion) emit({ busy: false })
    }
  }

  function subscribe() {
    const owner = route
    if (!owner || disposed || unsubscribe) return
    const version = generation
    try {
      unsubscribe = owner.client.events.on("updated", (event) => {
        if (!current(owner, version) || !event.location || !sameLocation(event.location, owner.location) || event.data.sessionID !== owner.sessionID || retired.has(event.data.epoch)) return
        if (!value.state || event.data.epoch !== value.state.epoch) { void read(); return }
        apply(event.data, false)
      })
      eventProblem = undefined
    } catch { eventProblem = "Live diagram events unavailable; retry reading."; emit({ problem: eventProblem }) }
  }

  return {
    snapshot: () => value,
    select(next: Route | undefined) {
      if (disposed) return
      if (route && next && route.server === next.server && route.sessionID === next.sessionID && route.client === next.client && route.incarnation === next.incarnation && sameLocation(route.location, next.location)) return
      const sameSession = route && next && route.server === next.server && route.sessionID === next.sessionID && sameLocation(route.location, next.location)
      generation++; readVersion++; renderVersion++
      historyVersion++; pickVersion++
      readAbort?.abort(); renderAbort?.abort(); historyAbort?.abort(); pickAbort?.abort(); unsubscribe?.(); unsubscribe = undefined
      route = next ? { ...next, location: { ...next.location } } : undefined
      if (!sameSession) retired.clear()
      renderKey = ""; eventProblem = undefined
      value = sameSession ? { ...value, busy: false, rendering: false, historyLoading: false } : { busy: false, rendering: false }; changed(value)
      if (!route) return
      void read()
      if (value.snapshotID && !value.historical) void chooseHistory(value.snapshotID)
    },
    read: () => {
      renderKey = ""
      const pending = read()
      if (value.snapshotID && !value.historical && !value.historyLoading) void chooseHistory(value.snapshotID)
      return pending
    },
    control: (input: Control) => read(input),
    choose(viewID: string) { if (viewID === value.viewID && !value.snapshotID) return; live(viewID) },
    live,
    chooseHistory,
    inspect(selected?: string) { if (selected === value.selected) return; emit({ selected, svg: undefined }); render() },
    appearance(mode: "light" | "dark") { if (mode === colorMode) return; colorMode = mode; emit({ svg: undefined }); render() },
    dispose() {
      if (disposed) return
      disposed = true; generation++; readAbort?.abort(); renderAbort?.abort(); historyAbort?.abort(); pickAbort?.abort(); unsubscribe?.(); route = undefined
    },
  }
}
