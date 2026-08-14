import {
  POCKET_BUTTON,
  createPocketTuiHost,
  mountPocketTui,
  type PocketInputMapping,
  type PocketTuiSession,
  type TuiInputEvent,
} from "@pocket-tui/pocketjs";

import type { GameSnapshot } from "./engine.js";
import {
  RULE_SHIFT_FPS,
  RuleShift,
  type RuleShiftContext,
} from "./game-app.js";
import type {
  PresentationEffectSignal,
  PresentationScene,
  PresentationViewport,
} from "./presentation.js";

const GHOSTTY_EFFECTS = process.env.POCKET_TUI_GHOSTTY_EFFECTS === "1";
const MAX_BATCHED_ACTIONS = 8;
const TERMINATION_SIGNALS = [
  ["SIGINT", 130],
  ["SIGQUIT", 131],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;
const signalProcess = process as typeof process & {
  off(signal: string, listener: () => void): unknown;
};

export async function runRuleShift(): Promise<void> {
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

  const context: RuleShiftContext = {
    viewport: () => viewport,
    diagnostics: () => {
      const stats = host.diagnostics;
      return {
        liveNodes: stats.liveNodes,
        operations: stats.mutations,
        frameGeneration: stats.renderedFrames,
      };
    },
    present: (scene, snapshot) => {
      const effect = scene.effectSignal;
      const effectKey = effect.startedAt === null
        ? "idle"
        : `${effect.kind}:${effect.startedAt}:${effect.anchor.column}:${effect.anchor.row}`;
      const trigger = effect.kind !== "idle" && effectKey !== lastEffectKey;
      lastEffectKey = effectKey;

      host.setCursor({
        row: scene.cursor.row,
        column: scene.cursor.column,
        visible: GHOSTTY_EFFECTS && scene.cursor.visible,
        shape: scene.cursor.shape,
      });
      if (!GHOSTTY_EFFECTS) return;
      host.setEffectBus({
        channels: effectChannels(effect, scene, snapshot),
        trigger,
      });
    },
    requestClose: () => session?.requestClose(),
  };

  const signalHandlers = TERMINATION_SIGNALS.map(([signal, exitCode]) => {
    const handler = (): void => {
      pendingExitCode ??= exitCode;
      session?.requestClose();
    };
    process.once(signal, handler);
    return [signal, handler] as const;
  });

  try {
    session = await mountPocketTui(
      () => RuleShift({ context }),
      {
        host,
        fps: RULE_SHIFT_FPS,
        directionPulsePolicy: "queue",
        onInput: (event, activeSession) => {
          if (isImmediateQuit(event)) {
            activeSession.requestClose();
            return true;
          }
          if (event.kind === "resize") {
            viewport = { columns: event.columns, rows: event.rows };
            return true;
          }
        },
        mapInput: ruleShiftInputMap,
      },
    );
    if (pendingExitCode !== undefined) session.requestClose();
    await session.run();
  } finally {
    for (const [signal, handler] of signalHandlers) signalProcess.off(signal, handler);
    await session?.close();
    if (pendingExitCode !== undefined) process.exit(pendingExitCode);
  }
}

export function ruleShiftInputMap(event: TuiInputEvent): PocketInputMapping | undefined {
  if (event.kind === "key") {
    if (event.ctrl && event.key.toLowerCase() === "c") return POCKET_BUTTON.SELECT;
    switch (event.key.toLowerCase()) {
      case "arrow-up":
      case "w":
      case "k":
        return POCKET_BUTTON.UP;
      case "arrow-right":
      case "d":
      case "l":
        return POCKET_BUTTON.RIGHT;
      case "arrow-down":
      case "s":
      case "j":
        return POCKET_BUTTON.DOWN;
      case "arrow-left":
      case "a":
      case "h":
        return POCKET_BUTTON.LEFT;
      case "z":
        return POCKET_BUTTON.SQUARE;
      case "r":
        return POCKET_BUTTON.START;
      case "n":
        return POCKET_BUTTON.RTRIGGER;
      case "p":
        return POCKET_BUTTON.LTRIGGER;
      case "q":
      case "escape":
        return POCKET_BUTTON.SELECT;
      default:
        return undefined;
    }
  }
  if (event.kind !== "text") return undefined;

  const buttons: number[] = [];
  for (const character of event.text) {
    const mapped = characterButton(character);
    if (mapped === undefined) continue;
    if (buttons.length === MAX_BATCHED_ACTIONS) buttons.shift();
    buttons.push(mapped);
  }
  return buttons.length > 0 ? buttons : undefined;
}

export function isImmediateQuit(event: TuiInputEvent): boolean {
  if (event.kind === "text") return /q/i.test(event.text);
  if (event.kind !== "key") return false;
  const key = event.key.toLowerCase();
  return key === "q" || key === "escape" || (event.ctrl && key === "c");
}

function characterButton(character: string): number | undefined {
  switch (character.toLowerCase()) {
    case "w":
    case "k":
      return POCKET_BUTTON.UP;
    case "d":
    case "l":
      return POCKET_BUTTON.RIGHT;
    case "s":
    case "j":
      return POCKET_BUTTON.DOWN;
    case "a":
    case "h":
      return POCKET_BUTTON.LEFT;
    case "z":
      return POCKET_BUTTON.SQUARE;
    case "r":
      return POCKET_BUTTON.START;
    case "n":
      return POCKET_BUTTON.RTRIGGER;
    case "p":
      return POCKET_BUTTON.LTRIGGER;
    case "q":
      return POCKET_BUTTON.SELECT;
    default:
      return undefined;
  }
}

function effectChannels(
  effect: PresentationEffectSignal,
  scene: PresentationScene,
  snapshot: GameSnapshot,
): readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
] {
  const eventCode: Readonly<Record<PresentationEffectSignal["kind"], number>> = {
    idle: 0,
    move: 1,
    push: 2,
    blocked: 3,
    calibrate: 4,
    transform: 5,
    win: 6,
  };
  const basePower: Readonly<Record<PresentationEffectSignal["kind"], number>> = {
    idle: 0,
    move: 132,
    push: 188,
    blocked: 224,
    calibrate: 196,
    transform: 250,
    win: 255,
  };
  const power = byte(basePower[effect.kind] * (0.62 + (1 - effect.progress) * 0.38));
  const flags = snapshot.phase === "won" ? 1 : 0;
  const stageProgress = byte((snapshot.levelIndex + 1) / Math.max(1, snapshot.levelCount) * 255);
  const undoCharge = byte(Math.min(1, snapshot.historyDepth / 12) * 255);
  const activeRuleDensity = byte(Math.min(1, snapshot.rules.clauses.length / 10) * 255);
  const dx = byte(effect.anchor.column - scene.cursor.column + 128);
  const dy = byte(effect.anchor.row - scene.cursor.row + 128);
  const reach = effect.kind === "win"
    ? 255
    : effect.kind === "transform"
      ? 224
      : effect.kind === "calibrate"
        ? 184
        : effect.kind === "blocked"
          ? 128
          : effect.kind === "push"
            ? 152
            : 104;
  return [
    [eventCode[effect.kind], power, flags],
    [stageProgress, undoCharge, activeRuleDensity],
    [dx, dy, reach],
  ];
}

function byte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

if ((import.meta as ImportMeta & { readonly main?: boolean }).main) {
  await runRuleShift();
}
