# Model-independent diagram harness

Open Diagram separates evidence collection, diagram authorship, validation, and
presentation. No provider-specific routing is required by the graph protocol.

For numbered install and model-selection instructions, start with
[setup](setup.md). For Git/npm release procedures, see [publishing](publishing.md).

## Three integration paths

1. **OpenAI-compatible endpoint:** configure `backend: "openai-compatible"`,
   `baseURL`, and `model`. Loopback endpoints are the default trust boundary;
   remote endpoints require `allowRemote: true`. Authentication uses `apiKeyEnv`.
2. **An OpenCode model:** configure `backend: "opencode"`, `providerID`, `model`,
   and optionally `variant`. Generation uses the public `generate.text` API;
   it does not change the conversation's model or create an agent session.
   This can incur charges under the configured provider.
3. **Any external or active model:** obtain a snapshot, produce the documented
   JSON, and publish it through the tools or authenticated RPC. Use
   `backend: "manual"` to disable automatic generation while retaining evidence,
   validation, tabs, and persistence.

Installing the package without backend options defaults to manual mode. There is
no automatic paid-provider fallback.

Automatic adapters use short request-local evidence aliases and map validated
citations exactly back to durable source IDs. Native generation permits one
validation-repair request within the original timeout; it never fuzzily repairs
citations or retries transport failures. This can mean up to two model calls per
update. Invalid output is never published.

## Authoring protocol

Call `open_diagram_snapshot` with `{}` from the active session. Its response
contains `evidence`, `instruction`, `outputSchema`, and `token`. Generate the
analysis object, then call `open_diagram_publish` with `{token, analysis}`.
Do not add unrelated session work between snapshot and publication: changed
evidence invalidates the token. On conflict, take a new snapshot and regenerate.
The native Code Mode catalog exposes these as `tools.open_diagram_snapshot({})`
and `tools.open_diagram_publish({token, analysis})` inside `execute`.

External clients can import `DiagramRpc` from `open-diagram/rpc` and use the
authenticated OpenCode client:

```ts
const rpc = client.rpc(DiagramRpc)
const snapshot = await rpc.snapshot({ sessionID }, { location })
// Produce analysis with any model, citing snapshot.evidence IDs.
const state = await rpc.publish({ sessionID, token: snapshot.token, analysis }, { location })
```

RPC rejects sessions outside the plugin's current project/location. A token is
an optimistic concurrency guard, not an authentication credential. The server's
existing authentication protects RPC; native tool permissions protect tool use.

The `open-diagram/harness` export provides `DIAGRAM_INSTRUCTION`,
`diagramRequest`, `diagramOutputSchema`, and `parseDiagramOutput`. The same
instruction/schema is used by built-in adapters and external authors.
`parseDiagramOutput` returns the wire-compatible `{relevant, reason, views}`
object accepted directly by publication. Legacy single-graph input is normalized
to an Overview view; internal compatibility fields are not added to this public
result.
If `control` cannot admit fresh collection, RPC rejects with declared `capacity`
error and a retry message. Its `data.mode` reports the effective in-memory mode,
not a durability acknowledgement. Use `get().cacheError` to check persistence
status; `capacity` errors also include `data.cacheError` when available and flag
failed saves in their message. The caller can retry Refresh without rolling back
a newer mode selection.

Nodes keep a short `detail` description and may add `behavior` (up to 600
characters) for grounded functional explanation: inputs, processing, outputs,
or responsibilities. Existing graphs without `behavior` remain valid. Expanded
blocks show both; source references live behind a separate Sources toggle, with
file names rather than tool-call status text. New authors should explain actual
functionality, not the steps used to inspect the source.

`control({sessionID, granularity: "granular"})` selects layer/operation-level
authoring; `"overview"` restores high-level views. Depth is independent of tracking
mode and persists per session. It invalidates outstanding author tokens and
cancels obsolete automatic results without resuming paused tracking. Snapshots
expose `granularity` and depth-specific instructions; `diagramRequest` accepts
depth as its fourth argument. Missing depth in older stored records means overview.

