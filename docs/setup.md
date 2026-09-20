# Install, configure, and choose a diagram model

Open Diagram is an OpenCode **2.x** plugin (`>=2.0.7 <3`), not an OpenCode V1
extension. Node.js 22+ is required for the repository tools. Use your current
OpenCode 2.x installation; no downgrade to the dependency version in this
repository is required. Dependency pins and `package-lock.json` make builds
reproducible; `engines.opencode` describes the host compatibility range.
The full suite, including isolated native runtime checks, currently passes on
OpenCode **2.0.11**. Earlier 2.0.10-based runtime verification remains valid for
that tested build; future 2.x releases are admitted, not pre-certified.

## 1. Install from this repository

```sh
git clone https://github.com/clay-m-smith/open-diagram.git
cd open-diagram
npm ci
pwd
```

This is the supported install path today. The package is currently marked
`private: true`; do not assume `npm install open-diagram` installs this project.
For future registry distribution, see [publishing](publishing.md).

In the project you want to diagram, merge an entry into `opencode.json` or
`opencode.jsonc`. Keep other plugins and settings intact:

```json
{
  "plugins": [{
    "package": "/absolute/path/to/open-diagram",
    "options": { "backend": "manual" }
  }]
}
```

Use the checkout's absolute path, not the target project's path. On Windows,
forward slashes avoid JSON backslash escaping. The server and TUI entrypoints
load together; do not register this package twice. Server/plugin configuration
belongs in `opencode.json(c)`, not `cli.json`.

## 2. Decide who authors diagrams

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
3. Copy the IDs into the plugin's `options`, replacing the manual settings:

   ```json
   {
     "plugins": [{
       "package": "/absolute/path/to/open-diagram",
       "options": {
         "backend": "opencode",
         "providerID": "YOUR_PROVIDER_ID",
         "model": "YOUR_MODEL_ID"
       }
     }]
   }
   ```

4. If the catalog displays `provider/model`, split at the **first** slash:
   `providerID` is the provider; `model` is everything after it. A model ID can
   itself contain slashes. Do not put the full provider-qualified identifier into
   `model`, and do not use its friendly display name.
5. To select a supported variant, add a separate `variant` field using its exact
   catalog name. Do not append `#variant` to `model` in plugin options. Variant
   names are model-specific; omit the field when unsure.
6. Reload and verify as described in steps 3 and 4 below.

There is no universal best diagram model. Start with a responsive model that
reliably emits structured JSON, then inspect the results against real sources.
For unfamiliar HDL, firmware, or circuit work, prioritize domain understanding
and accurate citations over speed. Smaller models may need narrower evidence and
less granular views. No model is certified here for electrical correctness.

These settings affect **only** diagram generation. They do not change OpenCode's
top-level `model`, current chat, agent, or worker routing. The native adapter uses
`ctx.generate.text` with this explicit provider/model/variant. It can make one
validation-repair request within the original timeout, so one update may involve
up to two model calls. It does not retry transport failures or switch providers.

### C. Use an OpenAI-compatible endpoint

1. Start or select a service that supports `POST /chat/completions` and the chosen
   response format. Load the model in that service; the plugin does not host it.
2. Set `baseURL` to the API root (usually ending in `/v1`), **not** the full
   `/chat/completions` URL. Use the model identifier accepted by that service:

   ```json
   {
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

1. Save the target project's `opencode.json(c)`.
2. Launch OpenCode in that project. If it is already running, run `opencode reload`
   from the target project. Reopen the TUI if the new plugin surface has not loaded.
3. Run `/open-diagram`. The default surface is the native sidebar; use
   `/open-diagram panel` for more room.
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
3. Confirm an accepted diagram appears. Select a node and open **Sources** to
   inspect its grounding. Check pin assignments, message order, and timing values
   against the source—not just whether the diagram looks plausible.
4. Try **Overview / Granular**, panel/fullscreen, and an SVG or PNG export. These
   exports use the active cached graph, not another model request.
5. Pause tracking when you do not want updates. Refresh while paused recollects
   evidence but does not run inference.

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
6. Inspect the result in the TUI. Accepted views persist, including while tracking
   is paused. Tool permissions use those exact names; grant them through your
   normal OpenCode permission policy rather than disabling permissions globally.

External authors can use authenticated `DiagramRpc.snapshot` and
`DiagramRpc.publish` instead. See [the public harness](harness.md) for schemas,
TypeScript imports, RPC examples, limits, and incremental behavior.

## Cost and troubleshooting

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
  loop. Native malformed-output repair is separately bounded to one extra call.
- **Too many updates:** pause tracking, narrow the work, or raise `intervalMs`
  (default 20000) / `debounceMs` (default 1500). These schedule event-driven work;
  they are not a viewing poll interval. `timeoutMs` defaults to 90000.

Viewing, scrolling, selection, tabs, and exports never trigger inference.
Generation charges and primary-agent costs still follow your provider's terms.

Official host references: [plugins](https://opencode.ai/v2/docs/build/plugins),
[models](https://opencode.ai/v2/docs/models/),
[providers](https://opencode.ai/v2/docs/providers/),
[configuration](https://opencode.ai/v2/docs/config/).
