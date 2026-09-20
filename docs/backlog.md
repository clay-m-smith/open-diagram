# Delivered feature notes

This file retains the original export acceptance checklist. It is historical
implementation context, not a list of pending work. Current user instructions
live in [the usage guide](usage.md) and [README](../README.md).

## Diagram-only copy and export

**Status:** implemented; included in the native runtime verification suite.

The native toolbar includes a compact export action group:

```text
[PNG] [SVG] [Save]
```

- **PNG:** copy the active diagram as an image to the clipboard, where the host
  environment supports image copying.
- **SVG:** copy a scalable SVG representation of the active diagram.
- **Save:** save the active diagram as PNG or SVG to a user-selected file.

### Acceptance criteria

- Export only the active diagram: title, nodes, edges, labels, and displayed node
  details. Exclude tabs, Refresh/Pause/Expand controls, status text, action buttons,
  Sources controls, and surrounding terminal UI.
- Export the full diagram rather than a cropped terminal screenshot.
- Use the accepted cached graph and current view selection; never invoke a model
  or regenerate a diagram to copy or save it.
- Keep the action row compact in the native sidebar and available in expanded
  and fullscreen presentations.
- Disable export when no accepted graph exists. A stale but valid cached graph
  remains exportable.
- Report copy/save success or an actionable error without disturbing the graph.
- Offer file saving when image clipboard support is unavailable. Do not install
   clipboard utilities automatically. Refuse existing files rather than offering
   an overwrite operation.

### Implementation

- Native OpenCode dialogs choose format and destination. SVG uses `image/svg+xml`
  and PNG uses `image/png` with existing Linux clipboard tools, including `xclip`
  through a working SSH-forwarded `DISPLAY`. Neither copies markup as plain text.
- Deterministic SVG rendering shares content-sized ELK or family-specific geometry
  with the native TUI, including explicit edge endpoints and circuit net junctions.
  PNG rasterization is loaded only when requested; nodes are not numbered by the renderer.

Implementation uses cached graph data, SVG plus on-demand PNG rasterization,
native dialogs, MIME-typed image copying, and optional existing Linux image
clipboard tools. Unsupported image copying falls back to saving. Existing files
are refused rather than overwritten. See README.md for environment limits.
