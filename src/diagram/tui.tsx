/** @jsxImportSource @opentui/solid */

import type { LocationRef } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import type { Data, PanelInput } from "@opencode/plugin/tui/context"
import type { ColorInput, ScrollBoxRenderable } from "@opentui/core"
import { createMemo, createRenderEffect, createSignal, For, Show, untrack } from "solid-js"

import { CompactDiagram } from "./view.js"
import { analysisViews, DiagramRpc, type DiagramState, type DiagramGraph, initialState } from "./schema.js"
import { createDiagramExportActions, type ExportAction } from "./export-actions.js"
import { copyDiagramImage } from "./export-platform.js"

export const DIAGRAM_PANEL = "open-diagram"
export const DIAGRAM_CACHE_LIMIT = 64
export const DIAGRAM_TIMEOUT_MS = 8_000

type DiagramTheme = {
  text: { default: ColorInput; subdued: ColorInput; feedback: { warning: { default: ColorInput } } }
  border: { default: ColorInput }
} | {
  text: { base: ColorInput; muted: ColorInput; feedback: { warning: { base: ColorInput } } }
  border: { base: ColorInput }
}

/** 2.0.7 string tokens and newer native RGBA tokens; never replace host theme. */
export function diagramColors(theme: DiagramTheme) {
  const { text, border } = theme
  const warning = text.feedback.warning
  return {
    text: "base" in text ? text.base : text.default,
    subdued: "muted" in text ? text.muted : text.subdued,
    accent: "base" in warning ? warning.base : warning.default,
    border: "base" in border ? border.base : border.default,
  }
}

export interface DiagramSession {
  id: string
  location: LocationRef
}

/** Public session data omits workspace routing; preserve the matching host ref. */
export function resolveDiagramSession(
  session: { id: string; location: { directory: string } } | undefined,
  location?: LocationRef,
  fallback?: LocationRef,
): DiagramSession | undefined {
  if (!session) return undefined
  const host = [location, fallback].find((ref) => ref?.directory === session.location.directory)
  return { id: session.id, location: host ? { ...host } : { ...session.location } }
}

type Control = { mode?: DiagramState["mode"]; refresh?: boolean; granularity?: DiagramState["granularity"] }
type CallOptions = { location: LocationRef; signal: AbortSignal }
export interface DiagramClient {
  get(input: { sessionID: string }, options: CallOptions): Promise<DiagramState>
  control(input: Control & { sessionID: string }, options: CallOptions): Promise<DiagramState>
  events: {
    on(name: "updated", handler: (event: { data: DiagramState; location?: LocationRef }) => void): () => void
  }
}

function locationKey(location: LocationRef): string {
  return JSON.stringify([location.directory, location.workspaceID ?? null])
}

export function diagramRpcProblem(error: unknown): string {
  if (error && typeof error === "object" && "type" in error && error.type === "capacity") {
    const data = "data" in error && error.data && typeof error.data === "object" ? error.data : undefined
    const mode = data && "mode" in data && ["auto", "on", "off"].includes(String(data.mode)) ? String(data.mode) : undefined
    return `Diagram collection capacity reached; refresh to retry${mode ? `. Effective mode: ${mode}` : ""}${data && "cacheError" in data && data.cacheError ? ". Tracking preference is not saved (cache write failed)" : ""}`
  }
  return "Diagram server unavailable. Enable the open-diagram server plugin at this session's location, or retry."
}

export function diagramSessionKey(session: DiagramSession): string {
  return JSON.stringify([session.id, locationKey(session.location)])
}

