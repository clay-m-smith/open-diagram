# Using diagrams and exports

For installation and selecting the diagram author, start with
[setup](setup.md). For programmatic publication, see [the harness](harness.md).

## Native controls

The toolbar groups **View**, **Depth**, **Tools**, and **Export** consistently in
the sidebar and expanded panel. Active selectors are bold and underlined.
Controls wrap on narrow panels; long captions use grapheme-safe ellipsis.

- `/open-diagram` selects diagram tabs. Host sidebar visibility remains a host preference.
- `/open-diagram panel` opens a resizable panel; drag its divider to resize.
- `/open-diagram fullscreen` opens the same views with more space.
- `/open-diagram sidebar` or `close` restores the native sidebar contents.
- `/open-diagram overview|granular` changes diagram depth, not tracking mode.
- `/open-diagram auto|on|off|refresh|pause|resume` controls tracking.
- `/open-diagram export-theme` selects System, Dark, or Light for images only.
- In a focused panel: `j/k` select, `f` fullscreen, `p` pause/resume, `r` refresh,
  and `Escape` returns to the Classic sidebar.
- Horizontal wheel/touchpad events pan the diagram; Shift-wheel also pans.
  In the expanded panel this works over the toolbar as well as the graph. In the
  native sidebar, point at the graph. The terminal must forward mouse events;
  the plugin cannot recover gestures intercepted by the terminal or OS.

Select a block to show its short description and functional explanation.
**Sources** separately reveals file/context references, including related
notation citations, without tool logs. `*` marks changes; `~` marks planned blocks;
`↺` marks return edges in legacy block graphs.

Narrow terminals use the host's sidebar overlay. Child sessions have no native
sidebar, so the plugin opens a panel. The host still owns sidebar visibility,
scrolling, and resizing. No private host layout state is modified.

## Layout and notation

View names describe their subject. Repository structure shows observed directory,
package, or subsystem containment, with files/modules inside those boundaries—not
a chain of recently touched source and test files. Imports, test coverage, and
runtime interactions belong in accurately named separate views. Partial evidence
must be identified as partial; unobserved repository contents are not invented.
Incremental updates can correct both a misleading caption and its structure while
retaining stable view IDs and unchanged grounded content.
Tabs prioritize the current system, model, or pipeline being developed, followed
by useful internals and supporting views. Research wrap-up or training recovery
should not displace the system it supports; old architectures should not remain
primary merely because an older README was reread. Explicit process-focused work
can still use a workflow view. Compacted context supplies historical orientation,
not proof that a proposal is implemented.
Descriptions favor a short scope sentence and purpose phrase, with one compact
expanded explanation. Essential parameters and caveats remain; brevity targets
do not tighten the published schema or truncate accepted cached content.

Cards fit their contents. Generic graphs compare a bounded set of downward ELK.js
layouts, balancing area and viewport overflow against wire length, bends, crossings and
shared routes, tolerating a couple of crossings instead of wide empty lanes.
Compound group titles reserve a header rather than an empty left column.
Arrow labels can wrap vertically and move along their own edges
instead of forcing adjacent wide label columns. Alternate layouts that obscure
cards or labels are rejected; if optimization fails, the original route remains.
Local shortcuts remove unnecessary zigzags without enlarging the candidate canvas
or moving cards. Unnamed ports may align within their existing card side; named
architecture ports remain fixed. Arrowheads retain a straight approach, and labels
stay beside their own routes, clear of cards and other wires.
Cycles, disconnected nodes, branches and joins remain explicit. Width is a
preference, not a clipping constraint: dense graphs can still scroll horizontally.
Wide diagrams open on the first block at the left edge; smaller diagrams are not
centered across the panel. Panning still reaches the complete routed graph.
Keyboard navigation follows visual reading order. Sequence labels use local,
wrapped gaps rather than widening every participant slot. Sequence and timing
views preserve declared participant/signal order; timing axes do not stretch just
to fill a wider viewport.

