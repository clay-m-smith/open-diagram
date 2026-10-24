# Standalone diagrams: MCP and Node API

Open Diagram can validate, store, and render diagrams authored by other agents or
applications. No OpenCode process, session, provider configuration, or second
model is required. The calling client owns authorship and source context.

The existing OpenCode plugin and TUI remain supported through their existing
entrypoints. Both integrations use the same graph schemas, notation semantics,
authoring instructions, and SVG/PNG exporters.

## Run the local MCP server

Requires Node.js 22+ and a local checkout with `npm ci` completed. From the checkout:

```sh
node mcp.mjs
```

For initial checkout instructions and an integration comparison, start with
the [README](../README.md#install-and-set-up). For native session tracking instead,
see [OpenCode setup](setup.md).

The server waits for MCP messages on stdin. stdout is reserved for protocol
messages; it is not an interactive command prompt. `npm run --silent mcp` is an
equivalent local command, but prefer direct `node` invocation in client configs.

For clients using an `mcpServers` configuration object, use the absolute checkout
path (the exact configuration file and keys depend on the host):

```json
{
  "mcpServers": {
    "open-diagram": {
      "command": "node",
      "args": ["/absolute/path/to/open-diagram/mcp.mjs"]
    }
  }
}
```

The launcher resolves its TypeScript loader relative to the checkout, so the
client's working directory does not have to be this repository. The SDK serves
legacy and current MCP clients; both paths have process-level integration tests.
Specific client UIs have not been certified. MCP makes output available, but does
not guarantee that a host displays images, SVG resources, or an interactive panel.

## Author, publish, inspect, render

| Tool | Required arguments | Purpose |
| --- | --- | --- |
| `diagram_schema` | `{}` | Shared authoring instructions and analysis JSON Schema |
| `diagram_publish` | `diagramID`, `expectedRevision`, `analysis`, `sources` | Validate and create/replace an in-memory record |
| `diagram_get` | `diagramID` | Accepted analysis, sources, and current revision |
| `diagram_list` | `{}` | IDs, revisions, and available views |
| `diagram_render` | `diagramID`, `viewID`, `format` | Embedded SVG resource or PNG image; optional `colorMode` and `selected` |
| `diagram_remove` | `diagramID`, `expectedRevision` | Remove an accepted record and release capacity |

1. Call `diagram_schema` with `{}` for shared instructions and the analysis JSON
   Schema. The client authors the diagram using its own context/model.
2. Call `diagram_publish` with an ID, `expectedRevision: 0`, source references, and
   the analysis. Each cited source ID must exist in `sources`, including citations
   nested in notation. Source labels are supplied by the client; validation checks
   reference consistency, not whether an architectural claim is true.
3. Call `diagram_get` to read accepted data or `diagram_list` to discover IDs and
   views. Graph JSON is suitable for another application's own visualization.
4. Call `diagram_render` with a diagram ID, view ID, and `svg` or `png` format.
   SVG arrives as an embedded resource; PNG arrives as an MCP image content block.
   Both include revision metadata. `colorMode` accepts `light` (default) or `dark`;
   `selected` optionally expands a node's details.
5. Updates require the current revision from `diagram_get`. Stale revisions and
   invalid diagrams are rejected without replacing accepted data.

Example publication arguments:

```json
{
  "diagramID": "order-flow",
  "expectedRevision": 0,
  "sources": [{ "id": "design", "label": "Client-supplied order design" }],
  "analysis": {
    "relevant": true,
    "reason": "Order entry design",
    "views": [{
      "id": "overview",
      "label": "Overview",
      "graph": {
        "title": "Order entry",
        "summary": "",
        "nodes": [{
          "id": "api",
          "label": "Order API",
          "kind": "service",
          "detail": "Validates incoming orders",
          "status": "planned",
          "evidence": ["design"]
        }],
        "edges": []
      }
    }]
  }
}
```

Then call `diagram_render` with:

```json
{ "diagramID": "order-flow", "viewID": "overview", "format": "png" }
```

Accepted JSON is also exposed through `resources/list` and `resources/read`, at
`diagram://local/order-flow`. These are process-local MCP identifiers, not public
web URLs or filesystem paths. Re-read to obtain changes; resource subscriptions
are not implemented. Rendered SVG's embedded URI identifies the returned artifact;
the embedded bytes are authoritative and that artifact URI is not separately
readable through `resources/read`.

`diagram_remove` takes `{ "diagramID": "order-flow", "expectedRevision": 1 }`
(use the actual current revision) and frees capacity. Revisions increase across
publications in the process and are not reused when an ID is removed and recreated.

## Lifetime, limits, and trust boundary

- **Memory only:** records disappear when the server exits. Export or retain JSON
  in your client if you need durability. Each spawned server has a separate store;
  two applications do not automatically share diagrams.
- At most 32 stored diagrams, 512 KiB per record; capacity failure does not evict
  another diagram. Up to four views, 24 nodes per view, 48 nodes total, and 32 source
  references. Existing notation-specific limits also apply.
- At most two active renders, 8 MiB encoded output per render, and a 1 MiB stdio
  input buffer. Busy requests fail and may be retried. Rendering uses the existing
  bounded layout worker; disconnecting does not instantly stop an active layout.
- No source-file reads, URL fetches, filesystem exports, model calls, or credentials.
  Source references are data, never paths to open. Source text is not required or
  stored; labels and diagram descriptions may still contain sensitive information.
- The local caller controls the process and can read all its records. This is not
  an authenticated multi-user server. Do not expose its transport publicly.
- HTTP hosting, cross-client sharing, durable storage, server-side generation,
  interactive browser/native viewers, and third-party host UI extensions are not
  part of this first version.

## Use the shared Node API

`open-diagram/core` is a host-independent source entrypoint. Use a TypeScript-aware
runtime such as the installed `tsx` loader (`node --import tsx your-script.ts`).
It is a Node-side API, not a browser bundle: layout uses worker threads and PNG
uses native Resvg.

```ts
import { validateDiagramOutput, renderDiagramSVG } from "open-diagram/core"

// request contains the analysis and sources shown above.
const analysis = validateDiagramOutput(request.analysis, request.sources)
const svg = await renderDiagramSVG(analysis.views[0].graph)
```

Other exports include `GraphSchema`, `ViewAnalysisSchema`, `diagramRequest`,
`diagramOutputSchema`, `DIAGRAM_INSTRUCTION`, `layoutDiagram`, and
`renderDiagramPNG`. Validate untrusted input before calling layout/rendering
functions; those functions accept already-valid graphs.

`open-diagram/mcp` exports `createDiagramMcpServer()` for programmatic local
integration. It creates an isolated store on each call and does not connect a
transport by itself. Existing `open-diagram/harness` and `open-diagram/rpc` retain
their OpenCode-compatible exports.

## Troubleshooting

- **The command appears idle:** expected when launched without an MCP client. It
  waits on stdin; it does not open a viewer or print a readiness banner to stdout.
- **A tool is missing:** confirm the client launched the absolute `mcp.mjs` path
  from this checkout, not the OpenCode `server.ts` plugin entrypoint. Run `npm ci`
  if dependencies are missing. Configuration keys and reload behavior vary by host.
- **Revision conflict:** call `diagram_get` and base the next update on that
  revision. Use `0` only when the ID does not exist. Accepted data remains intact.
- **A citation is rejected:** every evidence ID, including notation references,
  must appear in the publication's `sources`. Ask the author to correct its data;
  the server will not invent references or read source files.
- **No image is visible:** inspect the returned content. PNG uses an image block;
  SVG is an embedded resource. Some clients expose raw data rather than rendering
  it. No native panel or interactive viewer is installed by this MCP server.
- **A diagram disappeared:** records do not survive server restart or move between
  independently launched processes. Keep JSON or exports in the client.
- **Capacity or renderer busy:** explicitly remove unused records or retry after
  active renders finish. The server does not silently evict another diagram.

## Verify

```sh
npm run typecheck
node --import tsx --test tests/standalone.test.ts
npm run verify
```

The standalone test starts the actual launcher from outside the checkout,
exercises both protocol eras, reads published resources, renders SVG/PNG, checks
failed updates preserve data, and denies OpenCode/OpenTUI imports and network
fetches. The complete suite additionally needs the OpenCode runtime version
accepted by `scripts/v2-runtime.mjs`.
