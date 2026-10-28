# Set up the OpenCode plugin and choose a model

This guide covers the **OpenCode integration**. For other AI clients or services,
use the [standalone MCP and Node API guide](standalone.md): Node.js 22+, no OpenCode
process, no secondary model, client-authored diagrams, and local memory-only
storage. Both paths share the graph schemas and SVG/PNG renderers, but not the
same session, persistence, or authoring controls.

Open Diagram targets **OpenCode 2.2.0** (`>=2.2.0 <3`), not an OpenCode V1
extension. Node.js 22+ is required for the repository tools. Use a supported
OpenCode 2.x installation; no downgrade to the dependency version in this
repository is required. Dependency pins and `package-lock.json` make builds
reproducible; `engines.opencode` describes the host compatibility range.
Native authoring and SVG RPC have isolated real-host checks on 2.2.0. Desktop
panel loading and rendering were also observed. The admitted host range does not
certify every later release.

OpenCode supplies `@opencode/plugin` and `effect` at runtime through peer
dependencies. Local development pins `@opencode/client`, `@opencode/plugin`, and
`@opencode/schema` to **2.2.0**, with **Effect 4.0.1** and **OpenTUI 0.7.0** peers.
Keep SDK, schema, OpenTUI, and development pins aligned with the host-provided
runtime rather than mixing older prerelease APIs. Use only public Effect subpaths. See the host's
[Effect plugin guidance](https://opencode.ai/v2/docs/build/plugins/effect).

## 1. Install from this repository

```sh
git clone https://github.com/clay-m-smith/open-diagram.git
cd open-diagram
npm ci
npm run build
pwd
```

This is the supported install path today. The package is currently marked
`private: true`; do not assume `npm install open-diagram` installs this project.
For future registry distribution, see [publishing](publishing.md).

### Desktop discovery versus project server configuration

The build produces the prebuilt CommonJS GUI export
`open-diagram/gui-experimental` at `dist/gui-experimental.cjs`. Desktop uses an
experimental GUI plugin API; no Electron main-process addition is needed for
this first panel. For local GUI work, run `npm run dev:gui` in the checkout:
rebuilds hot reload the GUI plugin in every Desktop window.

Desktop discovers GUI plugins through its **own background server**, using the
**global** `opencode.json` or `opencode.jsonc` (normally under
`~/.config/opencode/`). A project-only entry does not provide Desktop GUI
discovery. To enable Desktop, merge this entry into the global `plugins` array;
keep all other plugins and settings intact:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/to/open-diagram",
    "options": { "backend": "manual" }
  }]
}
```

Use the checkout's absolute path, not the target project's path. On Windows,
forward slashes avoid JSON backslash escaping. One package supplies server, TUI,
and GUI parts under plugin ID `open-diagram-server`; do not add separate entries
for its entrypoints. Server/plugin configuration belongs in `opencode.json(c)`,
not `cli.json`.

Global registration can activate the server plugin in other projects too. Keep
**`backend: "manual"` globally**: installation must not opt unrelated projects
into paid authoring. To enable automation, explicitly override this same package's
options in the **target project's** `opencode.json(c)`, preserving unrelated
entries and settings. The examples below describe those project-scoped options,
not replacement global configurations.

The selected session's server must load the server plugin as well. For a separate
or remote server, install/configure the checkout on that server; discovering the
GUI locally does not auto-install server code remotely. For **TUI-only** use,
merge the entry into the target project's `opencode.json(c)` instead; no global
Desktop registration is needed.

## 2. Decide who authors diagrams

| Authoring path | Use it when… | Setup |
| --- | --- | --- |
| Active agent | You want explicit publication using your current chat model, without a secondary author | [Manual mode](#a-use-the-active-agent-manual-mode) |
| Dedicated OpenCode model | You want automatic updates with independent provider/model/variant selection | [OpenCode backend](#b-use-a-dedicated-model-through-opencode) |
| Compatible endpoint | You already serve a local model or want a direct remote API connection | [Endpoint backend](#c-use-an-openai-compatible-endpoint) |

Configure one backend in the plugin's `options`. These are alternatives, not a
fallback chain. Your chat and worker model choices stay unchanged.

### A. Use the active agent: manual mode

Keep `backend: "manual"`. Ask the current agent to inspect the relevant sources
and use the snapshot/publish tools described below. The plugin will not start a
secondary model request. Your normal agent may still incur its usual model costs.

This is also the default when you supply no backend-related options. Manual mode
does not automatically turn into paid generation when the graph is empty.

### B. Use a dedicated model through OpenCode

1. In the **target project**, use OpenCode's `/connect` to connect your provider,
   or run `opencode auth login` interactively. Credentials stay with OpenCode.
2. Run `opencode models` from that project to inspect available provider/model
   IDs. The `/models` picker also shows available models, but selecting one there
   changes the **chat session**, not this plugin's configured diagram model.
3. Copy the IDs into the plugin's `options`, replacing the manual settings.
   This example selects **GPT-6 Luna** through OpenAI (`openai/gpt-6-luna`):

    ```json
    {
      "$schema": "https://opencode.ai/config.json",
      "plugins": [{
       "package": "/absolute/path/to/open-diagram",
       "options": {
         "backend": "opencode",
         "providerID": "openai",
         "model": "gpt-6-luna"
       }
     }]
   }
   ```

   Use this pair only when it appears in your target project's catalog; otherwise
   substitute the provider/model you connected. Installation still defaults to
   manual authoring until you explicitly configure an automatic backend.

4. If the catalog displays `provider/model`, split at the **first** slash:
   `providerID` is the provider; `model` is everything after it. A model ID can
   itself contain slashes. Do not put the full provider-qualified identifier into
   `model`, and do not use its friendly display name.
5. To select a supported variant, add a separate `variant` field using its exact
   catalog name. Do not append `#variant` to `model` in plugin options. Variant
   names are model-specific; omit the field when unsure.
