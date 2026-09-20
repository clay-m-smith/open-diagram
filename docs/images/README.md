# README images

These are exports of **Open Diagram's own architecture and cached-view flow**,
not terminal screenshots, model-generated source analysis, or stock illustrations.
The graph definitions and source citations are hand-authored in
[`scripts/render-readme.mjs`](https://github.com/clay-m-smith/open-diagram/blob/main/scripts/render-readme.mjs). The script checks
them with the production schema and citation validator, then uses the production
SVG and PNG exporters. No model, credentials, or OpenCode service is needed.

## Regenerate

Regeneration is a **repository-checkout-only maintainer workflow**. Distributed
packages include the finished images, not development scripts or the `tsx` dev
dependency. [Clone the repository](../setup.md#1-install-from-this-repository)
before running these commands; do not run them inside an installed package.

1. Run `npm ci` in the repository root.
2. Run `npm run docs:images` to generate both light and dark variants.
3. Inspect the images, especially arrows, text, and layout after renderer changes.
4. Run `npm run docs:check`. It compares SVG output exactly and checks PNG
   signatures/dimensions; it does not compare raster pixels across machines.
5. Commit the script and generated images together when definitions change.

PNG text uses available system fonts, preferring DejaVu Sans Mono. Font availability
can change raster appearance across machines. SVG remains scalable and editable.
The README's `<picture>` elements choose a light/dark PNG for the reader's theme;
the adjacent SVG links provide the vector versions.

## Source map

| View | Source basis |
| --- | --- |
| Architecture | [`server.ts`](../../src/diagram/server.ts), [`evidence.ts`](../../src/diagram/evidence.ts), [`engine.ts`](../../src/diagram/engine.ts), [`author.ts`](../../src/diagram/author.ts), [`client.ts`](../../src/diagram/client.ts), [`tui.tsx`](../../src/diagram/tui.tsx), [`export.ts`](../../src/diagram/export.ts) |
| Cached view | `createDiagramMonitor` in [`tui.tsx`](../../src/diagram/tui.tsx), scoped `get` in [`server.ts`](../../src/diagram/server.ts), `DiagramEngine.get` in [`engine.ts`](../../src/diagram/engine.ts), and local rendering in [`view.tsx`](../../src/diagram/view.tsx) |

The architecture view summarizes data flow with an explicitly configured automatic
author. It is not a complete function-call graph. Manual tools share validation
and publication without invoking that secondary author. The sequence illustrates
a cold **TUI** cache and warm **engine** cache; a warm TUI can reuse its local
snapshot without another server read. Engine hydration from storage is omitted.
