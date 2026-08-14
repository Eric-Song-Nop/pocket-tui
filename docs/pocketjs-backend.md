# PocketJS 0.6 backend

`@pocket-tui/pocketjs` is the reference PocketJS 0.6 `HostOps` backend for
PocketTUI. It lets PocketJS keep ownership of component state and lifecycle
while PocketTUI owns the terminal surface, native scene, damage tracking, and
ANSI output.

This is the backend used by the **RULE//SHIFT** rule-rewriting puzzle campaign
and the **Signal Below** roguelike. Neither game imports `CellBuffer`, creates a
PocketTUI `Canvas`, or writes ANSI. Their application layers create retained
PocketJS text and view nodes. Canvas is an internal boundary used by the
backend after those nodes have been laid out and rasterized.

## Data path

```text
Solid signals and memos
        │
        │ PocketJS lifecycle and Solid renderer effects
        ▼
PocketJS 0.6 HostOps calls
createNode · insertBefore · setProp · replaceText · setFocus · ...
        │
        ▼
@pocket-tui/pocketjs
validated retained shadow tree · style resolution · cell layout
viewport raster · ANSI16/truecolor conversion · styled-run compaction
        │
        │ CanvasFrame (terminal-independent styled row runs)
        ▼
@pocket-tui/core CanvasHandle.present()
        │ PTX1 transaction
        ▼
Rust SceneDB · grapheme/style catalogs · persistent row damage
        │ minimal terminal transition for the detected damage
        ▼
terminal
```

The application is retained at the PocketJS/HostOps boundary: mounting creates
the nodes once, and signal changes become `setProp` or text mutations. The
backend stores those mutations in a generational JS shadow tree and skips
rasterization when it is clean.

The reference backend is not yet the final native incremental renderer
described in [the architecture document](architecture.md). When dirty, it lays
out the active shadow tree and rasterizes the bounded viewport in JavaScript,
then submits a complete semantic `CanvasFrame`. The Rust renderer still compares
persistent rows and emits only actual terminal damage. There are no sparse
Canvas patch opcodes yet.

## Current retained model

The backend implements PocketJS `view`, `text`, and `image` nodes with:

- generational IDs, stale-handle rejection, cycle checks, and a maximum tree
  depth of 64;
- parent/child ordering, detach, move, recursive destroy, focus, active state,
  and paint-order hit testing;
- PocketJS v2 style tables with base, focus, and active variants;
- cell flex rows and columns, grow/shrink/basis, min/max dimensions, gap,
  padding, margin, absolute positioning, clipping, display, and z-order;
- flat background, opacity, one-cell borders, text color/alignment, line
  height, tracking, grapheme-aware wrapping, and wide-cell ownership;
- a viewport limit of 1,000,000 addressable cells.

This is deliberately a reference subset. Flex wrapping, gradients, rounded
corners, shadows, bevels, transforms, arcs, and other pixel-oriented PocketJS
properties are not rendered. Known but unsupported properties are counted in
diagnostics rather than silently presented as supported.

## Color modes

`PocketTuiHostOptions.colorMode` has two explicit modes:

- `"ansi16"` composites PocketJS ABGR colors and maps the result to the nearest
  fixed ANSI 16-color entry. This is the conservative default.
- `"truecolor"` preserves the composited 24-bit RGB value in the Canvas run.

There is no active terminal color probe in this backend. If
`POCKET_TUI_GHOSTTY_EFFECTS=1` is present, the default changes to `truecolor`;
an explicit `colorMode` always makes the choice clearer. Signal Below sets the
mode explicitly: ordinary terminals use ANSI16 and its Ghostty launcher opts
into truecolor.

Ghostty's effect bus is separate from color conversion and separate from
PocketJS `HostOps`. It is an optional, typed PocketTUI surface channel. A normal
terminal receives the complete cell-rendered game without it.

## Input and frame contract

`PocketTuiSession.run()` is currently a fixed-rate polling loop:

- `fps` defaults to 30 and accepts Pocket's exact clock divisors: 1, 2, 3, 4,
  5, 6, 10, 12, 15, 20, 30, or 60;
- each step polls terminal input, runs one PocketJS frame, renders if the host
  is dirty, and flushes with `"terminal"` semantics;
- a clean host reuses its previous frame and increments `skippedFrames`, but
  the session still wakes at the configured rate;
- the adapter does not pass a wall-clock delta into PocketJS `onFrame`.

