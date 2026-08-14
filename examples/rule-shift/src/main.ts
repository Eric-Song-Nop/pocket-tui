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
const GHOSTTY_SHADER_Y_IS_DOWN = process.env.POCKET_TUI_GHOSTTY_Y_DOWN === "1";
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

export const GHOSTTY_EFFECT_FLAGS = {
  won: 1 << 0,
  undo: 1 << 1,
  stageChange: 1 << 2,
  restart: 1 << 3,
  initialLoad: 1 << 4,
  yDown: 1 << 5,
  absoluteAnchor: 1 << 6,
} as const;

export const GHOSTTY_DIRECTION_CODES = {
  none: 0,
  up: 1,
  right: 2,
  down: 3,
  left: 4,
} as const;

type GhosttyEffectDirection = keyof typeof GHOSTTY_DIRECTION_CODES;

export interface GhosttyEffectSemantics {
  readonly direction: GhosttyEffectDirection;
  readonly undo: boolean;
  readonly stageChange: boolean;
  readonly restart: boolean;
  readonly initialLoad: boolean;
}

export interface GhosttyEffectHistory {
  readonly cursor?: Readonly<{ column: number; row: number }>;
}

type GhosttyEffectChannel = readonly [red: number, green: number, blue: number];
type GhosttyEffectChannels = readonly [
  GhosttyEffectChannel,
  GhosttyEffectChannel,
  GhosttyEffectChannel,
];

const IDLE_EFFECT_SEMANTICS: GhosttyEffectSemantics = {
  direction: "none",
  undo: false,
  stageChange: false,
  restart: false,
  initialLoad: false,
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
  let previousEffectHistory: GhosttyEffectHistory = {};
  let activeEffectSemantics = IDLE_EFFECT_SEMANTICS;

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
      const effectKey = ghosttyEffectKey(effect);
      const trigger = effect.kind !== "idle" && effectKey !== lastEffectKey;
      lastEffectKey = effectKey;

      if (trigger) {
        activeEffectSemantics = deriveGhosttyEffectSemantics(
          effect,
          scene,
          previousEffectHistory,
        );
      } else if (effect.kind === "idle") {
        activeEffectSemantics = IDLE_EFFECT_SEMANTICS;
      }

      host.setCursor({
        row: scene.cursor.row,
        column: scene.cursor.column,
        visible: GHOSTTY_EFFECTS && scene.cursor.visible,
        shape: scene.cursor.shape,
      });
      if (!GHOSTTY_EFFECTS) return;
      host.setEffectBus({
        channels: encodeGhosttyEffectChannels(effect, scene, snapshot, activeEffectSemantics),
        trigger,
      });

      previousEffectHistory = {
        cursor: { column: scene.cursor.column, row: scene.cursor.row },
      };
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

/**
 * Derive the transient facts that cannot be reconstructed from one shader
 * frame. The caller latches this record for the complete effect lifetime.
 */
export function deriveGhosttyEffectSemantics(
  effect: PresentationEffectSignal,
  scene: PresentationScene,
  previous: GhosttyEffectHistory = {},
): GhosttyEffectSemantics {
  return {
    direction: effectDirection(effect, scene, previous.cursor),
    undo: effect.transition === "undo",
    stageChange: effect.transition === "stage-change",
    restart: effect.transition === "restart",
    initialLoad: effect.transition === "initial-load",
  };
}

/** Stable identity for restarting Ghostty's event clock on semantic replacement. */
export function ghosttyEffectKey(effect: PresentationEffectSignal): string {
  if (effect.startedAt === null) return "idle";
  return [
    effect.kind,
    effect.startedAt,
    effect.durationMs,
    effect.anchor.column,
    effect.anchor.row,
    effect.direction ?? "none",
    effect.transition ?? "none",
  ].join(":");
}

/**
 * Encode the RULE//SHIFT `ghostty-palette-v1` contract into three RGB slots.
 *
 * 241 = event kind, decaying power, semantic flags
 * 242 = event phase, packed campaign/rule density, viewport row count
 * 243 = cursor-relative anchor X/Y (+128), or absolute column/row while the
 *       cursor is hidden; direction (high 3 bits) + reach (low 5)
 */
export function encodeGhosttyEffectChannels(
  effect: PresentationEffectSignal,
  scene: PresentationScene,
  snapshot: GameSnapshot,
  semantics: GhosttyEffectSemantics = IDLE_EFFECT_SEMANTICS,
  yIsDown = GHOSTTY_SHADER_Y_IS_DOWN,
): GhosttyEffectChannels {
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
  const flags =
    (snapshot.phase === "won" ? GHOSTTY_EFFECT_FLAGS.won : 0) |
    (semantics.undo ? GHOSTTY_EFFECT_FLAGS.undo : 0) |
    (semantics.stageChange ? GHOSTTY_EFFECT_FLAGS.stageChange : 0) |
    (semantics.restart ? GHOSTTY_EFFECT_FLAGS.restart : 0) |
    (semantics.initialLoad ? GHOSTTY_EFFECT_FLAGS.initialLoad : 0) |
    (yIsDown ? GHOSTTY_EFFECT_FLAGS.yDown : 0) |
    (!scene.cursor.visible ? GHOSTTY_EFFECT_FLAGS.absoluteAnchor : 0);
  const eventPhase = effect.kind === "idle" ? 0 : byte(effect.progress * 255);
  const campaignNibble = byte(
    (snapshot.levelIndex + 1) / Math.max(1, snapshot.levelCount) * 15,
  );
  const ruleDensityNibble = byte(Math.min(1, snapshot.rules.clauses.length / 10) * 15);
  const packedCampaignAndRules = campaignNibble * 16 + ruleDensityNibble;
  const viewportRows = byte(Math.max(1, scene.layout.viewport.height));
  const anchorX = scene.cursor.visible
    ? byte(effect.anchor.column - scene.cursor.column + 128)
    : byte(effect.anchor.column);
  const anchorY = scene.cursor.visible
    ? byte(effect.anchor.row - scene.cursor.row + 128)
    : byte(effect.anchor.row);
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
  const packedDirectionAndReach =
    GHOSTTY_DIRECTION_CODES[semantics.direction] * 32 + byte(reach / 255 * 31);
  return [
    [eventCode[effect.kind], power, flags],
    [eventPhase, packedCampaignAndRules, viewportRows],
    [anchorX, anchorY, packedDirectionAndReach],
  ];
}

function effectDirection(
  effect: PresentationEffectSignal,
  scene: PresentationScene,
  previousCursor?: Readonly<{ column: number; row: number }>,
): GhosttyEffectDirection {
  if (effect.kind !== "move" && effect.kind !== "push" && effect.kind !== "blocked") return "none";
  if (effect.direction !== undefined) return effect.direction;

  if (previousCursor !== undefined && effect.kind !== "blocked") {
    const cursorDirection = directionFromDelta(
      scene.cursor.column - previousCursor.column,
      scene.cursor.row - previousCursor.row,
    );
    if (cursorDirection !== "none") return cursorDirection;
  }

  return directionFromDelta(
    effect.anchor.column - scene.cursor.column,
    effect.anchor.row - scene.cursor.row,
  );
}

function directionFromDelta(dx: number, dy: number): GhosttyEffectDirection {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  if (dy !== 0) return dy > 0 ? "down" : "up";
  return "none";
}

function byte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

if ((import.meta as ImportMeta & { readonly main?: boolean }).main) {
  await runRuleShift();
}
