# Open Diagram

Live block diagrams for OpenCode V2 (>=2.0.7 <2.1.0). Infer useful structures from ongoing
development: model internals, systems, repositories, workflows, protocols, and
more. Mixed projects get separate view tabs instead of one flattened diagram.

The default surface is OpenCode's compact native sidebar. Select **Sidebar** to
restore its original contents. Blocks show labels and directed links; select a
block for its description and functional explanation. **Sources** reveals compact
file references separately, without tool-call logs. `*` marks changes; `~` marks planned blocks;
`↺` marks cycle edges. The host owns scrolling, sidebar visibility, and resizing.
Server snapshots preserve every view and tracking mode across reloads.
Viewing is cache-only: there is no periodic polling or evidence collection on
view/session-tab changes. The TUI keeps the last 64 visited sessions in memory,
updates them from server events, and reconciles snapshots after reconnect or
plugin reload. **Refresh** recollects evidence, reuses matching accepted output,
and retries a failed changed-input update; it does not rebuild a working diagram
when nothing meaningful changed. Paused sessions refresh evidence without inference.
Accepted Overview and Granular diagrams have separate durable content-keyed caches.
Depth switches reuse matching output, including after reload. Development hooks
coalesce meaningful source changes; chat, timestamps, message ordering, progress
prose and shell logs do not invalidate a source-backed diagram. Request-only
sessions still track requests. Known changed
dependencies update only affected views with a smaller evidence packet; new or
removed dependencies conservatively request broader analysis. Unaffected views
remain byte-for-byte unchanged. An update failure leaves the last-good diagram
visible with a separate warning, without automatic same-input retries. Empty
context is not treated as deletion. A never-generated session stays empty until
development activity, a main-agent publication, or Refresh.

Choose **Depth → Granular** (or `/open-diagram granular`) for layer/operation-level
views with observed parameters, tensor dimensions, and internal branches. Use
**Overview** (or `/open-diagram overview`) to return to architectural blocks.
Depth is saved per session and changing it never resumes paused tracking.
Granular diagrams can only show internals present in session evidence: ask your
agent to inspect the actual model, algorithm, and configuration files when needed.

## Load locally

Requires Node >=22 and OpenCode >=2.0.7 <2.1.0. Install dependencies with
`npm install`, then add this repository's absolute path to `plugins` in the target
project's `opencode.json`:

```json
{
  "plugins": [{
    "package": "/absolute/path/to/open-diagram",
    "options": {
      "backend": "opencode",
      "providerID": "openai",
      "model": "gpt-5.6-luna"
    }
  }]
}
```

The package exports its server at `.` and TUI at `./tui`. OpenCode loads the TUI
entry alongside the server. This example explicitly selects a separately billed
diagram model; use a model available through your OpenCode provider. It never
changes the chat model, agent, or worker routing. Installing the bare package
without backend options defaults to **manual** generation, with no paid fallback.

## Controls

- `/open-diagram` — select diagram tabs; native sidebar visibility remains a host preference.
- `/open-diagram panel` — open the resizable panel; drag its divider to resize.
- `/open-diagram fullscreen` — fullscreen graph, with the same view tabs.
- `/open-diagram sidebar` or `close` — return to native sidebar contents.
- `/open-diagram auto|on|off|refresh|pause|resume` — tracking controls.
- In a focused panel: `j/k` select blocks, `f` fullscreen, `p` pause/resume,
  `r` refresh, `Escape` return to Sidebar.

Narrow terminals use the host's sidebar overlay; child sessions have no native
sidebar, so `/open-diagram` opens the panel there. No private host layout state is
modified. The panel's short resize hint appears only outside fullscreen.
Diagram colors use the host theme, supporting both the original 2.0.7 tokens
and the newer `base`/`muted` RGBA tokens without changing user theme settings.

### Copy and save

The **[PNG] [SVG] [Save]** row exports the full active cached diagram, not a
terminal screenshot. It includes node labels, directed links, and the selected
block's displayed details; it excludes controls, tabs, status, and Sources UI.
Stale but valid cached diagrams remain exportable. Export never calls a model.

- **SVG** copies a vector image using `image/svg+xml`, not plain-text markup.
  Paste into an SVG-capable application; PNG is more widely supported.
- **PNG** copies a raster image using `image/png`. Both copy actions work on
  Linux with an existing `wl-copy` (local Wayland) or
  `xclip` (X11, including an SSH-forwarded `DISPLAY`). SSH alone is not a blocker;
  the TUI process must inherit a working display and have `xclip` on PATH. Local
  terminal click-drag text selection does not establish image clipboard access.
  X11 copy checks that the requested image format is offered on that display;
  it does not read clipboard contents or prove that a destination app pasted it.
  Missing helpers, failed display connections, and missing image formats offer
  an actionable Save fallback. After reconnecting SSH, launch the TUI from the
  new connection so it inherits the new `DISPLAY`.
  Unsupported environments offer a save dialog, never raw markup disguised as
  an image copy. No utility is installed automatically.
- **Save** chooses PNG or SVG and a filename on the computer running the TUI.
  Existing files and symlinks are never overwritten; choose another filename.

PNG rendering loads `@resvg/resvg-js` only on demand and uses available system
fonts. SVG remains editable/scalable; font availability can affect glyph rendering.

## Models and tools

Any model can author diagrams using `open_diagram_snapshot` followed by
`open_diagram_publish`. The tools bind to the invoking session, validate current
citations, reject stale snapshots, and persist accepted views. They do not edit
source files or execute generated output. Tool permissions use those same names.

See [the public harness](docs/harness.md) for prompt/schema exports, authenticated
RPC, backend configuration, and evidence boundaries. For a local service:

```json
{"backend":"openai-compatible","baseURL":"http://127.0.0.1:8082/v1","model":"bonsai2-27b","enableThinking":false,"cachePrompt":false}
```

Endpoint mode uses JSON Schema by default; set `responseFormat: "json-object"`
for endpoints without schema support. Remote endpoints require `allowRemote:
true`; API keys come from the environment variable named by `apiKeyEnv`.
OpenCode-backed generation uses its configured provider credentials and trust
boundary. Both automatic modes send bounded public session excerpts to the
selected model. Avoid reading secrets into sessions used for automatic diagrams.

Source reads and current requests reserve evidence space ahead of later logs.
Selection is bounded, not exhaustive repository analysis. Diagrams are model
interpretations, not proof of correctness. Failed updates retain the last graph
with visible stale/error status; automatic retries require changed evidence or
Refresh. Source excerpts are transient, while graph text and citation labels are
stored in this plugin's location-scoped storage. The standalone namespace does not
read or migrate the original proof-of-concept plugin's private storage.
Collection outages mark retained graphs stale until a successful context read.
Unreadable persistence blocks initialization rather than replacing a saved pause
or graph with writable defaults; the next access retries hydration.

## Development

- `npm run typecheck` — TypeScript checks.
- `npm test` — core, server, TUI monitor, and isolated runtime tests.
- `npm run verify` — typecheck and tests.

Runtime tests require `opencode` and `python3` on PATH and use a private service
with fixture model responses. The native OpenTUI renderer test requires Node
>=26.4 with `--experimental-ffi`; it skips on older Node versions.

`npm pack --dry-run` checks package contents. The package exposes `./harness` and
`./rpc` alongside native plugin entrypoints. Tests use isolated fixture services;
they never call real paid models or alter the shared service.