6. Reload and verify as described in steps 3 and 4 below.

There is no universal best diagram model. Start with a responsive model that
reliably submits structured tool arguments, then inspect the results against real sources.
For unfamiliar HDL, firmware, or circuit work, prioritize domain understanding
and accurate citations over speed. Smaller models may need narrower evidence and
less granular views. No model is certified here for electrical correctness.

These settings affect **only** diagram generation. They do not change OpenCode's
top-level `model`, current chat, agent, or worker routing. The native adapter uses
stock OpenCode V2 session and tool APIs with this explicit provider/model/variant;
no patched OpenCode build is required. Native draft authoring defaults to **8
model steps** within the **original `timeoutMs` deadline** (default 90000 ms),
including in-place validation repair. It does not retry transport failures or
switch providers. No step restarts the clock. Set `authorSteps` (integer 1–32) in
plugin options to tune the bound; higher values can increase model usage. A
remaining-step countdown encourages composing edits with commit, and the final
step explicitly asks for commit rather than another inspection-only round trip.

<details>
<summary><strong>Native authoring internals: drafts, reuse, validation, and cancellation</strong></summary>

The managed author edits a **private canonical draft**, composing these primitive
tools through native **Code Mode** rather than returning one full tuple result:

- `open_diagram_draft_inspect`: inspect draft, evidence aliases, and remaining budget.
- `open_diagram_draft_view`: set view metadata, explicit new-node defaults, or reason.
- `open_diagram_draft_node` / `open_diagram_draft_edge`: add or update graph records.
- `open_diagram_draft_notation`: edit typed notation fields or records.
- `open_diagram_draft_remove`: remove views, nodes, edges, or notation records.
- `open_diagram_draft_validate`: check without publishing or locking the draft.
- `open_diagram_draft_commit`: validate and submit the complete canonical result.

