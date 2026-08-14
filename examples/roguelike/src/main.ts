import {
  POCKET_BUTTON,
  createPocketTuiHost,
  mountPocketTui,
  type PocketInputMapping,
  type PocketTuiSession,
  type TuiInputEvent,
} from "@pocket-tui/pocketjs";

import {
  SIGNAL_BELOW_FPS,
  SignalBelow,
  type SignalBelowContext,
} from "./game-app.js";
import type { RoguelikeGame, Seed } from "./game.js";
import {
  type PresentationEffectSignal,
  type PresentationScene,
  type PresentationViewport,
} from "./presentation.js";

const GHOSTTY_EFFECTS = process.env.POCKET_TUI_GHOSTTY_EFFECTS === "1";

const host = createPocketTuiHost({
  tui: {
    surface: "alternate",
    effectBus: GHOSTTY_EFFECTS ? "ghostty-palette-v1" : undefined,
  },
  colorMode: GHOSTTY_EFFECTS ? "truecolor" : "ansi16",
});
let viewport: PresentationViewport = host.viewportSize();
let session: PocketTuiSession | undefined;
let pendingExitCode: number | undefined;
let lastEffectKey = "idle";

const context: SignalBelowContext = {
  viewport: () => viewport,
  diagnostics: () => {
    const stats = host.diagnostics;
    return {
      liveNodes: stats.liveNodes,
      operations: stats.mutations,
      frameGeneration: stats.renderedFrames,
    };
  },
  present: (scene, game) => updateTerminalEffects(scene, game),
  requestClose: () => session?.requestClose(),
};

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGQUIT", 131],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.once(signal, () => {
    pendingExitCode ??= exitCode;
    session?.requestClose();
  });
}

try {
  session = await mountPocketTui(
    () => SignalBelow({ seed: seedFromArguments(), context }),
    {
      host,
      fps: SIGNAL_BELOW_FPS,
      onInput: handleHostInput,
      mapInput: gameInputMap,
    },
  );
  if (pendingExitCode !== undefined) session.requestClose();
  await session.run();
} finally {
  await session?.close();
  if (pendingExitCode !== undefined) process.exit(pendingExitCode);
}

function handleHostInput(event: TuiInputEvent): boolean | void {
  if (event.kind !== "resize") return;
  viewport = { columns: event.columns, rows: event.rows };
  return true;
}

function gameInputMap(event: TuiInputEvent): PocketInputMapping | undefined {
  if (event.kind === "key") {
    if (event.ctrl && event.key.toLowerCase() === "c") return POCKET_BUTTON.SELECT;
    switch (event.key) {
      case "arrow-up":
        return POCKET_BUTTON.UP;
      case "arrow-right":
        return POCKET_BUTTON.RIGHT;
      case "arrow-down":
        return POCKET_BUTTON.DOWN;
      case "arrow-left":
        return POCKET_BUTTON.LEFT;
      case "enter":
        return POCKET_BUTTON.START;
      case "escape":
        return POCKET_BUTTON.SELECT;
      default:
        return undefined;
    }
  }
  if (event.kind !== "text") return undefined;
  const buttons: number[] = [];
  for (const character of event.text) {
    let mapped: number | undefined;
    switch (character) {
      case "w":
      case "W":
      case "k":
      case "K":
        mapped = POCKET_BUTTON.UP;
        break;
      case "d":
      case "D":
      case "l":
      case "L":
        mapped = POCKET_BUTTON.RIGHT;
        break;
      case "s":
      case "S":
      case "j":
      case "J":
        mapped = POCKET_BUTTON.DOWN;
        break;
      case "a":
      case "A":
      case "h":
      case "H":
        mapped = POCKET_BUTTON.LEFT;
        break;
      case " ":
      case "p":
      case "P":
        mapped = POCKET_BUTTON.CIRCLE;
        break;
      case ".":
        mapped = POCKET_BUTTON.SQUARE;
        break;
      case "r":
      case "R":
        mapped = POCKET_BUTTON.START;
        break;
      case "q":
      case "Q":
        mapped = POCKET_BUTTON.SELECT;
        break;
      default:
        break;
    }
    if (mapped === undefined) continue;
    if (buttons.length === 8) buttons.shift();
    buttons.push(mapped);
  }
  return buttons.length > 0 ? buttons : undefined;
}

function updateTerminalEffects(scene: PresentationScene, game: RoguelikeGame): void {
  const effect = scene.effectSignal;
  const effectKey = effect.startedAt === null ? "idle" : `${effect.kind}:${effect.startedAt}`;
  const trigger = effectKey !== lastEffectKey && effect.kind !== "idle";
  lastEffectKey = effectKey;
  host.setCursor({
    row: scene.cursor.row,
    column: scene.cursor.column,
    visible: GHOSTTY_EFFECTS && scene.cursor.visible,
    shape: scene.cursor.shape,
  });

  // PocketTUI owns the palette transport and cleanup. The ordinary profile
  // never publishes these channels, so no terminal-specific output leaks into
  // the PocketJS example.
  if (!GHOSTTY_EFFECTS) return;
  host.setEffectBus({
    channels: effectChannels(effect, scene, game),
    trigger,
  });
}

function effectChannels(
  effect: PresentationEffectSignal,
  scene: PresentationScene,
  game: RoguelikeGame,
): readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
] {
  const eventCode: Readonly<Record<PresentationEffectSignal["kind"], number>> = {
    idle: 0,
    move: 1,
    pulse: 2,
    melee: 3,
    damage: 3,
    death: 3,
    pickup: 4,
    beam: 5,
    win: 6,
  };
  const basePower: Readonly<Record<PresentationEffectSignal["kind"], number>> = {
    idle: 0,
    move: 142,
    melee: 222,
    beam: 236,
    pulse: 246,
    pickup: 204,
    damage: 255,
    death: 255,
    win: 255,
  };
  const power = byte(basePower[effect.kind] * (0.58 + (1 - effect.progress) * 0.42));
  // Bit 0 promises a valid HP byte. Remaining bits are available to this demo
  // without changing the generic three-channel PocketTUI API.
  const flags = 1 | (game.phase === "won" ? 2 : 0) | (game.phase === "dead" ? 4 : 0);
  const hp = byte((game.player.hp / Math.max(1, game.player.maxHp)) * 255);
  const energy = byte((game.player.energy / Math.max(1, game.player.maxEnergy)) * 255);
  const resonance = effect.kind === "idle" ? 0 : byte((1 - effect.progress) * 255);
  const dx = byte(effect.anchor.column - scene.cursor.column + 128);
  const dy = byte(effect.anchor.row - scene.cursor.row + 128);
  const radius =
    effect.kind === "win"
      ? 255
      : effect.kind === "beam"
        ? 220
        : effect.kind === "pulse"
          ? 96 + game.pulseRadius * 24
          : effect.kind === "damage" || effect.kind === "death" || effect.kind === "melee"
            ? 180
            : effect.kind === "pickup"
              ? 144
              : 88;
  return [
    [eventCode[effect.kind], power, flags],
    [hp, energy, resonance],
    [dx, dy, byte(radius)],
  ];
}

function byte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function seedFromArguments(): Seed {
  const raw = process.argv.find((argument) => argument.startsWith("--seed="))?.slice(7);
  if (raw === undefined || raw.length === 0) return Date.now().toString(36);
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric) ? numeric : raw;
}