/** Bounded location/session cache, push updates, and one active scoped RPC. */
export function createDiagramMonitor(rpc: DiagramClient) {
  const [session, setSession] = createSignal<DiagramSession>()
  const [state, setState] = createSignal<DiagramState>()
  const [problem, setProblem] = createSignal<string>()
  const [actionProblem, setActionProblem] = createSignal<string>()
  const [capacityProblem, setCapacityProblem] = createSignal<string>()
  const [eventProblem, setEventProblem] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  let active: DiagramSession | undefined
  let generation = 0
  let eventVersion = 0
  let reconcile = false
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let pending: { cancel(): void; done: Promise<boolean>; control: boolean } | undefined
  type Cached = { state: DiagramState; problem?: string; actionProblem?: string; capacityProblem?: string; invalidated: boolean; valid: boolean; retired: Set<string> }
  const cache = new Map<string, Cached>()
  const selectedCache = () => active ? cache.get(diagramSessionKey(active)) : undefined
  const saveProblems = () => {
    const entry = selectedCache()
    if (entry) Object.assign(entry, { problem: untrack(problem), actionProblem: untrack(actionProblem), capacityProblem: untrack(capacityProblem) })
  }

  const apply = (next: DiagramState, authoritative = false) => {
    if (!active || next.sessionID !== active.id) return false
    const current = untrack(state)
    // Epoch UUIDs are not ordered. Only a location-scoped RPC response can
    // establish a new incarnation; buffered old events cannot retire its state.
    if (current?.epoch !== next.epoch && !authoritative) return false
    if (current?.epoch === next.epoch && next.revision < current.revision) return false
    const entry = selectedCache()
    if (entry) {
      if (current && current.epoch !== next.epoch) {
        if (entry.retired.size >= 16) entry.retired.delete(entry.retired.values().next().value!)
        entry.retired.add(current.epoch)
      }
      entry.state = next
    }
    setState(next)
    setProblem(undefined)
    return true
  }
  const subscribe = () => {
    if (disposed || unsubscribe) return
    try {
      unsubscribe = rpc.events.on("updated", (event) => {
        if (disposed || !event.location) return
        const key = diagramSessionKey({ id: event.data.sessionID, location: event.location })
        const entry = cache.get(key)
        if (!entry || entry.retired.has(event.data.epoch)) return
        const selected = active && diagramSessionKey(active) === key
        // UUID epochs cannot be ordered. Reconcile a new incarnation once via
        // scoped GET; inactive sessions keep their graph until next selected.
        if (event.data.epoch !== entry.state.epoch) {
          entry.invalidated = true
          entry.valid = false
          if (selected) {
            reconcile = true
            if (!pending) void request()
          }
        } else if (selected) {
          if (apply(event.data)) { eventVersion++; saveProblems() }
        } else if (event.data.revision >= entry.state.revision) {
          entry.state = event.data
          entry.problem = undefined
        }
      })
      if (untrack(eventProblem)) for (const entry of cache.values()) { entry.invalidated = true; entry.valid = false }
      setEventProblem(undefined)
    } catch {
      setEventProblem("Live diagram events unavailable; use Refresh to retry")
    }
  }

  const request = (control?: Control): Promise<boolean> => {
    if (disposed || !active) return Promise.resolve(false)
    if (pending) {
      if (!control || pending.control) return pending.done
      pending.cancel()
    }
    reconcile = false
    subscribe()
    // Consume this invalidation attempt, including failed GETs. Navigation
    // must not become a retry loop; new events or explicit actions may retry.
    const entry = selectedCache()
    if (entry) { entry.invalidated = false; entry.valid = false }
    const selected = active
    const version = generation
    const eventsAtStart = eventVersion
    const controller = new AbortController()
    let finish!: (next?: DiagramState, error?: string, effective?: boolean) => void
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const task: NonNullable<typeof pending> = {
      control: control !== undefined,
      cancel: () => { finish(); controller.abort() },
      done: new Promise<boolean>((resolve) => {
        finish = (next, error, effective = false) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (pending === task) pending = undefined
          const current = !disposed && version === generation && active === selected
          if (current) setBusy(false)
          let accepted = false
          if (current) {
            if (next && next.sessionID === selected.id) {
              // A newer same-epoch event can supersede this snapshot without
              // making its scoped RPC fail. Mode-dependent actions use that
              // newer state after checking their captured selection identity.
              apply(next, true)
               accepted = true
               setProblem(undefined)
               if (control?.mode !== undefined) setActionProblem(undefined)
               if (control) setCapacityProblem(undefined)
               const entry = selectedCache()
               if (entry) { entry.invalidated = reconcile; entry.valid = !reconcile }
            }
            if (error && (task.control || eventsAtStart === eventVersion)) {
              setProblem(error)
              if (control?.mode !== undefined) setActionProblem(effective ? undefined
                : `${control.mode === "off" ? "Pause" : "Resume"} was not confirmed; retry the tracking control.`)
            }
            saveProblems()
            if (reconcile) queueMicrotask(() => { if (!disposed && reconcile && !pending) void request() })
          }
          resolve(accepted)
        }
      }),
    }
    pending = task
    setBusy(task.control)
    timer = setTimeout(() => {
      finish(undefined, "Diagram RPC timed out; use Refresh to retry")
      controller.abort()
    }, DIAGRAM_TIMEOUT_MS)
    // The extra turn also contains synchronous client errors and ensures task
    // ownership exists before a test double or transport can return a result.
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined
      const options = { location: selected.location, signal: controller.signal }
      return control
        ? rpc.control({ sessionID: selected.id, ...control }, options)
        : rpc.get({ sessionID: selected.id }, options)
    }).then((next) => finish(next), (error) => {
      const message = diagramRpcProblem(error)
      if (control && error?.type === "capacity" && !settled && !disposed && version === generation && active === selected) setCapacityProblem(message)
      finish(undefined, message, error?.type === "capacity" && control?.mode !== undefined && error?.data?.mode === control.mode)
    })
    return task.done
  }

  subscribe()
  return {
    session,
    state,
    problem: () => [...new Set([eventProblem(), actionProblem(), capacityProblem(), problem()].filter(Boolean))].join(" ") || undefined,
    actionFailed: (action: "Pause" | "Resume") => {
      setActionProblem(`${action} was not confirmed; retry the tracking control.`)
      saveProblems()
    },
    busy,
    select(next: DiagramSession | undefined) {
      if (disposed || (next && active && diagramSessionKey(next) === diagramSessionKey(active))) return
      if (!next && !active) return
      saveProblems()
      if (pending) {
        const entry = selectedCache()
        if (entry) entry.invalidated = true
      }
      generation++
      reconcile = false
      pending?.cancel()
      active = next ? { id: next.id, location: { ...next.location } } : undefined
      const key = active ? diagramSessionKey(active) : undefined
      let entry = key ? cache.get(key) : undefined
      if (key && active) {
        cache.delete(key)
        if (!entry) entry = { state: initialState(active.id), invalidated: true, valid: false, retired: new Set() }
        cache.set(key, entry)
        if (cache.size > DIAGRAM_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      }
      setSession(active)
      setState(entry?.state)
      setProblem(entry?.problem)
      setActionProblem(entry?.actionProblem)
      setCapacityProblem(entry?.capacityProblem)
      setBusy(false)
      if (active && entry?.invalidated) void request()
    },
    reconnect(location?: LocationRef) {
      if (disposed) return
      for (const [key, entry] of cache) {
        if (!location || JSON.parse(key)[1] === locationKey(location)) { entry.invalidated = true; entry.valid = false }
      }
      if (active && (!location || locationKey(location) === locationKey(active.location))) {
        reconcile = true
        if (!pending) void request()
      }
    },
    refresh: () => request(),
    confirmed: () => !disposed && !pending && !reconcile && !!selectedCache()?.valid,
    async ensure() {
      const selected = active
      while (selected && !disposed && active === selected) {
        // Consuming automatic retry admission does not establish authority.
        // Also follow successor reads queued by newer recovery boundaries.
        if (!pending && selectedCache()?.valid && !reconcile) return true
        const accepted = await (pending?.done ?? request())
        if (disposed || active !== selected) return false
        // A failed/cancelled read may already have a successor admitted by a
        // newer recovery event or control. Follow it, but never retry failure
        // alone: that still requires a new event or explicit action.
        if (!accepted && !pending && !reconcile) return false
      }
      return false
    },
    control: (input: Control) => request(input),
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      pending?.cancel()
      unsubscribe?.()
      unsubscribe = undefined
      cache.clear()
    },
  }
}