Only the active managed sidecar can execute these tools; their registered names
may still be discoverable in other sessions, where calls are rejected. File,
shell and unrelated tool calls are denied for the managed author.
**Network limitation:** instructions prohibit network use, but OpenCode 2.2.0's
native Code Mode `fetch()` can reach the network despite session deny rules.
This integration accepts that native capability; it does not claim network
isolation. Keep automatic authoring disabled when enforceable isolation is required.
Edits can temporarily leave incomplete records or dangling references. Failed
validation or commit returns issues and keeps the draft editable for in-place
repair. Commit must pass complete schema, reference, notation, citation, allowed
view, and node-budget validation. Explicit defaults seed new nodes only; citations
are not guessed. The draft is bounded to **256 mutations** and **128 KiB**, with
by default **8 model steps** (`authorSteps`) sharing the original deadline. These are model-step
and draft limits, not a two-tool-call limit.

A successful commit finishes its tool, then stops the next model dispatch without
a follow-up narration call; later edits/commits are rejected. The managed session
may end as `interrupted` because continuation was stopped. Failed or uncommitted
drafts never replace the last accepted diagram. GUI read/render/save uses accepted
output and adds no model call.

**Legacy compatibility fallback only:** the internal `open_diagram_result` and
bounded targeted/full-result repair machinery remain available for older result
requests, including compact tuple drafts and incremental shorthand. They are not
the current primitive native authoring workflow. Public/manual publication and
endpoint JSON Schemas, runtime validators, stored graphs, and exports are unchanged.
One reusable **Diagram author (managed)** session is retained per location. It uses
the stock `general` agent without modifying its definition, and may appear in the
session list. Do not use it as a chat session. Each request replaces model context
with current bounded evidence; source packets are not added to its transcript.
Normal OpenCode session storage can retain submitted diagram arguments and usage.
The plugin interrupts and drains each run, including on Pause or unload; it does
not require a local-service connection or delete sessions through a private API.
Fingerprint metadata and absolute timestamps stay out of the model prompt; evidence
text, source identities and relative observation order are preserved. Cold requests
include only identity/topology hints from a prior diagram, not its old descriptions.
When material sources exist, native requests use the same material boundary as
the cache plus the active meaningful parent request, rather than resending progress summaries
and unrelated command output. Source-associated mutation records remain included;
request-only/non-code sessions keep their full evidence path.
Legacy fallback repair receives safe field-level validation details, including exact code-owned
notation rules. Invalid tab labels, prose lengths, and draft defaults use an exact-field
repair when all other constraints pass a diagnostic probe. Only model-supplied
replacements enter the result; defaults are never truncated or guessed. Text-only
repairs omit source packets and valid graph content. Full validation still runs
after expansion and merge. Local reason/node/notation faults return only affected replacements
instead of regenerating the diagram. Reference checks run before selecting repair
scope so malformed node fields cannot hide broken port owners or missing links.
When only a node's evidence field is missing or replaced by one misnamed array of
current citation IDs, repair asks for citation arrays only and preserves every
other node field. The model must supply those citations explicitly; the server
does not guess them. Ambiguous extra fields still require full node replacement.
When architecture groups and ports are valid, only bad or missing link records
are requested; valid links are retained instead of regenerated.
Every requested replacement must appear exactly once, retain its node ID or
notation family, and pass complete graph, relationship, budget, and citation validation
after merging. Other failures still use one complete-output repair; invalid output
never becomes an accepted diagram merely because it was called a repair.
JSON failures expose only a fixed syntax category and character count (plus a
numeric parser offset when available), never the parser's raw response excerpt.
In the legacy fallback, known source edits use incremental authoring even when they affect the only view
or every existing view. The model can reference unchanged nodes and omit
unchanged graph fields instead of reprinting cached descriptions, edges and notation.
An existing node object may contain only its ID and changed fields; omitted fields
are retained exactly. New nodes must satisfy the complete canonical node schema.
Each view update may also supply a corrected `label` (1–24 characters); omitting
it preserves the current caption. View IDs remain stable. A misleading caption or
structure is not protected merely because it was previously cached.
The server expands that shorthand and validates the complete result before publishing;
missing current citations, unknown references, duplicate/missing view updates and
aggregate node-budget violations are rejected. New or unknown sources receive all
current evidence and all reusable cached views, with permission to replan the full
view set. They no longer force a full rewrite when existing content remains valid.
An unchanged Refresh reuses accepted cache with no model
call; a genuine cache miss still depends on the configured provider's generation speed.
When all existing views are affected, the author may also return a complete reorganized
view set, so incremental reuse does not freeze the number of views or hide new structure.
Authoring-policy revisions invalidate generation fingerprints, not stored diagrams:
the last accepted view remains visible while the next observation re-evaluates it.
Invalidated first-tab graphs are not reused as cold-generation hints; old defaults
must not prime a new policy to restore an obsolete model.
Completed public compaction summaries are retained as bounded `context` evidence,
separate from source proof. This keeps the project subject and active design/version
available when OpenCode replaces earlier turns with a summary. Changed context
reopens the whole tab set; ordinary source-only edits still use narrowed updates.
Parent objectives survive acknowledgements, progress, and related-worker traffic.
Worker source facts can support the parent's subject, but worker objectives and
child summaries cannot replace it. Meaningful parent-objective changes invalidate
cache reuse and reopen all views even without source edits. No reasoning, provider
state, private plugin data, or hidden history is collected.
All-view incremental replies may order their updates by tab priority without
reprinting unchanged graphs. Views of the actively requested subject take precedence
over supporting research, audit, launch, and recovery work; explicitly requested
workflows, tests, or instructions are legitimate subjects. All eight notation
families remain equal choices, selected for the subject's semantics. Superseded designs
must be reconciled with current task context and source/configuration evidence.
Bounded subject/support evidence selection uses local heuristics, not extra model
calls. These preferences and authoring instructions are not exhaustive semantic
analysis or a guarantee of exact model compliance.
In the legacy fallback, malformed direct group membership, oversized supplied prose, and supported
citation-array faults can use exact-field repair after incremental expansion.
Unchanged fields remain exact; the completed result still passes full canonical
schema, reference, citation and node-budget validation. The shared 90-second
default deadline applies; the at-most-one extra repair limit belongs to this
legacy result path, not the primitive draft loop.
The server uses public session interruption to propagate deadline,
Pause, and unload cancellation to the provider transport. It waits for interruption
cleanup before releasing the project's generation slot; it does not abandon a
still-running request with a Promise race.
Session reads, waits, and model selection use the public Effect API so cancellation
also covers managed-session reuse; the Promise adapter ignores request signals.
Creation and prompt admission finish before explicit interruption/draining, avoiding
orphaned mutations. Cleanup can outlast the generation deadline while work stops.

