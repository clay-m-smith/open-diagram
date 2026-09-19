import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { execFileSync, spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

/** A private, authenticated V2 service; never touches the user's shared service. */
export async function withV2Runtime(run) {
  const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim().match(/^opencode v(2\.0\.(\d+)(?:[-+][\w.-]+)?)$/)
  if (!version || Number(version[2]) < 7) throw new Error("Runtime tests require OpenCode >=2.0.7 <2.1.0 on PATH")
  const temporary = await mkdtemp(join(tmpdir(), "open-diagram-v2-"))
  const file = join(temporary, "XDG_STATE_HOME", "opencode", "service.json")
  const previous = { ...process.env }
  let child
  let exited = false
  let spawnError
  let exit
  const lifecycle = { stopped: false }
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE_")) delete process.env[key]
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      process.env[key] = join(temporary, key)
      await mkdir(process.env[key])
    }
    // Own the exact process even before it writes a registration. Service.ensure
    // can leave detached startup contenders that its public API cannot cancel.
    child = spawn("opencode", ["serve", "--service", "--port", "0"], { stdio: "ignore" })
    exit = new Promise((resolve) => {
      child.once("exit", () => { exited = true; resolve() })
      child.once("error", (error) => { spawnError = error; exited = true; resolve() })
    })
    let endpoint
    const startupDeadline = Date.now() + 10_000
    while (!endpoint && Date.now() < startupDeadline) {
      if (exited) throw spawnError ?? new Error("Private service exited during startup")
      endpoint = await Service.discover({ file, version: version[1] })
      if (!endpoint) await setTimeout(100)
    }
    if (!endpoint) throw new Error("Private service startup timed out")
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    return await run(client, { temporary, endpoint, lifecycle })
  } catch (error) {
    const log = await readFile(join(temporary, "XDG_DATA_HOME", "opencode", "log", "opencode.log"), "utf8").catch(() => "")
    if (log) console.error(log.split("\n").filter((line) => /level=(ERROR|WARN)/.test(line)).join("\n"))
    throw error
  } finally {
    try {
      try { if (child) await Service.stop({ file }) } finally {
        // Registration may be absent or shutdown may have failed. Never lose
        // ownership of the process we spawned, and never kill unrelated PIDs.
        if (child && !exited) {
          child.kill("SIGTERM")
          await Promise.race([exit, setTimeout(1_000)])
          if (!exited) {
            child.kill("SIGKILL")
            await Promise.race([exit, setTimeout(1_000)])
          }
          if (!exited) throw new Error("Owned private service did not exit")
        }
      }
      lifecycle.stopped = true
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
      Object.assign(process.env, previous)
      if (!child || exited) await rm(temporary, { recursive: true, force: true })
    }
  }
}

export async function waitForPlugin(client, location, id = "open-diagram-server") {
  await client.location.get({ location })
  let plugins
  for (let attempt = 0; attempt < 100; attempt++) {
    plugins = (await client.plugin.list({ location })).data
    const plugin = plugins.find((plugin) => plugin.id === id)
    if (plugin?.state.status === "active") return plugin
    if (plugin && ["error", "failed"].includes(plugin.state.status)) throw new Error(JSON.stringify(plugin))
    await setTimeout(100)
  }
  throw new Error(`${id} did not activate: ${JSON.stringify(plugins.filter((plugin) => plugin.source.type !== "builtin"))}`)
}