Connections match line, label and arrowhead hues, adapting to light/dark themes.
Eight hues are reused for dense graphs. Terminal crossings use vertical overpasses;
legacy shared trunks and merged arrowheads remain neutral. Circuit connectivity
is separate: only declared pin/net membership establishes a junction.
Architecture connectors are solid, including dependencies (identified in their
labels). Group outlines are solid and subdued. UML dependencies/realizations and
sequence returns retain their notation-specific dashed strokes.

Flow/state roles use compact badges on cards. Sequence fragments label message
spans, not full UML alternative operands. Timing is event-spaced and **not to
scale**, with exact times shown. Circuit views use pin-labelled component cards,
symbol tokens and separate net rails; unknown pins remain unassigned, not grounded.
`PWR_FLAG` is an ERC marker, not an implicit shared net. These are bounded native
notations rather than CAD or exhaustive notation-standard implementations.

Limits are four views, 24 nodes per view, 48 nodes total, and 48 graph edges per
view. Circuit views allow up to 96 pins and 48 nets; timing allows 256 transitions
per view. See the [generated schema contract](harness.md#versioned-notation) for
family-specific fields and validation.

## Cache and updates

Viewing is cache-only: no periodic polling or evidence collection on view/tab
changes. The TUI retains the last 64 visited sessions, consumes server events,
and reconciles one scoped snapshot after reconnect or plugin reload. Layout runs
locally with coalesced updates; obsolete results cannot replace a newer graph.

Accepted Overview and Granular diagrams have separate durable content-keyed
caches. Depth changes reuse matching output and do not resume paused tracking.
Known source changes can update only affected views; new/removed dependencies
conservatively request broader analysis. Net, port, message, timing and relationship
citations participate in dependency tracking. Unaffected views remain unchanged.

Refresh recollects evidence and reuses accepted output when material input and
author settings match. Progress prose, timestamps and shell logs do not invalidate
source-backed diagrams; request-only work can still track requests. Failed updates
retain the last-good diagram with a separate warning, without automatic repeated
same-input retries. A never-generated session remains empty until useful activity,
explicit publication, or an automatic-backend Refresh.

Collection failures mark retained diagrams stale. Unreadable persistence blocks
initialization instead of replacing saved graphs or Pause with writable defaults.
An empty context is not treated as a source deletion.

## Copy and save

**PNG / SVG / Save** exports the **full active cached diagram**, not a terminal
screenshot. It includes labels, connections or specialized notation, and the
selected block's displayed details. Controls, tabs, Sources UI and status chrome
are excluded. A stale but valid accepted diagram remains exportable.

Exports default to **System**, following OpenCode's resolved light/dark mode at
click time. **Theme: System** lets you choose Dark or Light explicitly. This
persistent export-only preference never changes the host theme. PNG rendering
loads on demand; available system fonts can affect glyph appearance. SVG remains
scalable and editable.

1. Select the desired view and, optionally, the block whose details should appear.
2. Click **PNG** or **SVG** to copy an image MIME type, not plain-text markup.
3. If copying is unavailable, use the offered Save fallback. **Save** also lets you
   select a format and path directly.
4. Choose a new filename: existing files and symlinks are **never overwritten**.
   The destination is on the computer running the TUI, not necessarily your desktop.

### Clipboard requirements

- Local Linux Wayland uses an existing `wl-copy`; X11 uses an existing `xclip`.
- SSH-forwarded X11 works only when the TUI inherits a working forwarded `DISPLAY`
  and has `xclip` on PATH. After reconnecting SSH, launch the TUI from the new
  connection. Terminal click-drag selection does not prove image clipboard access.
- X11 copy checks that the requested MIME type is offered on that display. It does
  not read clipboard contents or prove a destination application pasted them.
- SVG uses `image/svg+xml`; PNG uses `image/png`. Destination applications differ
  in SVG support; PNG is often more portable.
- Unsupported platforms, missing helpers, failed display connections, or missing
  MIME formats give an actionable error and Save fallback. Nothing is installed
  automatically, and success is not claimed without helper/format confirmation.

See [setup troubleshooting](setup.md#cost-and-troubleshooting) for authoring issues.
