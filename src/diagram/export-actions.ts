import { resolve, extname } from "node:path"
import type { DiagramGraph } from "./schema.js"
import { renderDiagramPNG, renderDiagramSVG } from "./export.js"
import { saveDiagramFile, type ClipboardCopyResult } from "./export-platform.js"

export type ExportAction = "png" | "svg" | "save"
export type ExportHost = {
  directory: string
  chooseFormat(): Promise<"png" | "svg" | undefined>
  choosePath(value: string, format: "png" | "svg", fallback: boolean, reason?: string): Promise<string | undefined>
  copySVG(text: string, signal: AbortSignal): Promise<ClipboardCopyResult>
  copyPNG(bytes: Uint8Array, signal: AbortSignal): Promise<ClipboardCopyResult>
  notify(message: string, kind: "success" | "warning" | "error"): void
}

/** Snapshot at click time; no collection, Refresh, RPC, or model dependency. */
export function createDiagramExportActions(host: ExportHost, signal: AbortSignal) {
  let busy = false
  return async (action: ExportAction, graph?: DiagramGraph, selected?: string): Promise<void> => {
    if (busy || signal.aborted) return
    if (!graph) { host.notify("No cached diagram to export", "warning"); return }
    const snapshot = structuredClone(graph)
    busy = true
    try {
      const format = action === "save" ? await host.chooseFormat() : action
      if (!format || signal.aborted) return
      const bytes = format === "svg" ? renderDiagramSVG(snapshot, { selected }) : await renderDiagramPNG(snapshot, { selected })
      if (signal.aborted) return
      let reason: string | undefined
      if (action !== "save") {
        const copied = format === "svg" ? await host.copySVG(bytes as string, signal) : await host.copyPNG(bytes as Uint8Array, signal)
        if (signal.aborted) return
        if (copied.copied) {
          host.notify(`${format.toUpperCase()} copied to image clipboard${format === "svg" ? "; paste into an SVG-capable app" : ""}`, "success")
          return
        }
        reason = copied.reason
      }
      const name = snapshot.title.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "diagram"
      const path = await host.choosePath(resolve(host.directory, `${name}.${format}`), format, action !== "save", reason)
      if (!path || signal.aborted) return
      const destination = resolve(host.directory, path)
      if (extname(destination).toLowerCase() !== `.${format}`) throw new Error(`Choose a .${format} filename`)
      await saveDiagramFile(destination, bytes, signal)
      if (!signal.aborted) host.notify(`Saved ${format.toUpperCase()}: ${destination}`, "success")
    } catch (error) {
      if (!signal.aborted) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined
        host.notify(code === "EEXIST" ? "File already exists; choose another name. Nothing overwritten."
          : error instanceof Error && /^Choose a \./.test(error.message) ? error.message
          : "Diagram export failed; check destination permissions or try SVG Save", "error")
      }
    } finally { busy = false }
  }
}
