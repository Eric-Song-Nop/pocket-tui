# PocketTUI

PocketTUI is an architecture-first, terminal-native runtime for TypeScript and JavaScript applications. The repository contains a runnable alternate-screen runtime backed by Rust, N-API, and a small TypeScript API, plus **Signal Below**, a shader-enhanced roguelike built as the flagship retained-backend demo for PocketJS 0.6.

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

- A versioned, little-endian PTX1 binary transaction format shared by TypeScript and Rust.
- Semantic operations for scene creation/mutation and transcript create/open/append/seal/mount.
- An alternate-screen terminal guard that restores terminal modes on close/drop.
- Separate desired, in-flight, and confirmed terminal state. The confirmed baseline advances only after the complete patch is written.
- Damage-aware ANSI transitions, retained partial-write suffixes, and bounded pending output.
- Conservative color/style encoding without claiming capabilities the terminal has not advertised.

### Input and public API

- Nonblocking input polling for UTF-8 text, basic control and arrow keys, bracketed paste, and coalesced viewport changes.
- A bounded incremental decoder: 64 KiB maximum undecoded input and 16 KiB paste chunks by default.
- A stable N-API v8 boundary for submit/start/flush/input/stats/close.
- TypeScript handles for `TuiApp`, `Box`, `Text`, native transcripts, transcript blocks, and virtual transcript views.
- A fixed-size `CellBuffer` that compacts adjacent equal-style cells into Canvas row runs; Canvas frames stay inside the versioned PTX transaction and native damage pipeline rather than embedding ANSI in strings.
- Live viewport dimensions from `TIOCGWINSZ`, resize events coalesced through input polling, a one-million-cell allocation safety limit, and explicit final cursor position/color state for IME- and shader-style integrations.
- Automatic microtask batching into PTX packets, native artifact loading, explicit flush/close, and memory statistics.

### PocketJS 0.6 reference backend

- `@pocket-tui/pocketjs` implements the real PocketJS 0.6 `HostOps` contract. PocketJS and Solid own signals, components, button handlers, and frame lifecycle; the backend owns a validated retained shadow tree.
- Host mutations are laid out in terminal cells and rasterized into compact, terminal-independent Canvas runs. The backend—not the game—owns `CanvasHandle.present()`, PTX1 transport, and the handoff to Rust damage tracking.
- The reference backend supports an explicit conservative `ansi16` mode and an opt-in `truecolor` mode. It does not probe terminal color capabilities.
- Terminal input becomes bounded Pocket button pulses, with latest-direction coalescing and one release frame after each press. The session is currently a fixed-rate loop rather than the target event-driven scheduler.
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

Run the roguelike in any terminal:

```bash
cd examples/roguelike
bun run start
```

Or launch it in a fresh Ghostty surface with its opt-in aura shader:

```bash
cd examples/roguelike
bun run ghostty
```

The Ghostty launcher changes no global configuration. See [`examples/roguelike/README.md`](examples/roguelike/README.md) for controls and [`examples/roguelike/GHOSTTY.md`](examples/roguelike/GHOSTTY.md) for the shader contract and limitations.

`bun run build` compiles the Rust N-API library, places the platform-specific `.node` file under `packages/core/native`, and builds both TypeScript packages. The basic example streams ordered chunks into a native DocumentDB block, seals it, displays memory statistics, polls one input event, and restores the terminal when it closes.

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

Explicit `close()` is the correctness path; native drop restoration is a last-resort guard.

## Repository layout

```text
crates/pocket-tui-core       SceneDB, DocumentDB, layout, cells, frame artifacts
crates/pocket-tui-terminal   terminal state, input, transition encoder, transport
crates/pocket-tui-napi       PTX decoder and Node/Bun native binding
packages/core                public TypeScript API and PTX encoder
packages/pocketjs            PocketJS 0.6 HostOps retained reference backend
examples/basic               runnable streaming transcript example
examples/roguelike           retained PocketJS roguelike and optional Ghostty shader
docs/architecture.md         complete target design and invariants
docs/pocketjs-backend.md      current backend data path and compatibility limits
```

## Honest MVP gaps

- Only alternate-screen mode is runnable. Main-screen scrollback and direct surfaces are not implemented.
- The native primitive set is limited to Box, Text, Canvas, and follow-tail Transcript; there is no PocketTUI-native JSX compiler, signals runtime, rich text/Markdown, input widget, focus tree, selection, or general virtual list yet. The PocketJS package reuses the real PocketJS 0.6 Solid renderer and provides reference-backend cell layout and paint-order hit testing, not those planned native systems.
- Transcript indexing is a compact logical-line summary, not the planned width-aware B+ height index. There is no sealed-block compression, disk spill, eviction, or provider reload yet.
- Transcript lines are tail-clipped to the viewport width rather than fully reflowed into cached wrapped rows.
- Terminal capabilities are conservative ANSI16 by default and may be set explicitly to truecolor; the flagship demo makes that choice only for its opt-in Ghostty path. Capabilities are not actively probed. Main-screen-safe cursor planning, scroll-operation cost planning, Kitty keyboard, mouse/focus/IME, OSC 8, synchronized-update negotiation, and Kitty/Sixel images remain roadmap work.
- Resize changes are detected while JavaScript polls input; there is not yet an edge-triggered SIGWINCH event producer. Canvas currently submits bounded full semantic frames, after which native row damage still limits terminal output; sparse Canvas patch opcodes are future work.
- Input delivery is polled by JavaScript; the planned bounded native event ring and edge-trigger notification path are not present yet.
- PTX currently uses copied `Uint8Array` packets; SharedArrayBuffer transport and the full byte-budgeted scheduler are later milestones.
- Packaging and automated coverage are still development-grade. `prepack` builds
  the native artifact for the current host so a source checkout can produce a
  same-platform tarball, but there is not yet a cross-platform prebuilt-binary
  matrix or per-platform optional package. The current smoke/contract tests
  protect core invariants but are not a portability or compatibility matrix.

The project prioritizes a coherent, measurable runtime foundation over a broad widget catalog. Performance claims will be published only with reproducible benchmarks and pinned comparison versions.
