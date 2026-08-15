# PocketTUI

PocketTUI is an architecture-first, terminal-native runtime for TypeScript and JavaScript applications. The repository contains a runnable alternate-screen runtime backed by Rust, N-API, and a small TypeScript API, plus two retained PocketJS 0.6 showcases: **Pocket Tasks**, a keyboard-first Solid-style todo list, and **RULE//SHIFT**, an animated rule-rewriting puzzle campaign.

The target cost model is:

```text
work = semantic delta + materialized viewport + actual damage + emitted bytes
```

The MVP is intentionally narrower than the complete design in [`docs/architecture.md`](docs/architecture.md). That document is the destination, not a claim that every subsystem described there is already implemented.

## Implemented today

### Native core

- A generational `SceneDB` with `Box`, `Text`, `Transcript`, and styled `Canvas` primitives.
- Integer row/column layout for nested row and column boxes.
- Pointer-free 16-byte cells, grapheme/style catalogs, wide-cell lead/continuation invariants, persistent row snapshots, and precise dirty spans.
- A separate generational `DocumentDB` whose blocks move explicitly from `Open` to `Sealed`.
- Ordered UTF-8 block append with a hard document byte budget and native memory/count telemetry.
- Follow-tail transcript rendering that walks only enough newest indexed blocks and logical lines to fill the visible rectangle. Sealed history does not become Scene nodes.

### Transactions and terminal

- A versioned, little-endian PTX1 binary transaction format shared by TypeScript and Rust, including revision-guarded whole-row Canvas replacement when both sides advertise support.
- Semantic operations for scene creation/mutation and transcript create/open/append/seal/mount.
- An alternate-screen terminal guard that enables bracketed paste and restores terminal modes on close/drop, including failed setup.
- Separate desired, in-flight, and confirmed terminal state. The confirmed baseline advances only after the complete patch is written.
- Damage-aware ANSI transitions, retained partial-write suffixes, and bounded pending output.
- Conservative color/style encoding without claiming capabilities the terminal has not advertised.

### Input and public API

- Nonblocking input draining for UTF-8 text, arrows, Tab/Shift-Tab, Home/End/Delete, Page Up/Page Down, control keys, bracketed paste, and coalesced viewport changes, plus a one-shot native readiness edge that never reads or owns parser bytes.
- A bounded incremental decoder: 64 KiB maximum undecoded input and 16 KiB paste chunks by default.
- A stable N-API v8 boundary for submit/start/flush/readiness/input/stats/close.
- TypeScript handles for `TuiApp`, `Box`, `Text`, native transcripts, transcript blocks, and virtual transcript views.
- A fixed-size `CellBuffer` that compacts adjacent equal-style cells into Canvas row runs; Canvas frames stay inside the versioned PTX transaction and native damage pipeline rather than embedding ANSI in strings. Dirty-row hints use sparse whole-row PTX records only when they are smaller than a full frame, with automatic full-frame fallback for first frames, resizes, dense changes, and older native artifacts.
- Live viewport dimensions from `TIOCGWINSZ`, resize events coalesced through input polling, a one-million-cell allocation safety limit, and explicit final cursor position/color state for IME- and shader-style integrations.
- Automatic microtask batching into PTX packets, generation-safe explicit flush/close, native artifact loading, and memory statistics.

### PocketJS 0.6 reference backend

- `@pocket-tui/pocketjs` implements the real PocketJS 0.6 `HostOps` contract. PocketJS and Solid own signals, components, button handlers, and frame lifecycle; the backend owns a validated retained shadow tree.
- The PocketJS package exposes retained reactive `View` and `Text` primitives,
  the runtime's document-order focus manager, scopes/grids, detach repair,
  focus-change notifications, and headless terminal `Button`, `Checkbox`, and
  grapheme-aware `TextInput` components with a real cursor anchor and a
  horizontally windowed single-line viewport.
