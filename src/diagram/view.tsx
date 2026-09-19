/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import type { ColorInput } from "@opentui/core"
import { layoutDiagram, type DiagramLink } from "./layout.js"
import type { DiagramGraph } from "./schema.js"

export function compactLink(edge: DiagramLink): string {
  return edge.text.replace(" ──▶ ", " → ").replace(" · ↺ cycle", " ↺").replace(" · ", " ")
}

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
  const blocks = createMemo(() => layoutDiagram(props.graph))
  const sources = createMemo(() => new Map(props.sources.map((source) => [source.id, source.label])))
  const [sourcesFor, setSourcesFor] = createSignal<string>()
  const selectionContent = createMemo(() => JSON.stringify([props.graph, props.selected]))
  createEffect(() => { selectionContent(); setSourcesFor(undefined) })
  return <box width="100%" flexDirection="column" flexShrink={0}>
    <For each={blocks()}>{(block) => <box flexDirection="column" flexShrink={0}>
      <box id={`open-diagram-node-${block.node.id}`} border borderStyle="rounded" flexDirection="column" flexShrink={0}
        borderColor={props.changed.includes(block.node.id) ? props.colors.accent
          : props.selected === block.node.id ? props.colors.text : props.colors.border}
        onMouseUp={(event) => {
          if (event.button !== 0) return
          event.stopPropagation()
          props.onSelect(props.selected === block.node.id ? undefined : block.node.id)
        }}>
        <text fg={props.colors.text}>{`[${block.number}] ${block.node.label}${block.node.status === "planned" ? " ~" : ""}${props.changed.includes(block.node.id) ? " *" : ""}`}</text>
        <Show when={props.selected === block.node.id}>
          <text fg={props.colors.subdued}>{`${block.node.kind} · ${block.node.status}`}</text>
          <Show when={block.node.detail}><text fg={props.colors.text}>{block.node.detail}</text></Show>
          <Show when={block.node.behavior}><text fg={props.colors.text}>{block.node.behavior}</text></Show>
          <text fg={props.colors.subdued} onMouseUp={(event) => {
            if (event.button !== 0) return
            event.stopPropagation()
            setSourcesFor(sourcesFor() === block.node.id ? undefined : block.node.id)
          }}>{sourcesFor() === block.node.id ? "[Hide sources]" : "[Sources]"}</text>
          <Show when={sourcesFor() === block.node.id}>
            <For each={block.node.evidence}>{(id) => <text fg={props.colors.subdued}>{sourceCaption(sources().get(id) ?? id)}</text>}</For>
          </Show>
        </Show>
      </box>
      <For each={block.outgoing}>{(edge) => <text fg={props.colors.subdued} onMouseUp={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        props.onSelect(edge.to)
      }}>{compactLink(edge)}</text>}</For>
    </box>}</For>
  </box>
}
