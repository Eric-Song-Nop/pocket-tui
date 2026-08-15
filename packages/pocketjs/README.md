# `@pocket-tui/pocketjs`

A reference PocketJS 0.6 `HostOps` backend for terminal applications.
PocketJS owns component state, Solid renderer effects, focus, button handlers,
and frame lifecycle. This package owns a validated retained shadow tree, lays
it out in terminal cells, rasterizes it to compact styled runs, and hands those
runs to an internal PocketTUI Canvas surface.

An application using this package does not need to create a `CellBuffer` or
`CanvasHandle`. The full boundary is documented in
[`docs/pocketjs-backend.md`](../../docs/pocketjs-backend.md).

## Mount and run

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
  onInput(event, current) {
    if (event.kind === "key" && event.ctrl && event.key.toLowerCase() === "c") {
      current.requestClose();
      return true;
    }
  },
});

await session.run();
```

`mountPocketTui` mounts the real `@pocketjs/framework@0.6.0` runtime with the
backend's `HostOps`, starts the PocketTUI alternate-screen surface, and performs
the first terminal flush. `session.close()` disposes PocketJS and restores the
terminal; it is idempotent and is also called when `run()` exits.

Use `session.step()` when an external loop or a deterministic test should drive
one frame at a time. Steps are single-flight and cannot overlap `run()`;
`close()` waits for an already accepted step to reach its teardown-safe point.
An injectable `PocketTuiSurface` keeps HostOps contract tests independent of a
TTY.

`framePolicy: "fixed"` remains the compatibility default. The opt-in
`"adaptive"` policy sleeps when the tree and surface are clean, no button
edge is pending, and no lifecycle hook has leased another frame. Native stdin
readiness, actual viewport changes, Solid-driven HostOps mutations, and
`requestFrame()` wake it without a JavaScript polling timer. Custom surfaces
without a readiness source use `idlePollMs` as a bounded fallback.

## Focus and terminal components

The package exposes PocketJS's real retained focus manager rather than keeping
a second terminal-only focus tree. `focusNode`, `getFocused`, focus scopes, and
focus grids operate on the same mirror nodes that drive `HostOps.setFocus`,
focus/active style variants, detach repair, and CIRCLE presses.

`Button`, `Checkbox`, and `TextInput` are small headless components built on
that path. They do not require JSX or a second renderer:

```ts
import {
  Button,
  TextInput,
  createElement,
  createSignal,
  insertNode,
} from "@pocket-tui/pocketjs";