type DiagramMonitor = ReturnType<typeof createDiagramMonitor>

/** Shared public host-event binding; no private connection state or polling. */
export function bindDiagramMonitor(monitor: DiagramMonitor, data: Pick<Data, "on">) {
  const connected = data.on("server.connected", () => monitor.reconnect())
  const updated = data.on("plugin.updated", (event) => monitor.reconnect(event.location))
  return () => { connected(); updated() }
}

export function diagramStatus(state: DiagramState | undefined, problem?: string): string {
  if (!state) return "Select a session to view its diagram"
  if (problem) return `${state.graph ? "Stale snapshot · " : "Unavailable · "}${problem}`
  if (state.updateError && state.graph) return `Cached diagram · Update failed: ${state.updateError}${state.collectionError ? ` · ${state.collectionError}` : ""}${state.cacheError ? ` · ${state.cacheError}` : ""}`
  const stale = state.stale ? " · stale snapshot" : ""
  return `${state.phase}${stale} · ${state.reason}${state.collectionError ? ` · ${state.collectionError}` : ""}${state.cacheError ? ` · ${state.cacheError}` : ""}`
}

function DiagramPanel(props: {
  ctx: Plugin.Context
  panel: PanelInput
  monitor: DiagramMonitor
  control(input: Control): Promise<void>
  pause(): Promise<void>
  close(): void
  tab(): string | undefined
  choose(id: string): void
  export(action: ExportAction, graph?: DiagramGraph, selected?: string): Promise<void>
  exporting(): boolean
}) {
  const { ctx, monitor } = props
  const colors = () => diagramColors(ctx.theme)
  const [selected, setSelected] = createSignal<string>()
  let scroll: ScrollBoxRenderable | undefined
  let previousSession: string | undefined
  const state = createMemo(() => monitor.state()?.sessionID === props.panel.sessionID ? monitor.state() : undefined)
  const view = createMemo(() => {
    const views = state() ? analysisViews(state()!) : []
    return views.find((view) => view.id === props.tab()) ?? views[0]
  })
  const blocks = createMemo(() => view()?.graph.nodes ?? [])
  const nodeID = (id: string) => `open-diagram-node-${id}`
  const select = (id: string | undefined) => {
    setSelected(id)
    if (id) scroll?.scrollChildIntoView(nodeID(id))
  }
  createRenderEffect(() => {
    const session = monitor.session()
    const key = session ? `${diagramSessionKey(session)}:${view()?.id}` : undefined
    const nodes = blocks()
    if (previousSession !== key || !nodes.some((node) => node.id === untrack(selected))) {
      setSelected(undefined)
      if (previousSession !== key) scroll?.scrollTo(0)
    }
    previousSession = key
  })
  const step = (delta: number) => {
    const nodes = blocks()
    if (!nodes.length) return
    const index = nodes.findIndex((node) => node.id === selected())
    select(nodes[Math.max(0, Math.min(nodes.length - 1, index + delta))].id)
  }
  ctx.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      { id: "open-diagram-panel-fullscreen", title: "Toggle diagram fullscreen", bind: "f", run: props.panel.toggleFullscreen },
      { id: "open-diagram-panel-pause", title: "Pause or resume diagram", bind: "p", run: props.pause },
      { id: "open-diagram-panel-refresh", title: "Refresh diagram", bind: "r", run: () => props.control({ refresh: true }) },
      { bind: "j", title: "Next diagram node", run: () => step(1) },
      { bind: "k", title: "Previous diagram node", run: () => step(-1) },
      { bind: "escape", title: "Close diagram", run: props.close },
    ],
  }))
  const actions = [
    { get label() { return state()?.mode === "off" ? "Resume" : "Pause" }, run: props.pause },
    { label: "Refresh", run: () => props.control({ refresh: true }) },
    { get label() { return props.panel.presentation === "fullscreen" ? "Restore" : "Full" }, run: props.panel.toggleFullscreen },
    { label: "Close", run: props.close },
  ]

  return (
    <box width={props.panel.width} height="100%" flexDirection="column">
      <text flexShrink={0} fg={colors().text}>
        {`Diagram · ${state()?.phase ?? "watching"}${monitor.busy() ? " · …" : ""}`}
      </text>
      <ViewTabs ctx={ctx} state={state()} tab={props.tab()} choose={props.choose} sidebar={props.close} />
      <DepthTabs ctx={ctx} state={state()} control={props.control} />
      <box flexDirection="row" flexWrap="wrap" flexShrink={0}>
        <For each={actions}>{(action) => (
          <text fg={colors().text} onMouseUp={(event) => {
            if (event.button !== 0) return
            event.stopPropagation()
            void action.run()
          }}>{`[${action.label}] `}</text>
        )}</For>
      </box>
      <DiagramExportRow ctx={ctx} state={state()} tab={props.tab()} selected={selected()} run={props.export} busy={props.exporting()} />
      <Show when={props.panel.presentation !== "fullscreen"}>
        <text fg={colors().subdued}>Drag divider to resize</text>
      </Show>
      <scrollbox ref={(value) => { scroll = value }} flexGrow={1} minHeight={0} scrollX={false} focused={props.panel.focused}>
        <DiagramContent ctx={ctx} state={state()} problem={monitor.problem()} tab={props.tab()} selected={selected()}
          select={(id) => { props.panel.focus(); select(id) }} />
      </scrollbox>
    </box>
  )
}

