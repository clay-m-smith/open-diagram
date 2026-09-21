import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("native cancellation stops provider work before queued diagrams proceed", { timeout: 30000 }, () => {
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/test-diagram-cancellation.mjs"], { env, encoding: "utf8", timeout: 25000 })
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /native timeout closes provider socket and releases queued successor/)
  assert.match(result.stdout, /native repair shares deadline and reports its stage/)
  assert.match(result.stdout, /native citation-only repair publishes fully validated diagram/)
  assert.match(result.stdout, /native Pause cancels active provider work without a spurious timeout/)
})

test("live diagrams follow actual OpenCode V2 prompt and native edit hooks through RPC", { timeout: 65_000 }, () => {
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env
  const result = spawnSync(process.execPath, ["--conditions=browser", "--import", "tsx", "scripts/test-live-diagram.mjs"], { env, encoding: "utf8", timeout: 60_000 })
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /actual OpenCode TUI loaded standalone bridge/)
  assert.match(result.stdout, /actual host expanded block keeps description and shows functional explanation/)
  assert.match(result.stdout, /actual host Sources click exposes file reference without tool-call logs/)
  assert.match(result.stdout, /native PNG\/SVG\/Save exports cached view with zero diagram-model calls/)
  assert.match(result.stdout, /actual expanded and fullscreen SVG clicks export the active cached diagram/)
  assert.match(result.stdout, /actual native PNG action sends image\/png to clipboard adapter/)
  assert.match(result.stdout, /actual host Granular control generates individual layers and observed parameters/)
  assert.match(result.stdout, /native storage restored graph and paused mode/)
  assert.match(result.stdout, /attached native TUI recovers cached layers after plugin reload without Refresh/)
  assert.match(result.stdout, /native cache serves session revisits and 16 idle seconds without RPC\/model calls; reconnect reads once/)
  assert.match(result.stdout, /native durable fingerprints make unchanged Refresh and cached depth switches zero-model operations/)
  assert.match(result.stdout, /main-agent chat and progress cause zero diagram-model calls/)
  assert.match(result.stdout, /native source edit authors only dependent view with reduced evidence and preserves unrelated view/)
  assert.match(result.stdout, /auto-enabled main-agent snapshot\/publication adds zero secondary model calls/)
  assert.match(result.stdout, /actual native TUI retains cached layers beside failed-update warning/)
  assert.match(result.stdout, /native failed update preserves ready cached views; explicit changed-input retry recovers/)
  assert.match(result.stdout, /changed architecture; primary routing preserved; pause and location isolation/)
})

test("any model can discover and execute diagram tools through native Code Mode", { timeout: 40000 }, () => {
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/test-diagram-tools.mjs"], { env, encoding: "utf8", timeout: 35000 })
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /native host exposes and executes snapshot -> publish tools/)
  assert.match(result.stdout, /auto-enabled native Code Mode snapshot reserves new evidence through delayed publication with zero secondary calls/)
})

test("native RPC exposes actionable capacity failure without blocking pause", { timeout: 30000 }, () => {
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/test-diagram-capacity.mjs"], { env, encoding: "utf8", timeout: 25000 })
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /native RPC preserves capacity error type, retry message and saved mode/)
})