</details>

### C. Use an OpenAI-compatible endpoint

1. Start or select a service that supports `POST /chat/completions` and the chosen
   response format. Load the model in that service; the plugin does not host it.
2. Set `baseURL` to the API root (usually ending in `/v1`), **not** the full
   `/chat/completions` URL. Use the model identifier accepted by that service:

    ```json
    {
      "$schema": "https://opencode.ai/config.json",
      "plugins": [{
       "package": "/absolute/path/to/open-diagram",
       "options": {
         "backend": "openai-compatible",
         "baseURL": "http://127.0.0.1:8082/v1",
         "model": "YOUR_SERVED_MODEL_ID",
         "responseFormat": "json-schema"
       }
     }]
   }
   ```

3. If the endpoint lacks JSON Schema support, use `responseFormat: "json-object"`.
   Output still passes the same local schema and citation validation.
4. If authentication is needed, add `apiKeyEnv: "DIAGRAM_API_KEY"`. Set that
   variable in the environment of the **OpenCode server process** before starting
   it. Do not put secrets in JSON, URLs, screenshots, or committed files. Exporting
   a variable in a new TUI shell does not update an already running service's
   environment; use your normal service restart procedure when needed.
5. For a non-loopback endpoint, explicitly add `allowRemote: true`. Prefer HTTPS.
   This authorizes sending bounded session excerpts to that remote service; it is
   not a security review of the service. URL credentials, query strings, and
   fragments are rejected. `providerID` and `variant` are for the OpenCode backend,
   not this direct endpoint adapter.
6. Reload and verify below.