function DiagramExportRow(props: { ctx: Plugin.Context; state?: DiagramState; tab?: string; selected?: string;
  run(action: ExportAction, graph?: DiagramGraph, selected?: string): Promise<void>; busy: boolean }) {
  const colors = () => diagramColors(props.ctx.theme)
  const graph = () => {
    const views = props.state ? analysisViews(props.state) : []
    return (views.find((view) => view.id === props.tab) ?? views[0])?.graph
  }
  return <box flexDirection="row" flexWrap="wrap" flexShrink={0}>
    <For each={["png", "svg", "save"] as const}>{(action) => <text
      fg={graph() && !props.busy ? colors().text : colors().subdued}
      onMouseUp={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        if (graph() && !props.busy) void props.run(action, graph(), props.selected)
      }}>{`[${action === "save" ? "Save" : action.toUpperCase()}] `}</text>}</For>
    <Show when={props.busy}><text fg={colors().subdued}>…</text></Show>
  </box>
}

function ViewTabs(props: { ctx: Plugin.Context; state?: DiagramState; tab?: string; choose(id: string): void; sidebar(): void }) {
  const colors = () => diagramColors(props.ctx.theme)
  const views = () => props.state ? analysisViews(props.state) : []
  return <box flexDirection="row" flexWrap="wrap" flexShrink={0}>
    <For each={views().length ? views() : [{ id: "$diagram", label: "Diagram" }]}>{(view) =>
      <text fg={props.tab === view.id || (!props.tab && view.id === views()[0]?.id) ? colors().text : colors().subdued}
        onMouseUp={(event) => { if (event.button === 0) { event.stopPropagation(); props.choose(view.id) } }}>{`[${view.label}] `}</text>
    }</For>
    <text fg={props.tab === "$sidebar" ? colors().text : colors().subdued}
      onMouseUp={(event) => { if (event.button === 0) { event.stopPropagation(); props.sidebar() } }}>[Sidebar]</text>
  </box>
}

