# Syntax Loom on Ghostty

`RULE//SHIFT` is a complete game in an ordinary terminal. Ghostty 1.3 or newer
can add the optional **Syntax Loom** pass: a full-surface, per-pixel rendering
layer driven by the puzzle's semantic events.

Run it from this directory:

```sh
bun run ghostty
```

The launcher opens a fresh Ghostty surface with the shader and its matching
PocketTUI capability. It does not modify the user's Ghostty configuration;
the shader override is scoped to the launched process. Use `bun run start`
for the portable ANSI16 profile.

## What is portable, and what is Ghostty-only

The portable presentation remains the source of truth. Its multi-row word
tiles, object sprites, movement trails, push particles, blocked impacts,
calibration sweep, transformation orbit, and victory burst are ordinary
retained PocketJS cells rendered at 30 FPS. Gameplay, timing, and information
do not depend on the shader.

Syntax Loom samples Ghostty's already-rendered terminal texture. That gives it
effects which cannot be represented on a terminal cell grid:

| Event | Ghostty-only treatment |
| --- | --- |
| Ambient | Sub-pixel cyan, vermilion, and brass registration halos around colored type |
| Move | Fractional-pixel RGB plate slip along the real cursor path, with shrinking registration frames |
| Push | Directional framebuffer compression: pixels fold into an accordion beneath moving brass platen ribs |
| Blocked | Radial refraction, procedural hairline cracks, and a short pulse at the physical surface edge |
| Undo / restart / stage change | A full-width proofing roller drags pixels, then seats separate red and cyan plates over paper fibre and crop rulings; undo reverses its travel |
| Rule transform | The signature Syntax Loom shuttle warps texture coordinates through a sentence-height weave with chromatic moire threads |
| Stage clear | An aspect-ratio-safe rectangular proof wave refracts the whole surface, separates its color plates, and leaves a temporary halftone paper wash |

The GIF and PNG files in [`previews/`](previews/) show the real **portable**
PocketJS `CanvasFrame`. They are not captures of the Ghostty shader. Launch the
Ghostty profile to see the per-pixel treatments above.

## Typed effect channel

Game and presentation code emit no ANSI or terminal-specific escape sequences.
They submit one typed PocketTUI `EffectBusFrame`; the generic native terminal
backend publishes it through four reserved dynamic-palette slots owned by the
`ghostty-palette-v1` profile. Each component below is an unsigned byte encoded
as one RGB channel:

| Slot | R | G | B |
| --- | --- | --- | --- |
| `240` | `80` | `84` | `88` |
| `241` | Event kind | Decaying event power | Semantic flags |
| `242` | Event phase | Campaign/rule nibbles | Viewport row count |
| `243` | Relative anchor X + 128, or absolute column | Relative anchor Y + 128, or absolute row | Direction/reach packet |

Slot 240 spells `PTX` (`#505458`) and is the ownership signature. The shader
does not consume the remaining slots unless this signature matches.

Slot 241 red uses `0` idle, `1` move, `2` push, `3` blocked, `4` calibrate,
`5` rule transform, and `6` stage clear. If `p` is normalized event phase,
green is `round(basePower * (0.62 + (1 - p) * 0.38))`; base powers are `0`,
`132`, `188`, `224`, `196`, `250`, and `255` in that same event order. Blue
is a bit field:

| Bit | Mask | Meaning |
| --- | --- | --- |
| 0 | `0x01` | Snapshot is won |
| 1 | `0x02` | Undo |
| 2 | `0x04` | Stage change |
| 3 | `0x08` | Restart |
| 4 | `0x10` | Initial load |
| 5 | `0x20` | Shader coordinates use Y-down (Metal) |
| 6 | `0x40` | Slot 243 carries an absolute anchor because the cursor is hidden |

Slot 242 red is `round(p * 255)` (or zero while idle). Green is
a packed byte: its high nibble is campaign progress on a `0..15` scale and its
low nibble is active-rule density (`min(1, clauses / 10)`) on the same scale.
Blue is the clamped viewport row count. These values let the shader animate
with the retained timeline and reconstruct a full cell height even though
Ghostty reports only the trimmed underline cursor glyph.

