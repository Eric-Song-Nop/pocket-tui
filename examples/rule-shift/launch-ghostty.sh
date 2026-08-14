#!/bin/sh

set -eu

example_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
shader_path=$example_dir/shaders/syntax-loom.glsl

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
if [ "$system_name" = Darwin ]; then
    shader_y_down=1
else
    shader_y_down=0
fi
if [ "$system_name" = Darwin ] && [ -x /Applications/Ghostty.app/Contents/MacOS/ghostty ]; then
    ghostty_binary=/Applications/Ghostty.app/Contents/MacOS/ghostty
elif command -v ghostty >/dev/null 2>&1; then
    ghostty_binary=$(command -v ghostty)
else
    printf '%s\n' 'PocketTUI: Ghostty was not found.' >&2
    printf '%s\n' 'Install Ghostty 1.3 or newer, or use `bun run start`.' >&2
    exit 127
fi

ghostty_version=$(
    "$ghostty_binary" +version 2>/dev/null |
        sed -n '1s/^Ghostty \([0-9][0-9.]*\).*$/\1/p'
)
ghostty_major=${ghostty_version%%.*}
ghostty_tail=${ghostty_version#*.}
ghostty_minor=${ghostty_tail%%.*}
case "$ghostty_major:$ghostty_minor" in
    ''|*[!0-9:]*|:*)
        printf '%s\n' 'PocketTUI: could not determine the installed Ghostty version.' >&2
        exit 1
        ;;
esac
if [ "$ghostty_major" -lt 1 ] || { [ "$ghostty_major" -eq 1 ] && [ "$ghostty_minor" -lt 3 ]; }; then
    printf 'PocketTUI: Ghostty %s is too old; Syntax Loom requires 1.3 or newer.\n' "$ghostty_version" >&2
    exit 1
fi

# Clear inherited shader passes only for the new process, install this demo's
# one pass, and opt the application into PocketTUI's typed/reversible effect
# bus. No Ghostty configuration file is read-modified-written by this script.
set -- \
    --custom-shader= \
    "--custom-shader=$shader_path" \
    --custom-shader-animation=true \
    --window-padding-x=0 \
    --window-padding-y=0 \
    "--working-directory=$example_dir" \
    --env=POCKET_TUI_GHOSTTY_EFFECTS=1 \
    "--env=POCKET_TUI_GHOSTTY_Y_DOWN=$shader_y_down" \
    -e "$bun_path" run start "$@"

if [ "$system_name" = Darwin ]; then
    ghostty_app=${ghostty_binary%/Contents/MacOS/ghostty}
    exec open -na "$ghostty_app" --args "$@"
fi

exec "$ghostty_binary" "$@"