- Host mutations are tracked as full-layout, cached-Flex, localized-absolute, or paint-only work. Paint changes refresh only mutated styles and reuse cell geometry. Geometry and text changes inside retained absolute islands recompute only those roots; ordinary row/column Flex changes run the same root solver with exact revision/constraint caches, skipping clean measurements and same-size subtrees. A retained paint index patches the affected subtrees, queries dirty-row candidates through sparse segment indexes, and preserves exact z/document order and hit-test semantics without walking the full scene on ordinary incremental frames. Tree, style-table, interaction, resize, and forced frames retain the recursive full oracle. The backend—not the application—owns `CanvasHandle.present()`, PTX1 transport, and the handoff to Rust damage tracking.
- The reference backend supports an explicit conservative `ansi16` mode and an opt-in `truecolor` mode. It does not probe terminal color capabilities.
- Terminal input becomes bounded Pocket button pulses, with a latest-direction policy for real-time apps or an ordered queue for turn-based apps, plus one release frame after each press. Printable text can retain native batches or opt into ordered grapheme routing. Sessions offer compatibility-first fixed cadence or opt-in adaptive scheduling driven by native input/resize readiness, retained mutations, frame leases, and explicit requests.
- Pixel-only PocketJS features degrade explicitly: images use a placeholder, textures and sprites are unsupported, font atlases are ignored, and timed animation resolves immediately to its endpoint. Diagnostics count every fallback.

See [`docs/pocketjs-backend.md`](docs/pocketjs-backend.md) for the complete data path, supported subset, frame/input contract, and degradation behavior.

## Build and run

Prerequisites:

- Rust 1.85 or newer
- Bun 1.2 or newer
- Node.js 20 or newer (the current native build script uses Node to place the N-API artifact)
- A real terminal/TTY for the alternate-screen example

From the repository root:

```bash
bun install
bun run check
bun run build
```

Run the imperative transcript example:

```bash
cd examples/basic
bun run start
```

Run the PocketJS + Solid-style todo list:

```bash
cd examples/todo-list
bun run start
```

Pocket Tasks exercises retained `View`/`Text` primitives, text entry and cursor
placement, Pocket focus, filtering, responsive layout, and a bounded visible
list without importing Canvas or writing ANSI. See
[`examples/todo-list/README.md`](examples/todo-list/README.md) for controls and
the retained-slot rationale.

Run the rule-rewriting puzzle campaign through the same retained PocketJS
backend:

```bash
cd examples/rule-shift
bun run start
```

Its optional Ghostty profile is also launcher-scoped:

```bash
bun run ghostty
```

`RULE//SHIFT` uses original stages, names, glyphs, and presentation. It is a
clean-room mechanics study rather than a distribution of another game's level
layouts or assets. See [`examples/rule-shift/README.md`](examples/rule-shift/README.md)
for its campaign and controls.

`bun run build` compiles the Rust N-API library, places the platform-specific `.node` file under `packages/core/native`, and builds both TypeScript packages. The basic example streams ordered chunks into a native DocumentDB block; Pocket Tasks exercises the PocketJS reference backend as a conventional Solid-style application.

For Rust-only iteration:

```bash
cargo check --workspace
cargo test -p pocket-tui-core -p pocket-tui-terminal
```

## Minimal API shape

```ts
import { createTui } from "@pocket-tui/core";

const app = createTui({ surface: "alternate" });
const transcript = app.transcript();
const root = app.box({ direction: "column", padding: 1 });

root.virtualTranscript(transcript);
root.text("PocketTUI MVP");
app.mount(root);

await app.start();
const block = transcript.openBlock();
block.appendText("streamed through native DocumentDB");
block.seal();
await app.flush("terminal");
await app.close();
```

Custom styled surfaces use semantic cells rather than terminal escape strings:

```ts
import { CellBuffer, createTui } from "@pocket-tui/core";

const app = createTui();
const canvas = app.canvas();
const cells = new CellBuffer(40, 12);

cells.set(8, 4, "@", {
  foreground: { kind: "indexed", index: 14 },
  bold: true,
});
canvas.present(cells.frame());
app.mount(canvas);
```

Callers that retain the preceding frame may pass
`canvas.present(nextFrame, { dirtyRows })`. The hint is a contract: every
listed row is replaced in full and every omitted row must be unchanged. Core
uses a revision-checked sparse PTX record only when it is supported and
strictly smaller than the complete frame.