`get({sessionID})` only reads the cached/persisted snapshot. It never collects
context or invokes a diagram model. Development hooks, explicit control/Refresh,
and authoring snapshot/publication requests own evidence collection. TUI view
changes reuse a bounded session cache; server events keep inactive cached sessions
updated. Reconnect/plugin-reload events invalidate cached snapshots for one scoped
read, without triggering model generation. No periodic polling is used.

Refresh is content-aware: it reuses an accepted diagram for unchanged material
evidence and depth, or retries a failed changed-input update. Accepted per-depth
entries and evidence fingerprints are stored atomically with the last-good state
in an internal `memo` field; RPC snapshots never expose this metadata. Existing
records without `memo` remain readable and acquire it after the next accepted
publication. `updateError` reports failed authoring separately from usable cached
views. Progress prose, observation timestamps and log-only changes do not schedule
source-backed diagram generation. Known dependency changes can author only the
affected views; the engine validates the merged result before replacing output.
The public snapshot/publication tools collect evidence without initiating a
duplicate automatic author request, so the main agent can supply incremental
diagram observations through the existing model-neutral authoring path.
For unaccepted input, a snapshot reserves main-agent authoring for up to two
minutes and cancels queued/active secondary work. Same-input tool/context hooks
do not release that reservation. Publication, rejected publication, explicit
controls, changed material input, or bounded expiry release it; abandoned
authoring therefore cannot stall tracking indefinitely.
Rejection releases only the matching publisher's reservation, never a newer
author's token. Missing/invalid-token or host-level pre-dispatch rejection cannot
identify an owner and relies on bounded expiry. Admitted collection failures and
tool-level validation failures with a matching token release their reservation;
collection errors still block inference until evidence recovers.
Already-admitted explicit Refresh/depth controls still run when a snapshot shares
their collector. Cancelled work is eligible again; only completed failures are
suppressed. Empty publications cannot replace an existing last-good diagram.
Changing output-affecting author settings invalidates every view, rather than
mixing output from different author namespaces.
Failure suppression retains the latest 32 failed content/depth keys per session;
older failures may be retried after bounded-cache eviction. Refresh admitted
during an active attempt coalesces with that attempt, even if collection finishes
after it fails. A new Refresh after failure explicitly retries.

For strict Structured Outputs, use `diagramOutputSchema({strict: true})`: every
property is required, including `behavior` (use an empty string when unsupported)
and `notation` (use `null` for generic blocks).
The endpoint adapter selects this automatically. Public validation remains
backward-compatible with omitted `behavior` and `notation`.

Output has this shape:

```json
{
  "relevant": true,
  "reason": "Two connected services",
  "views": [{
    "id": "system",
    "label": "System",
    "graph": {
      "title": "Order processing",
      "summary": "",
      "nodes": [
        {"id":"api","label":"API","kind":"service","detail":"Accept orders","status":"planned","evidence":["COPY_SNAPSHOT_EVIDENCE_ID"]},
        {"id":"queue","label":"Queue","kind":"message-broker","detail":"Buffer orders","status":"planned","evidence":["COPY_SNAPSHOT_EVIDENCE_ID"]}
      ],
      "edges": [{"from":"api","to":"queue","label":"orders"}]
    }
  }]
}
```

Infer views from the work, rather than choosing from a fixed taxonomy. Model
internals, system boundaries, repository containment, workflows, protocols, and
other useful structures can coexist as tabs. Node `kind` is descriptive text,
not an ML-only enumeration. Diagrams distinguish observed from planned facts.

Every node and every notation record with an `evidence` field cites current
snapshot evidence. Limits and complete field constraints
are available from `diagramOutputSchema()`. Unknown citations, duplicate IDs,
dangling edges, terminal controls, and oversized output are rejected.

### Versioned notation

The snapshot transport remains version 1. Its graph schema accepts an additive
`notation` payload with its own `version: 2` and a `family` discriminator. Legacy
graphs omit this field or set it to `null`; their node/edge representation is
unchanged. `NotationSchema`, `DiagramNotation`, `DiagramGraph`, `diagramEvidence`
and `nodeEvidence` are also exported through `open-diagram/harness`.

