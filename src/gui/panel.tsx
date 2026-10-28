import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import type { Context, PanelProps } from "@opencode/plugin/gui"
import { DiagramRpc } from "../diagram/schema.js"
import { analysisViews } from "../diagram/model.js"
import { createDiagramController, sameLocation, type Presentation } from "./controller.js"

export function DiagramPanel(props: { ctx: Context; panel: PanelProps }) {
  const [value, setValue] = createSignal<Presentation>({ busy: false, rendering: false })
  const controller = createDiagramController(setValue)
  const [url, setURL] = createSignal<string>()
  const [zoom, setZoom] = createSignal(1)
  const [fit, setFit] = createSignal(true)
  const [saveProblem, setSaveProblem] = createSignal<string>()
  let viewport: HTMLDivElement | undefined
  let disposed = false
  let binding = 0
  let previouslyConnected: boolean | undefined
  const views = createMemo(() => value().state ? analysisViews(value().state!) : [])
  const recent = createMemo(() => value().history?.filter(item => !item.current || item.id === value().snapshotID) ?? [])
  const view = createMemo(() => value().snapshotID ? value().historical?.view : views().find((view) => view.id === value().viewID))
  const node = createMemo(() => view()?.graph.nodes.find((node) => node.id === value().selected))
  const sources = createMemo(() => value().snapshotID ? value().historical?.sources : value().state?.sources)
  const cachedTime = (timestamp: number) => new Date(timestamp).toLocaleString()

  createEffect(() => {
    // Session, tab, client and data are all live host getters, including restart replacements.
    const session = props.panel.session
    const tab = props.panel.tab
    const location = session.location
    const client = session.server.client
    const data = session.server.data
    const online = session.server.connected
    binding++
    untrack(() => {
      controller.select(location && tab.id === "main" ? { server: session.server.id, sessionID: session.id, location, client: client.rpc(DiagramRpc), incarnation: data } : undefined)
      if (online && previouslyConnected === false) void controller.read()
      previouslyConnected = online
      setZoom(1); setFit(true); setSaveProblem(undefined)
      if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0 }
    })
    if (!location) return
    const connected = data.on("server.connected", () => { void controller.read() })
    const updated = data.on("plugin.updated", (event: { location?: NonNullable<typeof location> }) => {
      if (!event.location || sameLocation(event.location, location)) void controller.read()
    })
    onCleanup(() => { connected(); updated() })
  })
  createEffect(() => { controller.appearance(props.ctx.appearance.mode()) })
  createEffect(() => {
    const svg = value().svg
    const next = svg ? URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })) : undefined
    setURL(next)
    onCleanup(() => { if (next) URL.revokeObjectURL(next) })
  })
  onCleanup(() => { disposed = true; controller.dispose() })
  const save = async () => {
    const svg = value().svg
    if (!svg) return
    const owner = binding
    setSaveProblem(undefined)
    try { await props.ctx.system.save({ name: "diagram.svg", content: svg }) }
    catch { if (!disposed && binding === owner) setSaveProblem("Could not save SVG. Retry Save SVG.") }
  }
  const scale = (delta: number) => { setFit(false); setZoom((old) => Math.max(.1, Math.min(4, old + delta))) }

  return <section class="open-diagram-gui" aria-label="Diagram">
    <div class="od-tools" aria-label="Live diagram views">
      <button type="button" aria-pressed={!value().snapshotID} onClick={() => controller.live()}>Live</button>
      <For each={views()}>{(item) =>
      <button type="button" aria-pressed={!value().snapshotID && value().viewID === item.id} onClick={() => controller.choose(item.id)}>{item.label}</button>
    }</For></div>
    <Show when={recent().length}><div class="od-history" aria-label="Recent cached diagrams">
      <span>Recent</span><For each={recent()}>{(item) => <button type="button" aria-pressed={value().snapshotID === item.id}
        title={`${item.title} · ${item.granularity} · ${cachedTime(item.updatedAt)}`}
        onClick={() => { void controller.chooseHistory(item.id) }}>
        {item.label}<small>{item.granularity} · {new Date(item.updatedAt).toLocaleTimeString()}</small>
      </button>}</For>
    </div></Show>
    <Show when={value().historical}>{(item) => <div class="od-status">Cached · {item().granularity} · {cachedTime(item().updatedAt)} — read-only; tracking controls apply to Live.</div>}</Show>
    <div class="od-tools" aria-label="Diagram controls">
      <For each={["overview", "granular"] as const}>{(granularity) => <button type="button" disabled={!value().state || value().busy}
        aria-pressed={value().state?.granularity === granularity} onClick={() => { controller.live(); if (value().state?.granularity !== granularity) void controller.control({ granularity }) }}>
        {granularity === "overview" ? "Overview" : "Granular"}</button>}</For>
      <button type="button" disabled={!value().state || value().busy} onClick={() => { void controller.control({ mode: value().state?.mode === "off" ? "auto" : "off" }) }}>
        {value().state?.mode === "off" ? "Resume" : "Pause"}</button>
      <button type="button" disabled={!value().state || value().busy} onClick={() => { void controller.control({ refresh: true }) }}>Refresh</button>
      <button type="button" disabled={value().busy} onClick={() => { void controller.read() }}>Retry reading</button>
    </div>
    <div class="od-status" role="status">{value().state ? `${value().state!.phase}${value().state!.stale ? " · stale snapshot" : ""} · ${value().state!.reason}` : "Waiting for session location and diagram snapshot…"}
      <Show when={value().rendering || value().historyLoading}> · Loading diagram…</Show>
      <For each={[value().problem, value().historyProblem, value().state?.cacheError, value().state?.collectionError, value().state?.updateError, saveProblem()].filter(Boolean)}>{(error) => <p>{error}</p>}</For>
    </div>
    <div class="od-tools" aria-label="Image controls">
      <button type="button" onClick={() => scale(-.2)} aria-label="Zoom out">−</button>
      <button type="button" onClick={() => scale(.2)} aria-label="Zoom in">+</button>
      <button type="button" aria-pressed={fit()} onClick={() => { setFit(true); setZoom(1) }}>Fit</button>
      <button type="button" disabled={!value().svg || value().rendering} onClick={() => { void save() }}>Save SVG</button>
    </div>
    <div class="od-viewport" ref={viewport} tabindex="0" aria-label="Diagram image; scroll to pan">
      <Show when={url()}>{(src) => <img src={src()} alt={view()?.graph.title ?? "Diagram"} draggable={false}
        style={{ width: fit() ? "100%" : `${zoom() * 100}%`, height: "auto" }} />}</Show>
    </div>
    <div class="od-inspector">
      <h3>{view()?.graph.title}</h3><p>{view()?.graph.summary}</p>
      <label>Inspect node <select style={{ "color-scheme": props.ctx.appearance.mode() }} value={value().selected ?? ""} onChange={(event) => controller.inspect(event.currentTarget.value || undefined)}>
        <option value="">Select a node</option><For each={view()?.graph.nodes}>{(item) => <option value={item.id}>{item.label}</option>}</For>
      </select></label>
      <Show when={node()}>{(item) => <><h3>{item().label}</h3><p>{item().kind} · {item().status}</p><p>{item().detail}</p><p>{item().behavior}</p>
        <ul><For each={item().evidence}>{(id) => <li>{sources()?.find((source) => source.id === id)?.label ?? id}</li>}</For></ul></>}</Show>
    </div>
  </section>
}