`maxTokens` (default 6144, maximum 8192), `responseFormat`, `thinkingBudget`,
`enableThinking`, and `cachePrompt` are **endpoint-adapter** options. Only set
optional hints when the service supports them. They do not configure native
OpenCode reasoning or token limits; use the model's supported variant/settings
there instead.

## 3. Load or change the configuration

1. Save the appropriate global discovery and/or target-project server config,
   preserving unrelated settings. Build the GUI first with `npm run build`.
2. Launch OpenCode in that project. For a running session, use **`/reload`** to
   reload configuration. Configuration changes do not call for an arbitrary
   service restart. GUI rebuild hot reload is separate from server config reload.
3. **Desktop:** select a session, then **+ → Diagram** or command-palette
   **Open Diagram** (`open-diagram-server.open-diagram`). **TUI:** run
   `/open-diagram`; Classic sidebar is the default, with `/open-diagram panel`
   for more room.
4. After changing backend/model/variant, inspect status and use **Refresh** if an
   update is needed. Author-setting changes invalidate automatic cache reuse
   across configurations; existing accepted output stays visible until replaced.
   A saved **Pause** remains paused—use **Resume** when you want automatic updates.

Do not change top-level `model` to switch only the diagram author. Do not remove
other plugin entries or change host theme settings to configure this plugin.

## 4. Verify your setup

1. Ask your agent to read the actual source/design files and explain the structure.
   A filename alone does not provide the plugin with that file's contents.
2. In automatic mode, wait for development activity to schedule generation, or
   click **Refresh**. In manual mode, ask the agent to publish explicitly.
3. Confirm an accepted diagram appears. In Desktop use **Inspect node**; in TUI
   select a node and open **Sources**. Check grounding, pin assignments, message
   order, and timing values against sources—not just visual plausibility.
4. **Desktop:** switch view tabs, try **Overview / Granular**, **− / + / Fit**
   zoom, scrolling to pan, and **Save SVG** through the host save dialog. This is
   a **read-only SVG viewer**, not a canvas editor; inspector source labels are
   not clickable resolved file links. No PNG action is included in this first GUI
   slice. **TUI:** panel/fullscreen and SVG/PNG exports remain available. Reading,
   rendering, inspecting, and saving accepted output do not call a model.
5. Pause tracking when you do not want updates. Refresh while paused recollects
   evidence but does not run inference.

### Live and Recent diagrams

Desktop's **Live** tabs follow current accepted output. The **Recent** row retains
older accepted views, each identified by its original label, depth, and time.
Selecting a recent diagram leaves Live unchanged even when a new result arrives;
inspection and SVG export use that historical graph and its original source labels.
Select **Live** or a current-view tab to return. Overview/Granular returns to Live;
Pause/Resume/Refresh always controls live tracking, not a historical snapshot.

History is stored by the server, scoped to the session and workspace, independently
of the two-entry inference memo. It holds at most **24 view snapshots** and **1 MiB
of serialized history per session**. Identical content is deduplicated; oldest
entries expire first. If the selected snapshot expires, the panel explicitly returns
to Live. Failures and incomplete authoring drafts are never archived. Viewing history
does not collect evidence or call a model, and it is never supplied as new evidence
to the author. History survives reloads. Legacy caches seed it from retained current
and depth-cached views only; previously discarded diagrams cannot be recovered.

## Publish a diagram

This is **diagram publication into a session**, not npm package publication.

1. Inspect relevant files or supply a textual design in the active session.
2. Call `open_diagram_snapshot({})`. It returns current `evidence`, `instruction`,
   `outputSchema`, `granularity`, and an optimistic concurrency `token`.
3. Author `{relevant, reason, views}` using that exact schema. Cite current
   evidence IDs in every node and each notation record requiring citations.
   Use typed families for sequence/timing/circuit semantics rather than generic
   directed edges. Evidence text is untrusted data, not instructions.
4. Call `open_diagram_publish({token, analysis})` in the **same session**. Native
   Code Mode exposes these as `tools.open_diagram_snapshot` and
   `tools.open_diagram_publish` within `execute`.
