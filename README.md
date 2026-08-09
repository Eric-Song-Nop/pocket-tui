# PocketTUI

PocketTUI is an architecture-first, terminal-native runtime for TypeScript and JavaScript applications. The repository now contains a runnable alternate-screen MVP backed by Rust, N-API, and a small TypeScript API.

The target cost model is:

```text
work = semantic delta + materialized viewport + actual damage + emitted bytes
```

The MVP is intentionally narrower than the complete design in [`docs/architecture.md`](docs/architecture.md). That document is the destination, not a claim that every subsystem described there is already implemented.

## Implemented today

### Native core

- A generational `SceneDB` with `Box`, `Text`, and `Transcript` primitives.
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

- Nonblocking input polling for UTF-8 text, basic control and arrow keys, and bracketed paste; the typed event ABI reserves a resize event for the upcoming signal hook.
- A bounded incremental decoder: 64 KiB maximum undecoded input and 16 KiB paste chunks by default.
- A stable N-API v8 boundary for submit/start/flush/input/stats/close.
- TypeScript handles for `TuiApp`, `Box`, `Text`, native transcripts, transcript blocks, and virtual transcript views.
- Automatic microtask batching into PTX packets, native artifact loading, explicit flush/close, and memory statistics.

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
cd examples/basic
bun run start
```

`bun run build` compiles the Rust N-API library, places the platform-specific `.node` file under `packages/core/native`, and builds the TypeScript package. The example streams ordered chunks into a native DocumentDB block, seals it, displays memory statistics, polls one input event, and restores the terminal when it closes.

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

Explicit `close()` is the correctness path; native drop restoration is a last-resort guard.

## Repository layout

```text
crates/pocket-tui-core       SceneDB, DocumentDB, layout, cells, frame artifacts
crates/pocket-tui-terminal   terminal state, input, transition encoder, transport
crates/pocket-tui-napi       PTX decoder and Node/Bun native binding
packages/core                public TypeScript API and PTX encoder
examples/basic               runnable streaming transcript example
docs/architecture.md         complete target design and invariants
```

## Honest MVP gaps

- Only alternate-screen mode is runnable. Main-screen scrollback and direct surfaces are not implemented.
- The primitive set is limited to Box, Text, and follow-tail Transcript; there is no JSX compiler, signals runtime, rich text/Markdown, input widget, focus tree, selection, hit testing, or general virtual list yet.
- Transcript indexing is a compact logical-line summary, not the planned width-aware B+ height index. There is no sealed-block compression, disk spill, eviction, or provider reload yet.
- Transcript lines are tail-clipped to the viewport width rather than fully reflowed into cached wrapped rows.
- Terminal capabilities use a conservative profile. Active probing, main-screen-safe cursor planning, scroll-operation cost planning, Kitty keyboard, mouse/focus/IME, OSC 8, synchronized-update negotiation, and Kitty/Sixel images remain roadmap work.
- Input delivery is polled by JavaScript; the planned bounded native event ring and edge-trigger notification path are not present yet.
- PTX currently uses copied `Uint8Array` packets; SharedArrayBuffer transport and the full byte-budgeted scheduler are later milestones.
- Packaging and automated coverage are still development-grade. The current smoke/contract tests protect core invariants but are not a portability or compatibility matrix.

The project prioritizes a coherent, measurable runtime foundation over a broad widget catalog. Performance claims will be published only with reproducible benchmarks and pinned comparison versions.
