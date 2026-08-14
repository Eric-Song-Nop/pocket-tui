# Echo Aperture on Ghostty

Signal Below includes an optional Ghostty post-processing profile called Echo
Aperture. The normal game remains a portable PocketJS application rendered by
the PocketTUI backend. Ghostty 1.3+ adds theme-aware multi-layer bloom, a
phosphor cursor wake, directional hydrophone lobes, expanding sonar rings, and
distinct move, pulse, damage, heal, beam, victory, and low-HP effects.

## Run it

From this directory:

```sh
bun run ghostty
```

Or invoke `./launch-ghostty.sh` directly. The launcher requires Ghostty 1.3 or
newer, starts `bun run start` in a fresh Ghostty surface, and changes no global
configuration. It clears inherited custom shader passes for only that process,
loads [`shaders/rogue-aura.glsl`](shaders/rogue-aura.glsl), enables focused-only
shader animation, and selects PocketTUI's `ghostty-palette-v1` capability. Run
`bun run start` for the portable effect-free profile.

The equivalent manual shader configuration is:

```ini
custom-shader = /absolute/path/to/examples/roguelike/shaders/rogue-aura.glsl
custom-shader-animation = true
```

Start the game with the matching PocketTUI capability as well:

```sh
POCKET_TUI_GHOSTTY_EFFECTS=1 bun run start
```

`custom-shader` is repeatable; passes run in declaration order, and each pass
receives the preceding pass as `iChannel0`. The launcher intentionally uses one
pass so Echo Aperture always receives the undistorted terminal framebuffer.

## The PocketTUI effect bus

Ghostty shaders are whole-surface pixel post-processors. They do not expose
arbitrary application uniforms, so the game submits one typed PocketTUI
`EffectBusFrame`; it never writes escape sequences itself. PTX opcode 16 carries
a fixed 16-byte payload with the `ghostty-palette-v1` profile, three RGB-byte
channels, an enabled flag, and a trigger flag. The native terminal backend
publishes that state through four explicitly reserved dynamic-palette slots:

| Slot | Echo Aperture meaning |
| --- | --- |
| `240` | Fixed `#505458` (`PTX`) ownership signature |
| `241` | Event kind, event power, flags (`bit 0` means HP is valid) |
| `242` | HP ratio, energy ratio, resonance/intensity |
| `243` | Signed X/Y bearing (`128` is zero), aperture radius |

Event kind bytes are `0` idle, `1` move, `2` pulse, `3` damage, `4` heal, `5`
beam, and `6` win. Melee and death use damage; pickups use heal. The shader
ignores all three data slots unless slot 240 contains the signature.

The Ghostty terminal profile translates changes into OSC 4 for slots 240–243.
Unchanged channels emit nothing. A trigger alternates the cursor between two
nearly identical cyan shades; Ghostty consequently updates
`iTimeCursorChange`, providing a reliable event clock even when the player did
not move. The actual cursor is a steady underline positioned at the player, so
`iCurrentCursor` and `iPreviousCursor` supply the spatial anchor without hiding
the `◉` glyph beneath a block cursor.

Effect state, cursor color, cursor shape, and framebuffer output share the
terminal session's desired/in-flight/confirmed transaction. A partial or
blocked write cannot advance the diff baseline. On disable or exit PocketTUI
uses the targeted `OSC 104;240;241;242;243` reset, `OSC 112` for cursor color,
and DECSCUSR reset for shape. It does not issue a broad palette reset. Terminals
cannot portably report and restore a pre-existing dynamic OSC 12/DECSCUSR
override, which is why the profile is explicit and launcher-scoped.

The conservative and ordinary true-color profiles normalize the bus to
disabled and emit no OSC 4/104 effect-bus traffic. This keeps the PocketJS demo
fully usable on non-Ghostty terminals.

## Readability boundary

Palette-keyed bloom is sampled around glyphs, but the source framebuffer is
still copied from its exact pixel coordinate. Additive light is reduced to 14%
over detected ink. Only the brief damage effect samples a roughly two-pixel
shake/chromatic split, and that mix is masked out over glyphs and borders.
Alpha is always preserved, so map symbols, HUD text, box rules, selection, and
copy behavior remain intact.

## Shader API and limits

Ghostty prepends the GLSL version, uniforms, and `main()` wrapper. A shader file
must define `void mainImage(out vec4 fragColor, in vec2 fragCoord)` and must not
declare those pieces itself. Echo Aperture uses:

- `iChannel0`, `iResolution`, `iTime`, and focus state;
- current/previous cursor rectangles and colors, cursor visibility, and the
  cursor-change timestamp;
- the complete `iPalette[256]` synchronized by Ghostty 1.3, plus
  `iBackgroundColor` and `iForegroundColor`.

There are no cell IDs, glyph IDs, previous-frame feedback, extra texture
channels, or user-defined uniforms. `iMouse`, `iDate`, `iFrameRate`, audio/video
channel time, and audio sample rate are currently unsupported or inapplicable.
Effects can react only to rendered pixels and Ghostty-provided terminal state.
Ghostty's Linux renderer requires OpenGL 4.3; macOS uses Metal.

Compilation failures are reported in Ghostty's logs rather than as ordinary
configuration errors. A broken shader can make a surface black; close that
window and use `bun run start`. The launcher's process-local configuration and
PocketTUI guard cleanup leave no persistent shader or reserved palette values.

Official references: [custom shader configuration][shader-docs], [shader
uniform wrapper][uniform-source], [OSC 4 dynamic palette][osc-4], [OSC 104
targeted reset][osc-104], [cursor style][cursor-style], [OSC 12 cursor
color][cursor-color], and [OSC 112 cursor-color reset][cursor-color-reset].

[shader-docs]: https://ghostty.org/docs/config/reference#custom-shader
[uniform-source]: https://github.com/ghostty-org/ghostty/blob/main/src/renderer/shaders/shadertoy_prefix.glsl
[osc-4]: https://ghostty.org/docs/vt/osc/4
[osc-104]: https://ghostty.org/docs/vt/osc/104
[cursor-style]: https://ghostty.org/docs/vt/csi/decscusr
[cursor-color]: https://ghostty.org/docs/vt/osc/1x
[cursor-color-reset]: https://ghostty.org/docs/vt/osc/11x
