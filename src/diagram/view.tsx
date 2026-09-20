/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { parseColor, type BoxRenderable, type ColorInput, type ScrollBoxRenderable } from "@opentui/core"
import { diagramTextWidth, diagramWireRuns, layoutDiagram, type DiagramLayout, type DiagramLayoutOptions } from "./layout.js"
import { diagramArrowColor } from "./arrow-colors.js"
import type { DiagramGraph } from "./schema.js"
import { nodeEvidence } from "./notation.js"

/** Present source identities, not the operations used to collect them. */
export function sourceCaption(label: string): string {
  const clean = label.replace(/^Child \S+ · /, "")
  const parts = clean.split(" · ")
  if (/^(read|write|edit|patch|grep|glob|shell|execute|subagent)$/.test(parts[0])) {
    const path = parts.slice(1).find((part) => part && !["completed", "error"].includes(part))
    return path ? path.split(/[/\\]/).filter(Boolean).slice(-2).join("/") : "Development context"
  }
  if (/^user[: ]/i.test(clean)) return "User request"
  if (/^assistant /i.test(clean)) return "Design notes"
  return clean
}

/** Natural-height content. The native sidebar or session panel owns scrolling. */
export function CompactDiagram(props: {
  graph: DiagramGraph
  changed: readonly string[]
  sources: readonly { id: string; label: string }[]
  selected?: string
  onSelect(id: string | undefined): void
  onLayout?(nodes: DiagramGraph["nodes"]): void
  colors: { text: ColorInput; subdued: ColorInput; accent: ColorInput; border: ColorInput }
}) {
  const [columns, setColumns] = createSignal(38)
  let disposed = false
  let queued = false
  let measured = 38
  onCleanup(() => { disposed = true })
  const resize = function(this: BoxRenderable) {
    if (this.width <= 0) return
    measured = this.width
    if (queued) return
    queued = true
    // Native Yoga is traversing children during onSizeChange. Replacing routed
    // cards inside that traversal can expose removed nodes with NaN dimensions.
    queueMicrotask(() => { queued = false; if (!disposed) setColumns(measured) })
  }
  const sources = createMemo(() => new Map(props.sources.map((source) => [source.id, source.label])))
  const [sourcesFor, setSourcesFor] = createSignal<string>()
  const [solved, setSolved] = createSignal<{ graph: DiagramGraph; layout: DiagramLayout }>()
  const [working, setWorking] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const empty: DiagramLayout = { nodes: [], edges: [], width: 1, height: 1 }
  const layout = createMemo(() => solved()?.graph === props.graph ? solved()!.layout : empty)
  let pending: { graph: DiagramGraph; options: DiagramLayoutOptions } | undefined
  let running = false
  let scroll: ScrollBoxRenderable | undefined
  let reveal: string | undefined
  const renderer = useRenderer()
  const revealHorizontal = () => {
    if (reveal) { scroll?.scrollChildIntoView(`open-diagram-node-${reveal}`); reveal = undefined }
  }
  renderer.on("frame", revealHorizontal)
  onCleanup(() => { pending = undefined; renderer.off("frame", revealHorizontal) })
  const solve = async () => {
    if (running) return
    running = true
    // At most one active solve plus the latest desired layout per mounted view.
    // Rapid resize/selection cannot enqueue an unbounded series of ELK jobs.
    while (pending && !disposed) {
      const request = pending; pending = undefined
      try {
        const result = await layoutDiagram(request.graph, request.options)
        if (disposed || pending) continue
        setSolved({ graph: request.graph, layout: result })
        reveal = props.selected ?? result.nodes[0]?.node.id
        props.onLayout?.(result.nodes.map((box) => box.node))
        renderer.requestRender()
      } catch {
        if (!disposed && !pending) setProblem("Diagram layout unavailable")
      }
    }
    running = false
    if (!disposed) setWorking(false)
  }
  createEffect(() => {
    pending = { graph: props.graph, options: { columns: columns(), selected: props.selected, changed: props.changed,
      sourceControl: true, sources: sourcesFor() === props.selected && props.selected
        ? nodeEvidence(props.graph, props.selected).map((id) => sourceCaption(sources().get(id) ?? id)) : undefined } }
    setProblem(undefined); setWorking(true); void solve()
  })
  const selectionContent = createMemo(() => JSON.stringify([props.graph, props.selected]))
  createEffect(() => { selectionContent(); setSourcesFor(undefined) })
  const dark = createMemo(() => {
    const color = parseColor(props.colors.text)
    return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b > 0.5
  })
  const wires = createMemo(() => diagramWireRuns(layout()))
  return <box width="100%" flexDirection="column" flexShrink={0}
    onSizeChange={resize}>
    <Show when={working()}><box id="open-diagram-layout-pending" width={0} height={0} /></Show>
    <Show when={problem()}><text fg={props.colors.subdued}>{problem()}</text></Show>
    <Show when={!layout().nodes.length && working()}><text fg={props.colors.subdued}>Arranging diagram…</text></Show>
    <scrollbox ref={(value) => { scroll = value }} width="100%" height={layout().height + (layout().width > columns() ? 1 : 0)} scrollX={true} scrollY={false} flexShrink={0}
      verticalScrollbarOptions={{ visible: false }} horizontalScrollbarOptions={{ visible: layout().width > columns() }}
      contentOptions={{ width: Math.max(columns(), layout().width), minWidth: Math.max(columns(), layout().width),
        maxWidth: Math.max(columns(), layout().width), height: layout().height, minHeight: layout().height, maxHeight: layout().height }}>
    <box width={Math.max(columns(), layout().width)} height={layout().height} flexShrink={0} flexDirection="column">
    <box position="absolute" top={0} left={Math.max(0, Math.floor((columns() - layout().width) / 2))} width={layout().width} height={layout().height} flexDirection="column">
      <For each={layout().scene?.regions ?? []}>{(region) => <box position="absolute" left={region.x} top={region.y}
        width={region.width} height={region.height} border borderStyle="single" borderColor={props.colors.border}
        title={region.label} titleColor={props.colors.subdued} />}</For>
      <text position="absolute" left={0} top={0} width={layout().width} height={layout().height} selectable={false}>
        <For each={wires()}>{(run) => <span style={{ fg: run.tone === undefined ? props.colors.subdued : diagramArrowColor(run.tone, dark()) }}>{run.text}</span>}</For>
      </text>
      <For each={layout().scene?.texts ?? []}>{(label) => <text position="absolute" left={label.x} top={label.y}
        width={Math.max(1, diagramTextWidth(label.text))} height={1}
        fg={label.tone === undefined ? props.colors.subdued : diagramArrowColor(label.tone, dark())}
        onMouseUp={(event) => { if (event.button === 0 && label.node) { event.stopPropagation(); props.onSelect(label.node) } }}>{label.text}</text>}</For>
      <For each={layout().edges}>{(edge) => <text position="absolute" left={edge.labelX} top={edge.labelY}
        width={Math.max(1, ...edge.labelLines.map(diagramTextWidth))} height={edge.labelLines.length}
        fg={diagramArrowColor(edge.tone, dark())} onMouseUp={(event) => {
          if (event.button !== 0) return
          event.stopPropagation(); props.onSelect(edge.to)
        }}>{edge.labelLines.join("\n")}</text>}</For>
    <For each={layout().nodes}>{(block) =>
      <box id={`open-diagram-node-${block.node.id}`} position="absolute" left={block.x} top={block.y}
        width={block.width} height={block.height} border borderStyle="rounded" flexDirection="column" paddingLeft={1} paddingRight={1}
        borderColor={props.changed.includes(block.node.id) ? props.colors.accent
          : props.selected === block.node.id ? props.colors.text : props.colors.border}
        onMouseUp={(event) => {
          if (event.button !== 0) return
          event.stopPropagation()
          props.onSelect(props.selected === block.node.id ? undefined : block.node.id)
        }}>
        <For each={block.lines}>{(line) => <text height={1} flexShrink={0}
          fg={line.role === "label" || line.role === "detail" ? props.colors.text : props.colors.subdued} onMouseUp={(event) => {
            if (line.role !== "sources") return
            if (event.button !== 0) return
            event.stopPropagation()
            setSourcesFor(sourcesFor() === block.node.id ? undefined : block.node.id)
          }}>{line.text}</text>}</For>
      </box>
    }</For>
    </box></box></scrollbox>
  </box>
}
