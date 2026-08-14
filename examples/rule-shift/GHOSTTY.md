# Syntax Loom on Ghostty

`RULE//SHIFT` is complete in an ordinary terminal. Ghostty 1.3+ can add the
optional **Syntax Loom** pass: dry-offset token halos, cursor registration
marks, push pressure lines, blocked-move brackets, rewind proofs, a horizontal
rule-rewrite loom, and rectangular stage-clear waves.

Run it from this directory:

```sh
bun run ghostty
```

The launcher opens a fresh Ghostty surface. It does not edit the user's
configuration. Use `bun run start` for the portable ANSI16 profile.

## Typed effect channel

The game does not emit ANSI or terminal-specific escape sequences. It submits
one typed PocketTUI `EffectBusFrame`; the native terminal backend publishes the
state through reserved dynamic-palette slots owned by the
`ghostty-palette-v1` profile:

| Slot | Syntax Loom meaning |
| --- | --- |
| `240` | Fixed `#505458` (`PTX`) ownership signature |
| `241` | Event kind, power, flags |
| `242` | Stage progress, undo charge, active-rule density |
| `243` | Signed X/Y bearing (`128` is zero), wave reach |

Event kinds are `0` idle, `1` move, `2` push, `3` blocked, `4` calibrate,
`5` rule transform, and `6` stage clear. PocketTUI alternates two nearly equal
cursor colors for triggered events, which makes Ghostty update
`iTimeCursorChange` even if the cursor did not move.

The shader ignores the data slots unless slot 240 holds the signature. The
normal terminal capability publishes none of these palette writes. On disable
or exit, PocketTUI precisely resets slots 240–243, cursor color, and cursor
shape as part of the terminal session transaction.

## Manual configuration

Ghostty configuration equivalent to the process-local shader selection is:

```ini
custom-shader = /absolute/path/to/examples/rule-shift/shaders/syntax-loom.glsl
custom-shader-animation = true
```

Start the game with its matching PocketTUI capability:

```sh
POCKET_TUI_GHOSTTY_EFFECTS=1 bun run start
```

Ghostty prepends the shader version, uniforms, and `main()` wrapper. The file
therefore defines only helpers and
`void mainImage(out vec4 fragColor, in vec2 fragCoord)`. The source terminal
pixel and alpha are always retained; effects are reduced to ten percent over
detected glyph and border ink so rules remain readable and selectable.

A shader compilation problem is reported in Ghostty's logs and can produce a
black surface. Close that window and run `bun run start`; the launcher's
process-local options leave no persistent shader or palette state.

Official Ghostty references: [custom shaders][shader], [shader uniforms][api],
[OSC 4 dynamic palette][osc4], and [OSC 104 palette reset][osc104].

[shader]: https://ghostty.org/docs/config/reference#custom-shader
[api]: https://github.com/ghostty-org/ghostty/blob/main/src/renderer/shaders/shadertoy_prefix.glsl
[osc4]: https://ghostty.org/docs/vt/osc/4
[osc104]: https://ghostty.org/docs/vt/osc/104