Terminal input is edge-based, so one mapped button pulse is followed by one
release frame. The effective repeated-press rate is therefore at most half the
configured frame rate. Pending pulses are bounded to eight. The default
`directionPulsePolicy: "latest"` coalesces all pending directions when a newer
direction arrives, preventing stale terminal autorepeat from replaying after a
key is released. `directionPulsePolicy: "queue"` instead preserves directions
in arrival order for discrete, turn-based controls. Under either policy,
overflow discards the oldest pending pulse. The option accepts only `"latest"`
or `"queue"`; invalid runtime values fail before mounting or starting a
surface. The adapter uses a neutral analog value and does not synthesize
key-held state because the terminal does not provide matching key-up events.

One mapper result may be a single button mask or a sequence of at most eight.
The default mapper turns every recognized character in one batched terminal
text event into a pulse before applying the queue policy; a later quit or
action character is therefore not hidden by an earlier movement character.

The default mapper covers arrows, WASD/HJKL, Space/P, `.`, R/Enter,
Q/Escape/Ctrl-C, and Backspace. Applications can replace it with `mapInput` or
inspect and consume events first with `onInput`. Resize events are applied when
the fixed-rate input poll observes them.

For deterministic tests or external scheduling, call `session.step()` directly
instead of `session.run()`.

The selected `fps` is published as Pocket's `__simHz` policy while mount
latches its virtual clock, so one real pump second is one virtual second.
PocketJS 0.6 keeps its renderer root and frame handler in process-global state;
the adapter therefore allows one active session per process and fails a second
mount before touching its surface. Normal close and failed-mount cleanup both
release that lease and reset the shared renderer mirror plus pack, class,
texture, and sprite registries. The class reset uses a pinned 0.6.0
compatibility bridge because that release does not export the helper from its
package map.

## Explicit fallbacks and telemetry

Pixel-oriented PocketJS operations have bounded terminal fallbacks:

| PocketJS request | Reference-backend behavior | Diagnostic |
| --- | --- | --- |
| Texture upload | Returns `-1` | `unsupportedTextures` |
| Image node | Renders a `▧` placeholder | `unsupportedImages` when a texture is assigned |
| Sprite sequence | Keeps the image placeholder | `unsupportedSprites` |
| Timed animation | Applies the final value immediately | `collapsedAnimations` |
| Font atlas | Ignores the atlas | `ignoredFontAtlases` |
| Known unsupported style | Stores but does not paint the property | `unsupportedProperties` |

`session.diagnostics` also reports live nodes, HostOps mutations, rendered and
skipped frames, the latest compact run count, and missing style references.
Signal Below exposes a small `HOST LINK` sample of these counters in its
receiver rail so the retained backend is observable while playing.

## Mounting a PocketJS application

```ts
import { mountPocketTui } from "@pocket-tui/pocketjs";

const ghostty = process.env.POCKET_TUI_GHOSTTY_EFFECTS === "1";
const session = await mountPocketTui(() => App(), {
  tui: {
    surface: "alternate",
    effectBus: ghostty ? "ghostty-palette-v1" : undefined,
  },
  colorMode: ghostty ? "truecolor" : "ansi16",
  fps: 30,
});

await session.run();
```

The package executes the real `@pocketjs/framework@0.6.0` runtime. A local
type facade pins the narrow 0.6 `HostOps`, lifecycle, input, and Solid-renderer
contract so the dependency's source TypeScript does not inherit this
workspace's compiler settings. The executable adapter currently requires Bun:
PocketJS 0.6 publishes TypeScript source in its npm artifact, which ordinary
Node does not execute from `node_modules`.

## Build and run the demos

From the repository root:

```bash
bun install
bun run build
```

Run the ANSI16 base game in the current terminal:

```bash
cd examples/roguelike
bun run start
```

Or open a fresh Ghostty surface with truecolor and the optional shader channel:

```bash
cd examples/roguelike
bun run ghostty
```

The launcher requires Ghostty 1.3 or newer and does not edit global Ghostty
configuration. See the [Signal Below README](../examples/roguelike/README.md)
for controls and its [dedicated Ghostty document](../examples/roguelike/GHOSTTY.md)
for shader-specific details.

The rule-puzzle campaign exercises the same HostOps path with a deterministic
word-rule engine, stable retained node pools, immediate rule recomputation,
undo/restart/level transitions, responsive layout, and signal-driven print
effects:

```bash
cd examples/rule-shift
bun run start
```

Use `bun run ghostty` in that directory for the optional Syntax Loom pass. Its
portable terminal frame remains the complete game; the shader is only a typed,
reversible effect-bus consumer.