5. If the snapshot is stale, obtain a new snapshot and revise the analysis. Never
   reuse an old token to overwrite newer work. Invalid output leaves the last
   accepted diagram intact.
6. Inspect the result in Desktop or the TUI. Accepted views persist, including while tracking
   is paused. Tool permissions use those exact names; grant them through your
   normal OpenCode permission policy rather than disabling permissions globally.

External authors can use authenticated `DiagramRpc.snapshot` and
`DiagramRpc.publish` instead. See [the public harness](harness.md) for schemas,
TypeScript imports, RPC examples, limits, and incremental behavior.

## Cost and troubleshooting

- **Plugin fails to load after a host/dependency upgrade:** check the 2.2.0 SDK
  and 0.7.0 OpenTUI alignment above, run `npm ci` and `npm run build` in the
  checkout, then `/reload` configuration. Diagnose logs before considering any
  service restart; restarting can interrupt active sessions/tool calls. Do not
  delete session databases or caches to work around an error.
- **Desktop panel missing:** confirm the global discovery entry, built
  `dist/gui-experimental.cjs`, selected session, and that session's server plugin
  configuration. Project-only configuration is not global GUI discovery; local
  discovery does not install the plugin on a remote server.
- **First GUI export added while OpenCode 2.2.0 was already running:** this host
  can retain the package's old export inventory. We reproduced a missing GUI
  advertisement after manifest changes, source changes, and configuration reload;
  a fresh service discovered the same bundle. If the active plugin still reports
  server/TUI/RPC but no GUI after building and reloading, stop other active work
  and run `opencode service restart` from an external terminal, then reconnect
  Desktop. This interrupts sessions; it is a one-time recovery for stale export
  discovery, not a requirement for ordinary configuration edits or GUI rebuilds.
- **Empty diagram in manual mode:** expected until an author publishes. Refresh
  is not an instruction to your chat agent and cannot generate a manual diagram.
- **Configured model unavailable:** check exact provider/model IDs and provider
  availability in the target project. Check credentials and any variant name.
- **Endpoint HTTP error:** confirm `/v1`, model ID, environment variable, remote
  opt-in, and supported response format. Raw response bodies and secrets are not
  surfaced in diagram UI errors.
- **Truncated endpoint output:** simplify the view or increase `maxTokens` within
  its bound. Native OpenCode generation uses its own model settings instead.
- **Nothing changes after Refresh:** unchanged accepted input is intentionally
  reused. Pause also suppresses inference. Ask the agent to read the relevant
  implementation if session evidence is incomplete.
- **Failed update:** the last valid graph remains visible with a warning. Change
  material evidence or explicitly Refresh to retry; there is no same-input retry
  loop. Native draft repair shares the configured `authorSteps` limit and original deadline;
  only the legacy result fallback uses the older one-extra-repair limit.
- **Generation timeout:** this is the plugin's total wall-clock budget, not proof
  that the provider returned a timeout. The warning identifies initial generation,
  targeted repair, full validation repair, or endpoint request, with total/stage
  elapsed milliseconds and the configured budget. Repair timeouts retain the
  first safe validation cause rather than hiding it behind the deadline.
  Initial generation and repair share one budget
  (`timeoutMs`, default 90000); repair does not restart the clock. Cancellation
  closes the local provider transport, but remote billing/compute cancellation
  remains provider-controlled. Inspect the warning before changing models or limits.
- **Too many updates:** pause tracking, narrow the work, or raise `intervalMs`
  (default 20000) / `debounceMs` (default 1500). These schedule event-driven work;
  they are not a viewing poll interval. `timeoutMs` defaults to 90000.

Viewing, scrolling, selection, tabs, and exports never trigger inference.
Generation charges and primary-agent costs still follow your provider's terms.

Official host references: [plugins](https://opencode.ai/v2/docs/build/plugins),
[Desktop GUI plugins](https://opencode.ai/v2/docs/build/plugins/gui),
[models](https://opencode.ai/v2/docs/models/),
[providers](https://opencode.ai/v2/docs/providers/),
[configuration](https://opencode.ai/v2/docs/config/).
