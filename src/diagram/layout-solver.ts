import { createRequire } from "node:module"
import { Worker } from "node:worker_threads"
import type { ElkNode } from "elkjs/lib/elk-api.js"

const require = createRequire(import.meta.url)
const jobs = new Map<number, { resolve(value: ElkNode): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
let worker: Worker | undefined
let idle: ReturnType<typeof setTimeout> | undefined
let sequence = 0

/** Isolate ELK from OpenTUI's window shim and keep layout off the render thread. */
export function solveLayout(graph: ElkNode): Promise<ElkNode> {
  clearTimeout(idle)
  if (!worker) {
    const next = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads")
      // Bun exposes self even in node:worker_threads. Select ELK's CommonJS
      // adapter, not its browser-worker branch, in this owned worker only.
      globalThis.document = {}
      const ELK = require(workerData)
      const elk = new ELK({ algorithms: ["layered"] })
      parentPort.on("message", async ({ id, graph }) => {
        try { parentPort.postMessage({ id, graph: await elk.layout(graph) }) }
        catch { parentPort.postMessage({ id, error: "Diagram layout failed" }) }
      })
    `, { eval: true, workerData: require.resolve("elkjs/lib/elk.bundled.js"), execArgv: [] })
    worker = next
    next.on("message", (message: { id: number; graph: ElkNode; error?: string }) => {
      if (worker !== next) return
      const job = jobs.get(message.id)
      if (!job) return
      jobs.delete(message.id); clearTimeout(job.timer)
      if (message.error) job.reject(new Error(message.error)); else job.resolve(message.graph)
      if (!jobs.size) {
        next.unref()
        idle = setTimeout(() => stop(next, new Error("Diagram layout idle")), 30_000)
        idle.unref()
      }
    })
    next.on("error", (error) => stop(next, new Error(`Diagram layout worker failed: ${error.message}`)))
    next.on("exit", () => stop(next, new Error("Diagram layout worker exited")))
  }
  const active = worker
  active.ref()
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => stop(active, new Error("Diagram layout timed out")), 10_000)
    jobs.set(id, { resolve, reject, timer })
    try { active.postMessage({ id, graph }) }
    catch { stop(active, new Error("Diagram layout request failed")) }
  })
}

function stop(active: Worker, error: Error) {
  if (worker !== active) return
  worker = undefined; clearTimeout(idle)
  for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(error) }
  jobs.clear()
  void active.terminate()
}