function DepthTabs(props: { ctx: Plugin.Context; state?: DiagramState; control(input: Control): Promise<void> }) {
  const colors = () => diagramColors(props.ctx.theme)
  return <box flexDirection="row" flexWrap="wrap" flexShrink={0}>
    <text fg={colors().subdued}>Depth </text>
    <For each={["overview", "granular"] as const}>{(granularity) =>
      <text fg={(props.state?.granularity ?? "overview") === granularity ? colors().text : colors().subdued}
        onMouseUp={(event) => {
          if (event.button !== 0) return
          event.stopPropagation()
          void props.control({ granularity })
        }}>{`[${granularity === "overview" ? "Overview" : "Granular"}] `}</text>
    }</For>
  </box>
}

function DiagramContent(props: { ctx: Plugin.Context; state?: DiagramState; problem?: string; tab?: string; selected?: string; select(id: string | undefined): void }) {
  const colors = () => diagramColors(props.ctx.theme)
  const view = () => {
    const views = props.state ? analysisViews(props.state) : []
    return views.find((view) => view.id === props.tab) ?? views[0]
  }
  const error = () => [...new Set([props.problem, props.state?.collectionError, props.state?.cacheError, props.state?.updateError,
    props.state?.phase === "unavailable" ? props.state.reason : undefined].filter(Boolean))].join(" · ")
  return <box width="100%" flexDirection="column" flexShrink={0}>
    <Show when={error()}><text fg={colors().accent}>{error()}</text></Show>
    <Show when={view()} fallback={<text fg={colors().subdued}>{props.state?.reason ?? "Waiting…"}</text>}>
      <text fg={colors().subdued}>{`${view()!.graph.title}${props.state?.stale ? " · stale" : ""}`}</text>
      <CompactDiagram graph={view()!.graph} changed={props.state?.changedViews[view()!.id] ?? props.state?.changed ?? []}
        sources={props.state?.sources ?? []} selected={props.selected} onSelect={props.select}
        colors={colors()} />
    </Show>
  </box>
}