Explicit `close()` is the correctness path; native drop restoration is a last-resort guard.

## Repository layout

```text
crates/pocket-tui-core       SceneDB, DocumentDB, layout, cells, frame artifacts
crates/pocket-tui-terminal   terminal state, input, transition encoder, transport
crates/pocket-tui-napi       PTX decoder and Node/Bun native binding
packages/core                public TypeScript API and PTX encoder
packages/pocketjs            PocketJS 0.6 HostOps retained reference backend
examples/basic               runnable streaming transcript example
examples/todo-list           PocketJS + Solid-style retained todo list
examples/rule-shift          retained PocketJS rule-puzzle campaign and Syntax Loom shader
docs/architecture.md         complete target design and invariants
docs/pocketjs-backend.md      current backend data path and compatibility limits
```

## Honest MVP gaps

- Only alternate-screen mode is runnable. Main-screen scrollback and direct surfaces are not implemented.
- The native primitive set is limited to Box, Text, Canvas, and follow-tail Transcript; there is no PocketTUI-native JSX compiler, signals runtime, rich text/Markdown, input widget, focus tree, selection, or general virtual list yet. The PocketJS package supplies these application-level concerns through the real PocketJS 0.6 Solid renderer and its reference-backend cell layout, not as native TUI widgets.
- PocketJS 0.6's published universal renderer resolves its keyed collection reconciler against Solid's server runtime under Bun's default Node condition. The facade therefore does not claim a working `<For>`/JSX collection surface yet; Pocket Tasks uses a fixed retained row pool over an unbounded model instead.
- Transcript indexing is a compact logical-line summary, not the planned width-aware B+ height index. There is no sealed-block compression, disk spill, eviction, or provider reload yet.
- Transcript lines are tail-clipped to the viewport width rather than fully reflowed into cached wrapped rows.
- Terminal capabilities are conservative ANSI16 by default and may be set explicitly to truecolor; Pocket Tasks selects ANSI16 explicitly, while RULE//SHIFT's optional Ghostty launcher selects truecolor. Capabilities are not actively probed. Main-screen-safe cursor planning, scroll-operation cost planning, Kitty keyboard, mouse/focus/IME, OSC 8, synchronized-update negotiation, and Kitty/Sixel images remain roadmap work.
- Resize readiness currently uses a native 250 ms `TIOCGWINSZ` change probe rather than an edge-triggered SIGWINCH producer. Unchanged probes stay entirely native and do not wake JavaScript. PocketJS locally reflows independent absolute subtrees, uses exact cached measurement/geometry for general Flex changes, and commits only touched layout and paint-index keys through copy-on-write transaction maps. Incremental rasterization queries retained row candidates instead of traversing the full scene; painted-membership or z-order changes still rebuild the global order, while full/forced frames run the recursive oracle. Incremental frames cross PTX as revision-guarded whole-row replacements when that record is smaller; first frames, resizes, dense changes, and older native artifacts safely use complete frames. Cached root passes still scan direct Flex siblings, and JavaScript still retains and scans a complete semantic `CanvasFrame` while compacting rows and choosing the PTX record.
- Input bytes are still drained on the JavaScript-owned `pollInput()` boundary immediately after a one-shot native readiness signal; completed events are bounded between Pocket frames to 4096 entries and 2 MiB of UTF-8 text, but the planned native event ring is not present yet.
- PTX currently uses copied `Uint8Array` packets; SharedArrayBuffer transport and the full byte-budgeted scheduler are later milestones.
- Packaging and automated coverage are still development-grade. `prepack` builds
  the native artifact for the current host so a source checkout can produce a
  same-platform tarball, but there is not yet a cross-platform prebuilt-binary
  matrix or per-platform optional package. The current smoke/contract tests
  protect core invariants but are not a portability or compatibility matrix.

The project prioritizes a coherent, measurable runtime foundation over a broad widget catalog. Performance claims will be published only with reproducible benchmarks and pinned comparison versions.
