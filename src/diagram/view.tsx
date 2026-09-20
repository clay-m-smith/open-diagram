/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup } from "solid-js"
import type { BoxRenderable, ColorInput } from "@opentui/core"
import { diagramTextWidth, diagramWires, layoutDiagram } from "./layout.js"
import type { DiagramGraph } from "./schema.js"

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
  const layout = createMemo(() => layoutDiagram(props.graph, { columns: columns(), selected: props.selected, changed: props.changed,
    sourceControl: true, sources: sourcesFor() === props.selected && props.selected
      ? props.graph.nodes.find((node) => node.id === props.selected)?.evidence.map((id) => sourceCaption(sources().get(id) ?? id)) : undefined }))
  const selectionContent = createMemo(() => JSON.stringify([props.graph, props.selected]))
  createEffect(() => { selectionContent(); setSourcesFor(undefined) })
  return <box width="100%" flexDirection="column" flexShrink={0}
    onSizeChange={resize}>
    <scrollbox width="100%" height={layout().height + (layout().width > columns() ? 1 : 0)} scrollX={true} scrollY={false} flexShrink={0}
      verticalScrollbarOptions={{ visible: false }} horizontalScrollbarOptions={{ visible: layout().width > columns() }}
      contentOptions={{ width: Math.max(columns(), layout().width), minWidth: Math.max(columns(), layout().width),
        maxWidth: Math.max(columns(), layout().width), height: layout().height, minHeight: layout().height, maxHeight: layout().height }}>
    <box width={Math.max(columns(), layout().width)} height={layout().height} flexShrink={0} flexDirection="column">
    <box position="absolute" top={0} left={Math.max(0, Math.floor((columns() - layout().width) / 2))} width={layout().width} height={layout().height} flexDirection="column">
      <text position="absolute" left={0} top={0} width={layout().width} height={layout().height} selectable={false} fg={props.colors.subdued}>{diagramWires(layout())}</text>
      <For each={layout().edges}>{(edge) => <text position="absolute" left={edge.labelX} top={edge.labelY}
        width={Math.max(1, ...edge.labelLines.map(diagramTextWidth))} height={edge.labelLines.length}
        fg={props.colors.subdued} onMouseUp={(event) => {
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