export default Plugin.define({
  id: "open-diagram-tui",
  setup(ctx) {
    const colors = () => diagramColors(ctx.theme)
    const [preferences, updatePreferences] = ctx.storage.store("diagram-preferences", {
      initial: { sidebarVisible: true },
    })
    const monitor = createDiagramMonitor(ctx.client.rpc(DiagramRpc))
    const removeHostEvents = bindDiagramMonitor(monitor, ctx.data)
    const tabs = new Map<string, string>()
    const [tab, setTab] = createSignal<string>()
    const [node, setNode] = createSignal<string>()
    let replaceSidebar: (() => void) | undefined
    const resumeModes = new Map<string, "auto" | "on">()
    let disposed = false
    const exportAbort = new AbortController()
    const [exporting, setExporting] = createSignal(false)
    const exportAction = createDiagramExportActions({
      directory: process.cwd(),
      chooseFormat: () => ctx.ui.dialog.select({ title: "Save diagram", options: [
        { title: "PNG image", value: "png" as const }, { title: "SVG vector", value: "svg" as const },
      ] }),
      choosePath: (value, format, fallback, reason) => ctx.ui.dialog.prompt({ title: `Save ${format.toUpperCase()} diagram`, value,
        description: `${fallback ? `${reason ?? "Image clipboard unavailable."} ` : ""}Save on this computer (TUI host). Existing files are never overwritten.` }),
      copySVG: (text, signal) => copyDiagramImage(Buffer.from(text, "utf8"), "image/svg+xml", signal, ctx.renderer.capabilities?.remote ?? false),
      copyPNG: (bytes, signal) => copyDiagramImage(bytes, "image/png", signal, ctx.renderer.capabilities?.remote ?? false),
      notify: (message, variant) => ctx.ui.toast.show({ title: "Diagram export", message, variant }),
    }, exportAbort.signal)
    const exportDiagram = async (action: ExportAction, graph?: DiagramGraph, selected?: string) => {
      if (disposed || exporting()) return
      setExporting(true)
      try { await exportAction(action, graph, selected) } finally { if (!disposed) setExporting(false) }
    }
    let selection: string | undefined
    let pendingPause: { session: DiagramSession; resume: boolean; done: Promise<void> } | undefined
    let depthIntent: symbol | undefined
    const choose = (id: string) => {
      const session = monitor.session()
      if (session) {
        if (tabs.size >= 64) tabs.delete(tabs.keys().next().value!)
        tabs.set(diagramSessionKey(session), id)
      }
      setTab(id)
      setNode(undefined)
    }

    const selectCurrent = () => {
      const route = ctx.ui.router.current()
      const info = route.type === "session" ? ctx.data.session.get(route.sessionID) : undefined
      const session = resolveDiagramSession(info, ctx.location, info ? ctx.data.location.default() : undefined)
      untrack(() => monitor.select(session))
      return session
    }
    const toast = (message: string) => ctx.ui.toast.show({ title: "Diagram", message, variant: "warning" })
    const open = (fullscreen = false, panel = false) => {
      if (disposed) return false
      const session = selectCurrent()
      if (!session) {
        toast("Select a loaded session before opening its diagram")
        return false
      }
      if (tab() === undefined || tab() === "$sidebar") choose(analysisViews(monitor.state() ?? initialState(session.id))[0]?.id ?? "$diagram")
      if (!fullscreen && !panel && !ctx.data.session.get(session.id)?.parentID) return true
      const opened = ctx.ui.panel.open(DIAGRAM_PANEL, fullscreen ? { presentation: "fullscreen" } : undefined)
      if (!opened) toast("Diagram panel unavailable in the current view")
      return opened
    }
    const sendControl = async (input: Control) => {
      if (disposed) return
      const session = selectCurrent()
      if (!session) { toast("Select a loaded session before controlling its diagram"); return }
      if (monitor.busy()) { toast("Diagram control pending; try again after it completes"); return }
      const selected = monitor.session()
      const previous = monitor.state()
      if (await monitor.control(input)) {
        const mode = input.mode === "off" ? (previous?.epoch !== "pending" ? previous?.mode : undefined) : input.mode
        if (mode && mode !== "off") resumeModes.set(diagramSessionKey(session), mode)
      } else if (!disposed && monitor.session() === selected) {
        toast(monitor.problem() ?? "Diagram control was not confirmed; retry.")
      }
    }
    const control = async (input: Control) => {
      selectCurrent()
      const selected = monitor.session()
      const intent = input.granularity !== undefined ? Symbol() : undefined
      if (intent) depthIntent = intent
      // A depth click must not cancel the read needed to resolve a Pause toggle.
      if (pendingPause && pendingPause.session === selected) await pendingPause.done
      selectCurrent()
      if (disposed || monitor.session() !== selected || (intent && depthIntent !== intent)) return
      if (input.granularity !== undefined && input.mode === undefined && !input.refresh) {
        // A placeholder's Overview is not the persisted depth. Warm cache hits
        // stay read-free; cold/reconnecting choices wait for the existing read.
        for (;;) {
          // Every iteration follows an await, possibly of Pause. Obsolete
          // actions must never reconcile the newly selected session instead.
          selectCurrent()
          if (disposed || monitor.session() !== selected || depthIntent !== intent) return
          const accepted = await monitor.ensure()
          selectCurrent()
          if (disposed || monitor.session() !== selected || depthIntent !== intent) return
          // Pause may start during hydration, and a newer recovery boundary may
          // arrive between ensure resolving and this continuation. Recheck both
          // before comparing depth; never cancel the successor read.
          const pausing = pendingPause
          if (pausing && pausing.session === selected) { await pausing.done; continue }
          if (!accepted) {
            toast(monitor.problem() ?? "Diagram depth was not confirmed; retry.")
            return
          }
          if (monitor.confirmed()) break
        }
        if (monitor.state()?.granularity === input.granularity) return
      }
      await sendControl(input)
    }
    const pause = (resumeOnly = false): Promise<void> => {
      const session = selectCurrent()
      if (!session) { toast("Select a loaded session before controlling its diagram"); return Promise.resolve() }
      const selected = monitor.session()!
      // Capture the displayed action. If an event flips Pause to Resume before
      // acknowledgement, preserve that opposite click behind the active task.
      const resume = resumeOnly || monitor.state()?.mode === "off"
      const hydrateIntent = !resumeOnly && monitor.state()?.epoch === "pending"
      if (pendingPause?.session === selected && pendingPause.resume === resume) return pendingPause.done
      const previous = pendingPause?.session === selected ? pendingPause.done : undefined
      const task = { session: selected, resume, done: Promise.resolve() }
      pendingPause = task
      task.done = (async () => {
        if (previous) await previous
        selectCurrent()
        if (disposed || monitor.session() !== selected) return
        // Initial state is a placeholder. Never redirect after navigation (including ABA).
        if (!await monitor.refresh() || disposed) {
          if (!disposed && monitor.session() === selected) {
            monitor.actionFailed(resume ? "Resume" : "Pause")
            toast(monitor.problem() ?? "Tracking action was not confirmed; retry Pause or Resume.")
          }
          return
        }
        selectCurrent()
        if (monitor.session() !== selected) return
        const key = diagramSessionKey(session)
        const mode = monitor.state()?.mode ?? "auto"
        // Warm clicks keep their displayed intent even when preflight observes a
        // concurrent mode change. Only placeholder state needs intent hydration.
        const resolvedResume = hydrateIntent ? mode === "off" : resume
        task.resume = resolvedResume
        if (mode !== "off") resumeModes.set(key, mode)
        await sendControl({ mode: resolvedResume ? resumeModes.get(key) ?? "auto" : "off" })
      })().finally(() => { if (pendingPause === task) pendingPause = undefined })
      return task.done
    }
    const close = () => {
      choose("$sidebar")
      ctx.ui.panel.close()
    }
    const command = async (input = "") => {
      const action = input.trim().toLowerCase() || "open"
      if (!["open", "auto", "on", "off", "refresh", "pause", "resume", "panel", "fullscreen", "sidebar", "close", "overview", "granular"].includes(action)) {
        toast("Usage: /open-diagram [auto|on|off|refresh|pause|resume|panel|fullscreen|sidebar|close|overview|granular]")
        return
      }
      if (action === "close" || action === "sidebar") { close(); return }
      if (!open(action === "fullscreen", action === "panel")) return
      if (action === "auto" || action === "on" || action === "off") await control({ mode: action })
      else if (action === "refresh") await control({ refresh: true })
      else if (action === "pause") await control({ mode: "off" })
      else if (action === "resume") await pause(true)
      else if (action === "overview" || action === "granular") await control({ granularity: action })
    }

    const removeApp = ctx.ui.slot({
      append: "app",
      render() {
        createRenderEffect(() => {
          if (disposed) return
          const session = selectCurrent()
          const key = session ? diagramSessionKey(session) : undefined
          if (key !== selection) {
            selection = key
            setTab(key ? tabs.get(key) : undefined)
            setNode(undefined)
          }
          const state = monitor.state()
          const replace = !!key && preferences.sidebarVisible && tab() !== "$sidebar" && !!state
            && (state.relevant || tab() !== undefined)
          if (replace && !replaceSidebar) replaceSidebar = ctx.ui.slot({ replace: "sidebar.content", render: (input) =>
            <Show when={monitor.state()?.sessionID === input.sessionID}>
              <DepthTabs ctx={ctx} state={monitor.state()} control={control} />
              <box flexDirection="row" flexWrap="wrap" flexShrink={0}>
                <For each={[
                  { label: "↻", run: () => control({ refresh: true }) },
                  { get label() { return monitor.state()?.mode === "off" ? "Resume" : "Pause" }, run: () => pause() },
                  { label: "Expand", run: () => open(false, true) },
                ]}>{(action) => <text fg={colors().subdued} onMouseUp={(event) => {
                  if (event.button === 0) { event.stopPropagation(); void action.run() }
                }}>{`[${action.label}] `}</text>}</For>
                <text fg={colors().subdued}>{monitor.state()?.phase}</text>
              </box>
              <DiagramExportRow ctx={ctx} state={monitor.state()} tab={tab()} selected={node()} run={exportDiagram} busy={exporting()} />
              <DiagramContent ctx={ctx} state={monitor.state()} problem={monitor.problem()} tab={tab()} selected={node()} select={setNode} />
            </Show>,
          })
          else if (!replace && replaceSidebar) { replaceSidebar(); replaceSidebar = undefined }
        })
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "open-diagram", title: "Open live diagram", group: "Open Diagram", palette: true,
            slash: { name: "open-diagram", arguments: true }, run: command,
           }, ...(["auto", "on", "off", "refresh", "panel", "fullscreen", "overview", "granular"] as const).map((action) => ({
            id: `open-diagram-${action}`, title: `Diagram: ${action}`, group: "Open Diagram", palette: true as const,
            slash: { name: `open-diagram-${action}` }, run: () => command(action),
          })), {
            id: "open-diagram-sidebar", title: "Toggle diagram tabs", group: "Open Diagram", palette: true,
            async run() {
              try {
                await updatePreferences((draft) => { draft.sidebarVisible = !draft.sidebarVisible })
              } catch { toast("Could not save diagram display preference") }
            },
          }],
        }))
        return null
      },
    })
    const removePanel = ctx.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === DIAGRAM_PANEL}>
           <DiagramPanel ctx={ctx} panel={panel} monitor={monitor} control={control} pause={() => pause()}
             tab={tab} choose={choose} close={close} export={exportDiagram} exporting={exporting} />
        </Show>
      ),
    })
    const removeSidebar = ctx.ui.slot({
      // Sibling anchor survives replacement; prepend would be suppressed inside it.
      before: "sidebar.content",
      render: (props) => (
        <Show when={preferences.sidebarVisible && monitor.state()?.sessionID === props.sessionID}>
          <ViewTabs ctx={ctx} state={monitor.state()} tab={tab()} choose={choose} sidebar={() => choose("$sidebar")} />
        </Show>
      ),
    })
    const cleanup = () => {
      if (disposed) return
      disposed = true
      exportAbort.abort()
      monitor.dispose()
      removeHostEvents()
      replaceSidebar?.()
      removeSidebar()
      removePanel()
      removeApp()
      tabs.clear()
      resumeModes.clear()
    }
    return cleanup
  },
})
