# Pocket Tasks

**Pocket Tasks** is a keyboard-first, in-memory todo list built with the real
PocketJS 0.6 Solid renderer and the `@pocket-tui/pocketjs` terminal backend.
It is a conventional application example: text entry, focus, filtering,
responsive layout, and a virtualized list, with no game loop and no direct
Canvas or ANSI code.

```text
Solid signals and memos
        ↓
PocketJS View / Text / TextInput / Checkbox / Button
        ↓ HostOps mutations
@pocket-tui/pocketjs retained cell layout and raster
        ↓ CanvasFrame + dirty rows
PocketTUI PTX1 → Rust row damage → terminal
```

The Canvas boundary stays inside the backend. The application imports neither
`CellBuffer` nor `CanvasHandle` and never emits terminal escape sequences.

## Run it

Build the workspace once from the repository root:

```bash
bun install
bun run build
```

Then start the example in a real terminal:

```bash
cd examples/todo-list
bun run start
```

The example deliberately selects conservative ANSI16 output. Its Pocket blue,
mint, paper, slate, and carbon palette therefore works without terminal color
probing.

## Controls

- Type or paste in the composer; Enter adds a trimmed task.
- Arrow keys or Tab / Shift-Tab move Pocket focus.
- Enter or Space toggles the focused task.
- `x` or Backspace removes the focused task.
- `1`, `2`, and `3` select All, Open, and Done.
- `c` clears completed tasks; `/` focuses the composer (outside text entry).
- Page Up / Page Down move through longer lists.
- Q outside the composer, Escape, or Ctrl-C closes the session safely.

Home, End, Delete, grapheme-aware Backspace, UTF-8 text, and bracketed paste
work while the composer is focused. Long single-line titles keep the real bar
cursor inside a horizontally windowed text viewport.

## Why the list uses retained slots

The model can contain any number of todos, but the UI retains only eight row
components and points them at the current visible window. Resizing changes the
window capacity; crossing an edge with focus or Page Up / Page Down changes
the offset. Node identities remain stable while labels, checked state, colors,
and visibility update through Solid signals.

This is intentional for the current PocketJS 0.6 npm artifact. Under Bun's
default Node export condition, the upstream universal renderer binds its
dynamic collection reconciler to Solid's server runtime. The backend facade
uses Solid's interactive client runtime, so naïvely mixing an upstream keyed
`<For>` with facade signals would not reconcile. Retained slots demonstrate a
bounded TUI list without hiding that upstream limitation.

## What the example exercises

- Immutable todo operations and stable monotonic IDs.
- Facade-owned Solid signals and memos under Bun's default conditions.
- Reactive `View` and `Text` primitives plus headless terminal controls.
- Observable Pocket focus used for complete inline base/focus styles.
- Text input, real cursor placement, editing keys, and bracketed paste.
- Responsive cell layout and a bounded visible-list window.
- Ordered grapheme routing for command keys coalesced in one native text read.
- Adaptive scheduling: the session sleeps while model, input, and surface are
  clean, then wakes for retained mutations or terminal readiness.
- Stable retained node count across add, toggle, delete, filter, and resize.

On short terminals the header and progress meter collapse before task rows do;
on narrow or short terminals the action buttons hide and leave their keyboard
shortcuts available. Controls that are not painted are also removed from Pocket
focus traversal.

Run its pure model and backend integration coverage with:

```bash
bun run test
```