Architecture, flowchart, state, class and ER views retain graph nodes/edges and
annotate them with typed records. Edge annotations use zero-based edge indices
and must cover every edge exactly once. Flow/state and class/ER node records must
cover every node. Architecture ports reference their owning node; a link cannot
name another node's port. Groups have unique IDs, acyclic parents and direct node
membership (one owning group per node).

Sequence, timing and circuit views use nodes as selectable participants, signals
or components, but **require `edges: []`**. Their relationships live in the family
payload:

- Sequence: `participants`, ordered `messages`, inclusive message-index
  `activations` and `fragments`. Repeated messages need distinct IDs. Interaction
  spans may nest but not partially overlap. Fragments label a span; they do not
  encode separate UML alternative operands.
- Timing: `unit`, positive `end`, and `signals` with `mode`, `initial`, ordered
  `{at, value}` samples and evidence. Times must increase strictly within `(0,end)`.
  Digital values are `0`, `1`, `X` or `Z`; bus values are plain text. Event-spaced
  layout shows exact times without claiming proportional time spacing.
- Circuit: `groups`, `components` and `nets`. Components have `node`, `reference`,
  `value`, `symbol`, `pins` and evidence. Each pin has a component-local `id`,
  `number`, `label`, `electrical` role and `noConnect`. Nets have unique IDs,
  display labels, nullable sheet/group `scope`, explicit `{node,pin}` terminals
  and evidence. A pin cannot belong to two nets or be both connected and NC.
  Non-NC pins without a net are rendered as unassigned, not silently grounded.
  Local-net terminals must belong to their scope or a descendant sheet. A global
  net can span sheets; an explicit cross-sheet net uses their common ancestor or
  global scope. Net IDs, not equal labels or geometric intersections, establish
  identity. Junction dots are derived only from declared terminal membership.

Use the generated schema for exact enums and bounds rather than extending
descriptive node `kind`. Circuit symbol tokens are deliberately compact; generic
symbols remain labelled unknown. There is no KiCad import adapter, electrical
rule checker, simulator or PCB output. All family citations are validated and
alias-remapped; previous-output hints strip all citation arrays. Durable caches,
dependency targeting, changed-node highlighting, TUI Sources and exports consume
the same accepted family data.

The snapshot includes an optimistic concurrency token. Publish returns a conflict
when material diagram input, tracking mode, or an accepted diagram changed after the snapshot;
obtain a fresh snapshot instead of overwriting newer work. Valid publications
cancel obsolete in-flight analysis and become the persisted diagram. Changed
development evidence can trigger the next automatic update.
Chat/progress alone does not invalidate the token. Every published citation must
still belong to the current evidence packet.

## Evidence boundaries

Collection uses public session context and observed related-session work. It
does not crawl the repository, read other plugins' storage, or execute model
output. Reasoning, system instructions, media, and private context/memory tools
are excluded. Source excerpts are transient; diagrams and citation labels are
durable. Remote model backends receive the same bounded excerpts.

Selection uses independent fixed budgets for implementation/structural evidence
and chat/log context. Unused context quota does not expand source excerpts, so
adding chat cannot shrink those excerpts or change their fingerprints. Packets
remain bounded to 32 records and 36,000 ID/label/text characters. Large source
reads use structural excerpts instead of only introductory comments. Failed
mutations do not supersede successful reads. Successful file mutations invalidate
all observed ranges of that file; optional `file` (opaque dependency ID) and
`mutation` snapshot metadata support this without exposing extra file contents.
Observation IDs remain distinct from file dependency IDs: baseline reads and
ordered partial edits coexist. Opaque `fingerprint` metadata hashes admitted
content before prompt excerpting, so changes outside sampled text still
invalidate accepted output. Repository inventories are material evidence too.
Relative read/mutation precedence is material; absolute timestamps are not.
Successful file reads remain material even when their extension is unknown;
known log/artifact/generated-directory exclusions apply before retention.
Failed-input warnings are stored with the suppression key
and restored when that failed input is revisited.
Known log/artifact/generated-directory writes remain nonmaterial context.
