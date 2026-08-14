#!/bin/sh

set -eu

example_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
shader_path=$example_dir/shaders/rogue-aura.glsl

if ! command -v bun >/dev/null 2>&1; then
    printf '%s\n' 'PocketTUI: Bun was not found on PATH.' >&2
    exit 127
fi
bun_path=$(command -v bun)

if [ ! -r "$shader_path" ]; then
    printf 'PocketTUI: shader is not readable: %s\n' "$shader_path" >&2
    exit 1
fi

system_name=$(uname -s)
if [ "$system_name" = Darwin ] && [ -x /Applications/Ghostty.app/Contents/MacOS/ghostty ]; then
    ghostty_probe=/Applications/Ghostty.app/Contents/MacOS/ghostty
elif command -v ghostty >/dev/null 2>&1; then
    ghostty_probe=$(command -v ghostty)
else
    printf '%s\n' 'PocketTUI: Ghostty was not found.' >&2
    printf '%s\n' 'Install Ghostty 1.3 or newer, or run `bun run start` without the shader.' >&2
    exit 127
fi

ghostty_version=$(
    "$ghostty_probe" +version 2>/dev/null |
        sed -n '1s/^Ghostty \([0-9][0-9.]*\).*$/\1/p'
)
ghostty_major=${ghostty_version%%.*}
ghostty_remainder=${ghostty_version#*.}
ghostty_minor=${ghostty_remainder%%.*}
case "$ghostty_major:$ghostty_minor" in
    ''|*[!0-9:]*|:*)
        printf '%s\n' 'PocketTUI: could not determine the installed Ghostty version.' >&2
        exit 1
        ;;
esac
if [ "$ghostty_major" -lt 1 ] || { [ "$ghostty_major" -eq 1 ] && [ "$ghostty_minor" -lt 3 ]; }; then
    printf 'PocketTUI: Ghostty %s is too old; the shader requires 1.3 or newer.\n' "$ghostty_version" >&2
    exit 1
fi

# An empty repeatable value clears inherited custom shaders for this process,
# then the game shader is added as the only pass. User configuration on disk is
# read normally and is never changed. `true` animates only a focused surface.
# The environment option lets the app expose Ghostty's real cursor as a player
# position/event bridge. Passing it through Ghostty also works when macOS starts
# the app through Launch Services rather than inheriting this shell's environment.
set -- \
    --custom-shader= \
    "--custom-shader=$shader_path" \
    --custom-shader-animation=true \
    "--working-directory=$example_dir" \
    --env=POCKET_TUI_GHOSTTY_EFFECTS=1 \
    -e "$bun_path" run start "$@"

if [ "$system_name" = Darwin ]; then
    # Use the exact app bundle whose binary was version-checked above.
    ghostty_app=${ghostty_probe%/Contents/MacOS/ghostty}
    exec open -na "$ghostty_app" --args "$@"
fi

exec "$ghostty_probe" "$@"
