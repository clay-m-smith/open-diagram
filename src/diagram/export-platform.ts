import { spawn } from "node:child_process"
import { open, link, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"

/** Publish a complete file without following or replacing an existing target. */
export async function saveDiagramFile(path: string, bytes: Uint8Array | string, signal: AbortSignal) {
  signal.throwIfAborted()
  const temporary = join(dirname(path), `.open-diagram-${randomUUID()}.tmp`)
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(bytes)
    await file.close()
    signal.throwIfAborted()
    // link is atomic and exclusive: even a destination created during a dialog
    // cannot be overwritten, and a failed write never exposes a partial export.
    await link(temporary, path)
  } finally {
    await file.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}

/** Optional existing Linux image clipboard tools; never install or use a shell. */
export type ClipboardCopyResult = { copied: true } | { copied: false; reason: string }
export async function copyDiagramImage(bytes: Uint8Array, mime: "image/png" | "image/svg+xml", signal: AbortSignal, remote = false): Promise<ClipboardCopyResult> {
  if (process.platform !== "linux") return { copied: false, reason: "Image clipboard is not supported on this platform; save the diagram instead." }
  const ssh = remote || !!(process.env.SSH_CONNECTION || process.env.SSH_TTY)
  // A configured X11 DISPLAY may be forwarded to the user's desktop. SSH alone
  // is not a reason to reject it. Wayland host copying stays local-only.
  const commands = [
    ...(!ssh && process.env.WAYLAND_DISPLAY ? [["wl-copy", "--type", mime]] : []),
    ...(process.env.DISPLAY ? [["xclip", "-selection", "clipboard", "-t", mime, "-i"]] : []),
  ]
  let result: ClipboardCopyResult = { copied: false, reason: ssh
    ? "TUI has no forwarded DISPLAY. Start OpenCode from an ssh -X session, or save the diagram."
    : "TUI has neither DISPLAY nor WAYLAND_DISPLAY; save the diagram instead." }
  for (const [command, ...args] of commands) {
    signal.throwIfAborted()
    result = await new Promise<ClipboardCopyResult>((resolve) => {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] })
      let settled = false
      const done = (result: ClipboardCopyResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", cancel)
        resolve(result)
      }
      const cancel = () => { child.kill("SIGKILL"); done({ copied: false, reason: `${command} clipboard transfer ${signal.aborted ? "cancelled" : "timed out"}; save the diagram instead.` }) }
      const timer = setTimeout(cancel, 3000)
      timer.unref?.()
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
      child.once("error", (error) => done({ copied: false, reason: "code" in error && error.code === "ENOENT"
        ? `${command} is not installed or not on the TUI PATH. Install it, then retry Copy.`
        : `${command} could not start; check the clipboard helper or save the diagram.` }))
      child.once("exit", (code) => done(code === 0 ? { copied: true }
        : { copied: false, reason: `${command} failed (exit ${code ?? "signal"}). Check the TUI display/Xauthority connection, or save the diagram.` }))
      child.stdin.on("error", () => {})
      child.stdin.end(bytes)
    })
    signal.throwIfAborted()
    if (result.copied && command === "xclip") {
      // xclip forks: its parent's zero exit does not prove the selection owner
      // survived. Read format metadata only, never the user's clipboard payload.
      const offered = await x11OffersImage(mime, signal)
      signal.throwIfAborted()
      if (!offered) result = { copied: false, reason: `xclip did not offer ${mime} on DISPLAY=${process.env.DISPLAY}. Check X11 clipboard access or save the diagram instead.` }
    }
    if (result.copied) return result
  }
  return result
}

function x11OffersImage(mime: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("xclip", ["-selection", "clipboard", "-out", "-target", "TARGETS"], { stdio: ["ignore", "pipe", "ignore"] })
    let settled = false
    let output = ""
    const done = (offered: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", cancel)
      child.stdout.destroy()
      resolve(offered)
    }
    const cancel = () => { child.kill("SIGKILL"); done(false) }
    const timer = setTimeout(cancel, 3000)
    timer.unref?.()
    child.once("error", () => done(false))
    child.stdout.on("error", () => cancel())
    child.stdout.on("data", (data: Buffer) => {
      if (output.length + data.length > 16_384) { cancel(); return }
      output += data.toString("utf8")
    })
    child.once("close", (code) => done(code === 0 && output.split(/\r?\n/).includes(mime)))
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
  })
}
