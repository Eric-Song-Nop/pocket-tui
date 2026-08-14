# Signal Below

**Signal Below** is a complete turn-based roguelike and the flagship
`@pocket-tui/pocketjs` retained-backend demo. It runs as a full ANSI16 game in
an ordinary terminal. Ghostty adds truecolor plus an optional palette-aware
aura, movement trails, bloom, and event pulses.

The game is not a direct Canvas example. It uses Solid signals and PocketJS
lifecycle hooks to update retained PocketJS 0.6 nodes:

```text
game + pure presentation model
        ↓ Solid signals / PocketJS lifecycle
retained PocketJS view and text nodes
        ↓ HostOps mutations
@pocket-tui/pocketjs shadow tree, cell layout, and raster
        ↓ compact CanvasFrame runs
PocketTUI Canvas → PTX1 → Rust row damage → terminal
```

The Canvas is created inside the backend surface. No game module imports
`CellBuffer`, creates a `CanvasHandle`, or emits ANSI. See the
[PocketJS backend document](../../docs/pocketjs-backend.md) for the exact
supported subset and its explicit fallbacks.

## Build and play

Build PocketTUI once from the repository root:

```bash
bun install
bun run build
```

Run the conservative ANSI16 version in the current terminal:

```bash
cd examples/roguelike
bun run start
```

Open a fresh Ghostty 1.3+ surface with truecolor and the opt-in shader channel:

```bash
cd examples/roguelike
bun run ghostty
```

The launcher never edits the user's Ghostty configuration. Manual setup and
the shader contract are documented in [`GHOSTTY.md`](GHOSTTY.md).

Pass `--seed=<value>` for a reproducible dungeon:

```bash
bun run start --seed=ghost-signal
```

## Controls

- Arrow keys, WASD, or HJKL: move or melee
- Space or P: spend energy on an area pulse
- `.`: wait one turn
- R or Enter: restart after winning or dying
- Q, Escape, or Ctrl-C: quit

Reach the bright `◆` signal gate. Crawlers pursue, brutes hit hard at close
range, and watchers fire down clear lines. Medkits restore hull integrity,
batteries restore pulse energy, and relics increase score.

## What the demo exercises

- A deterministic, terminal-independent rules engine with connected dungeon
  generation, field-of-view memory, three enemy behaviors, items, combat,
  win/death/restart, and semantic visual events.
- A pure `present(game, timeline, viewport, now)` model that composes sparse
  terrain, actors, effect layers, responsive panels, cursor intent, and an
  optional semantic effect signal without importing PocketTUI.
- Real Solid signals plus PocketJS button and frame lifecycle, mounted once
  against the real PocketJS 0.6 `HostOps` interface.
- A bounded retained text-run pool. Actor and panel slots keep stable keys;
  terrain and effect runs stay in separate fixed layers. If a layer exceeds
  its capacity, the UI shows `HOST DROP` instead of growing without a bound.
- `HOST LINK` telemetry for live node count, HostOps mutations, and rendered
  frame generation, making the backend boundary visible in the game itself.
- PocketTUI's internal Canvas/PTX1 handoff, Rust grapheme/style catalogs,
  persistent row comparison, and damage-aware terminal output.

## Current constraints

The session runs at 30 PocketJS frames per second. Terminal keys are modeled as
a press frame followed by a release frame; pending input is capped at eight and
direction repeats coalesce to the newest direction. Animation time is sampled
deterministically at `1000 / 30` milliseconds per Pocket frame rather than from
a wall-clock delta.

The ordinary path explicitly quantizes presentation colors to ANSI16. The
Ghostty launcher explicitly selects truecolor and enables the semantic effect
bus. Without that opt-in, shader-only bloom and trails disappear, while the
map, effects, panels, controls, and complete game rules remain available.

Run the deterministic game and presentation tests from this directory with:

```bash
bun run test
```

Run the full TypeScript, protocol, native-core, terminal, backend, and game
suite from the repository root with `bun run test`.