function App() {
  const [query, setQuery] = createSignal("");
  const root = createElement("view");
  insertNode(root, TextInput({
    value: query,
    onValueChange: setQuery,
    onSubmit: (value) => console.log(value),
    placeholder: "Search",
  }));
  insertNode(root, Button({
    label: () => `Open ${query()}`,
    onPress: () => console.log(query()),
  }));
  return root;
}
```

Text input consumes UTF-8 text, bracketed paste chunks, Enter, editing arrows,
and grapheme-aware Backspace only while it is focused. It anchors the real
terminal bar cursor to its laid-out text node. `onInput` still runs first and
can consume an event before a component sees it. With the default mapper,
Enter on a focused `Button` becomes Pocket CIRCLE so active/release state and
`onPress` use the ordinary Pocket lifecycle; elsewhere Enter retains its
existing START mapping. A custom `mapInput` remains a complete replacement.

The component defaults cover only cell geometry. Supply an inline style or a
loaded PocketJS class for visual design; this keeps class `focus:` and
`active:` variants free to override paint properties.

## Retained rendering behavior

HostOps creates and mutates stable `view`, `text`, and `image` records in a
generational shadow tree. Clean calls to `host.render()` return the previous
frame without layout or raster work. Paint-only mutations (`overflow`,
`zIndex`, background/opacity/border paint, and text color/alignment/tracking)
reuse the last cell geometry and flattened text. The backend refreshes computed
styles only for changed entries, unions the previous row bounds of every
changed subtree, and replays the scene only into those rows; unaffected compact
runs are retained. Geometry and text mutations below an absolute-positioned
node reuse its cached parent and run the same layout solver only for the nearest
isolated absolute subtree. Other row/column Flex mutations run a cache-aware
root pass: every retained subtree carries a monotonic layout revision,
measurements are keyed by the exact available width and height, same-size clean
subtrees retain their geometry, and moved clean subtrees translate as a unit.
The damage set compares old/new geometry and text, including fixed rectangles
whose line height changes. Tree, style-reference/table, focus, active-state,
and resize changes retain full layout and bounded viewport rasterization as the
correctness oracle.

This removes repeated Flex measurement and layout work, but is not yet an
end-to-end O(delta) renderer. A cached root pass still scans direct Flex
siblings. Frame candidates now write changed layout, text, measurement, and
revision records into copy-on-write transaction maps; a successful
`surface.present()` commits only those patches into the retained maps, while a
failed present discards them intact. Transaction touched keys also drive layout
damage comparison without a full map union. Rasterization still traverses the
retained scene to rebuild paint order even though it rerasterizes only dirty
rows. The surface retains a complete semantic `CanvasFrame`, but incremental
frames pass their exact dirty-row set to `@pocket-tui/core`. When the native
artifact advertises support and the aligned PTX record is smaller, core sends
revision-guarded whole-row replacements; first frames, resizes, dense changes,
and older native artifacts use a complete frame. Rust persistent row damage
then limits the actual terminal output downstream.

The implemented style subset includes cell flex row/column layout,
grow/shrink/basis, padding/margin/gap, absolute positioning, clipping, z-order,
flat backgrounds, opacity, borders, and text color/alignment/line-height/
tracking. Known unsupported pixel-oriented properties increment diagnostics.

## Color, input, and frames

- `colorMode: "ansi16"` composites colors and maps them to the nearest ANSI16
  entry. It is the default unless `POCKET_TUI_GHOSTTY_EFFECTS=1` is set.
- `colorMode: "truecolor"` preserves composited 24-bit RGB. The backend does
  not probe terminal color support.
- `fps` defaults to 30 and must be an exact Pocket clock divisor: 1, 2, 3, 4,
  5, 6, 10, 12, 15, 20, 30, or 60. It is the fixed cadence or adaptive maximum
  cadence and remains Pocket's deterministic virtual-clock step. Adaptive idle
  time intentionally does not advance virtual time.
- `onFrame` and `createSpriteAnimation` hold a continuous adaptive frame lease.
  `after()` holds one only until its virtual deadline. `onDemandFrame()` keeps
  the next frame when its callback returns `true`, while `requestFrame()` asks
  for one explicit tick. Retained signal mutations wake independently.
- The native watcher duplicates (but never reads) the tty descriptors, emits
  one coalesced readiness edge, carries the parser-owned 25 ms standalone-Escape
  deadline, and probes resize changes without waking JavaScript when dimensions
  match. The readiness callback drains and rearms the parser immediately; it
  does not advance Pocket's virtual clock. Completed input waits for the next
  legal frame, where each resize is synchronized before its own `onInput`
  callback and before button/frame dispatch.
- That between-frame input queue is bounded to 4096 events and 2 MiB of UTF-8
  text. Adjacent resize snapshots coalesce to the latest dimensions. Exceeding
  either bound reports an error that remains fatal until close instead of
  silently dropping ordered keys or paste chunks.
- Each terminal button event produces one press frame and one release frame.
  Pending pulses are capped at eight. `directionPulsePolicy: "latest"` is the
  default and coalesces pending directions to the newest one, which avoids
  replaying stale terminal autorepeat in real-time controls.
- Turn-based applications can select `directionPulsePolicy: "queue"`. It
  preserves every mapped direction in arrival order; overflow still discards
  the oldest pulse and every press still receives its own release frame.
- A mapper may return one button mask or a bounded sequence of up to eight.
  The default mapper preserves recognized characters from a batched terminal
  text event, so inputs such as `.q` do not silently lose the quit command.
- The default map covers arrows/WASD/HJKL, Space/P, `.`, R/Enter,
  Q/Escape/Ctrl-C, and Backspace. Focused components may consume text/editing
  events or specialize Enter as described above. Supply `mapInput` to replace
  button mapping or `onInput` to inspect and consume events first.

The optional effect bus is a PocketTUI surface extension, not part of PocketJS
HostOps. Configure `tui.effectBus`, then use `session.setEffectBus(frame)` and
`session.clearEffectBus()`. A surface without that extension rejects those
calls explicitly.

## Explicit terminal fallbacks

- image nodes render as `▧`;
- texture uploads return `-1`;
- sprite sequences retain the image placeholder;
- timed `animate()` calls apply their endpoint immediately;
- font atlases are ignored.

`session.diagnostics` counts those fallbacks and reports live nodes, HostOps
mutations, rendered/skipped frames, full versus incremental raster frames,
full/cached/localized/reused layout frames, recomputed/measured/reused layout
nodes, relayout roots, repainted rows, latest run count, missing styles, known
unsupported properties, scheduler policy, stepped frames, idle waits, and wake
signals.

PocketJS 0.6 keeps its renderer root and frame handler in process-global state,
so this package permits one active session per process. A concurrent mount
fails before it touches the second surface; closing or a failed mount releases
the lease and resets the shared mirror, pack, class, texture, and sprite
registries before a later session starts. The class reset uses a pinned 0.6.0
compatibility bridge because that release does not export its reset helper.

## PocketJS runtime surface

The package re-exports the narrow PocketJS API needed by a TUI application:
`BTN`, lifecycle hooks, `after`, focus APIs, Solid renderer helpers, `createSignal`,
`createMemo`, and their corresponding types. Import reactive primitives from
`@pocket-tui/pocketjs`, not directly from `solid-js`. The facade explicitly
selects Solid's interactive client runtime even under Bun's default `node`
export condition and owns its client root for exactly the Pocket mount
lifetime. Import lifecycle hooks and terminal components from this facade as
well. Direct `@pocketjs/framework/components` imports are outside the adaptive
scheduler contract in PocketJS 0.6 because they bind to upstream's bare-Solid
lifecycle graph rather than this facade's client-owned lifecycle. Use the
facade components and hooks; `framePolicy: "fixed"` only avoids a missed frame
lease if an application must temporarily mix direct upstream imports.
The executable adapter currently requires Bun because PocketJS 0.6's npm
artifact publishes TypeScript source. Runtime calls always execute that pinned
package. Local declarations pin the 0.6 contract so the dependency's shipped
TypeScript sources do not inherit this workspace's stricter compiler settings.
