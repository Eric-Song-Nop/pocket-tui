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
        │ CanvasFrame + exact dirty-row hint
        ▼
@pocket-tui/core CanvasHandle.present()
        │ PTX1 full frame or revision-guarded row replacement
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
described in [the architecture document](architecture.md). It now distinguishes
full-layout, cache-aware Flex, localized absolute-layout, and paint-only
dirtiness. Paint-only frames reuse cached rectangles and flattened text and
refresh only changed computed styles. Geometry or text mutations beneath a
retained absolute-positioned node rerun the same solver only for the nearest
isolated subtree; absolute children cannot affect their parent's Flex
measurement. Other Flex mutations run the root solver with persistent subtree
revisions, exact available-width/height measurement keys, and same-size clean
subtree geometry reuse. Moved clean subtrees translate without internal layout.
Incremental paths reraster the union of affected old/new rows. Tree structure,
style references/tables, focus, active state, and viewport size retain full
JavaScript layout and bounded viewport rasterization as the oracle.

Cache-aware Flex reduces solver work but still scans direct siblings on dirty
ancestor paths. Layout, flattened-text, measurement, and revision candidates
use copy-on-write transaction maps: failed presents discard their patches, and
successful presents apply only touched keys to the last confirmed maps. Those
same touched keys bound old/new layout damage comparison. Rasterization still
traverses the full scene to rebuild paint order and retains a complete semantic
`CanvasFrame` in JavaScript. Incremental paths also provide the exact dirty-row
set. Core emits PTX1 whole-row replacements when the native feature bit is
present and the aligned patch record is smaller than the full record. Each
patch names the exact retained Canvas revision and dimensions; first frames,
resizes, dense changes, and older native artifacts fall back to complete
frames. Rust then compares persistent rows and emits only actual terminal
damage.

## Current retained model

The backend implements PocketJS `view`, `text`, and `image` nodes with:

- generational IDs, stale-handle rejection, cycle checks, and a maximum tree
  depth of 64;
- parent/child ordering, detach, move, recursive destroy, focus, active state,
  and paint-order hit testing;
- PocketJS document-order focus traversal, focus scopes/grids, detach repair,
  active press state, and small headless `Button`, `Checkbox`, and `TextInput`
  components;
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

`PocketTuiSession.run()` has two explicit scheduler policies:

- `fps` defaults to 30 and accepts Pocket's exact clock divisors: 1, 2, 3, 4,
  5, 6, 10, 12, 15, 20, 30, or 60;
- `framePolicy: "fixed"` is the compatibility default and advances at the
  configured cadence using monotonic deadlines without catch-up storms;
- `framePolicy: "adaptive"` treats `fps` as a maximum cadence and sleeps when
  there is no input edge, button press/release, retained mutation, surface
  command, continuous lifecycle lease, demand frame, or explicit request;
- readiness drains and rearms the terminal parser immediately; the next legal
  step delivers those cached events, runs exactly one PocketJS frame, renders
  if the host is dirty, and flushes only when the surface has pending commands;
- a clean host reuses its previous frame and increments `skippedFrames`;
- the adapter does not pass a wall-clock delta into PocketJS `onFrame`.

The real terminal surface arms a native one-shot readiness watcher after each
drain. Its poll thread owns duplicated descriptors but never reads stdin;
parser state stays under `RuntimeAdapter`'s single-owner mutex. It also carries
the parser-owned standalone-Escape deadline and checks the authoritative output
tty's viewport every 250 ms. An unchanged viewport only rearms the native
deadline; JavaScript wakes when dimensions actually change. A custom surface
without readiness falls back to `idlePollMs` (1000 ms by default).

Public `onFrame` and `createSpriteAnimation` registrations hold a continuous
adaptive lease. The facade's deterministic `after()` holds a lease through its
virtual deadline. `onDemandFrame()` requests its next callback by returning
`true`, and `requestFrame()` schedules one tick. Solid effects need no manual
request: the first clean-to-dirty HostOps mutation is itself a wake source.
Lifecycle hooks and components must come from `@pocket-tui/pocketjs` for that
contract. Direct PocketJS 0.6 component imports use its bare-Solid lifecycle
graph and remain outside this backend's lifecycle contract; `fixed` only avoids
their missing adaptive lease while an application migrates to facade exports.
Input readiness drains and rearms the native parser immediately, even while the
maximum-cadence gate is closed. Completed typed and resize events are retained
until the next legal Pocket frame; that separation preserves Escape parsing
without accelerating virtual time, including edges delivered during an
asynchronous flush. Each resize is applied before its own application input
callback, and all queued resizes are applied before frame dispatch. The
retained queue is capped at 4096 events and 2 MiB of UTF-8 text, coalesces
adjacent resize snapshots, and fails explicitly on overflow rather than
dropping ordered input. Because the overflowing batch has already left the
surface, that failure remains fatal until the session closes.

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
Q/Escape/Ctrl-C, and Backspace. A focused `Button` specializes Enter to CIRCLE
without changing Enter's START mapping elsewhere. A focused `TextInput`
consumes text, paste chunks, editing keys, and submit before button mapping,
and anchors the real terminal cursor after layout. Applications can replace
button mapping with `mapInput` or inspect and consume events first with
`onInput`. Each resize event synchronizes the Host viewport and both
Pocket-owned root layers before that event's application callback runs; all
queued resize events are applied before frame dispatch.

For deterministic tests or external scheduling, call `session.step()` directly
instead of `session.run()`. Steps are single-flight and cannot overlap the run
loop. Closing waits for an already accepted step to reach its teardown-safe
point; a step requested after close is rejected.

The selected `fps` is published as Pocket's `__simHz` policy while mount
latches its virtual clock. Fixed mode (and adaptive mode while a continuous
lease is active) advances that many virtual frames per wall-clock second;
adaptive idle deliberately pauses the deterministic virtual clock.
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
skipped frames, full/cached/localized/reused layout frames,
recomputed/measured/reused layout nodes, relayout roots, full and incremental
raster frames, last/total repainted rows, the latest compact run count, missing
style references, `framePolicy`, `steppedFrames`, `idleWaits`, and `wakeSignals`.
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
  framePolicy: "adaptive",
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