Slot 243 locates and directs the effect. While the player cursor is visible,
red and green are the clamped terminal-cell offset from that cursor to the
semantic anchor, with `128` representing zero. If flag bit 6 is set because
the cursor is hidden or cropped out, red and green instead carry the absolute,
zero-based terminal column and row. That fallback keeps local shader events
anchored correctly after a resize rather than combining them with Ghostty's
last visible cursor rectangle. The blue byte packs a three-bit direction code
in the high bits and a five-bit normalized reach in the low bits:

```text
blue = direction * 32 + reach
direction: 0 none, 1 up, 2 right, 3 down, 4 left
reach:     0..31
```

The low-five-bit reach values are `13` for idle/move, `18` push, `16`
blocked, `22` calibrate, `27` transform, and `31` stage clear. Reach describes
the shader's quiet ruled-paper event field; the major event geometries have
their own effect-specific bounds.

PocketTUI alternates two nearly equal cursor colors when it triggers an event.
That restarts Ghostty's `iTimeCursorChange` clock even when the cursor did not
move, while the encoded phase keeps the shader synchronized with PocketJS.
The launcher also publishes the renderer's Y direction explicitly: Metal is
Y-down, while Ghostty's OpenGL path is Y-up. This keeps vertical bearings and
motion correct on both backends.

The normal terminal capability publishes none of these palette writes. On
disable or exit, PocketTUI resets only slots 240–243 plus the cursor color and
shape it owns, as part of the terminal session transaction.

## Manual configuration

The Ghostty configuration equivalent to the launcher's process-local shader
selection is:

```ini
custom-shader = /absolute/path/to/examples/rule-shift/shaders/syntax-loom.glsl
custom-shader-animation = true
```

Start the game with its matching PocketTUI capability:

```sh
POCKET_TUI_GHOSTTY_EFFECTS=1 \
POCKET_TUI_GHOSTTY_Y_DOWN=1 \
bun run start
```

Use `POCKET_TUI_GHOSTTY_Y_DOWN=0` for Ghostty's OpenGL renderer. If the game is
running across SSH, set this for the **displaying Ghostty renderer**, not for
the remote operating system. The bundled launcher sets it automatically and
also scopes window padding to zero so viewport rows map cleanly to pixel cell
height; neither override persists after that Ghostty process exits.

Ghostty prepends the shader version, uniforms, and `main()` wrapper. The
[shader source](shaders/syntax-loom.glsl) therefore defines helpers and
`void mainImage(out vec4 fragColor, in vec2 fragCoord)` only. It uses
`iChannel0`, cursor geometry and timing, terminal colors, and `iPalette`; the
application does not inject arbitrary GLSL uniforms.

## Legibility and performance boundary

Syntax Loom is an animated, full-surface GPU post-process. Its idle path reads
the base pixel plus four cardinal neighbors; an active event adds at most three
more framebuffer reads. A very large or high-density Ghostty surface therefore
still costs more GPU time and power than `bun run start`. Disable the shader
profile if that tradeoff is undesirable; the game and its portable particles
are unchanged.

The intact terminal sample is always the base image and its alpha is copied
exactly. Additive light is reduced to 11 percent over detected glyph and border
ink, while stronger refraction and color registration are concentrated in
surrounding negative space. This preserves readability, but custom font
rasterization, unusual terminal palettes, HDR settings, and display scaling
can change the result. A shader compilation problem is reported in Ghostty's
logs and can produce a black surface. Close that window and run `bun run
start`; the launcher's process-local options leave no persistent shader or
palette state.

Official Ghostty references: [custom shaders][shader], [shader uniforms][api],
[OSC 4 dynamic palette][osc4], and [OSC 104 palette reset][osc104].

[shader]: https://ghostty.org/docs/config/reference#custom-shader
[api]: https://github.com/ghostty-org/ghostty/blob/main/src/renderer/shaders/shadertoy_prefix.glsl
[osc4]: https://ghostty.org/docs/vt/osc/4
[osc104]: https://ghostty.org/docs/vt/osc/104
