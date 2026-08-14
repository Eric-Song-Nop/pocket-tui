import {
  POCKET_BUTTON,
  createMemo,
  createSignal,
  effect,
  onButtonPress,
  onFrame,
  type NodeMirror,
} from "@pocket-tui/pocketjs";

import {
  createGame,
  type GameCommand,
  type RoguelikeGame,
  type Seed,
  type TurnResult,
} from "./game.js";
import {
  PRESENTATION_TOKENS,
  present,
  scheduleEchoTimeline,
  type EchoTimeline,
  type PanelRule,
  type PresentationDiagnostics,
  type PresentationScene,
  type PresentationToken,
  type PresentationViewport,
} from "./presentation.js";
import { appendPocketChildren, pocketText, pocketView, type PocketStyle } from "./pocket-ui.js";

export const SIGNAL_BELOW_FPS = 30;
const FRAME_MS = 1_000 / SIGNAL_BELOW_FPS;
const RUN_POOL_SIZE = 768;
const TERRAIN_RUNS = 448;
const EFFECT_RUNS = 160;
const ACTOR_RUNS = 64;
const PANEL_RUNS = 96;

const BOOT_LEAD_MS = 90;

interface RenderRun {
  readonly key?: string;
  readonly text: string;
  readonly column: number;
  readonly row: number;
  readonly token: PresentationToken;
  readonly emphasis: boolean;
  readonly dim: boolean;
  readonly zIndex: number;
}

export interface SignalBelowContext {
  viewport(): PresentationViewport;
  diagnostics(): PresentationDiagnostics;
  present(scene: PresentationScene, game: RoguelikeGame): void;
  requestClose(): void;
}

export interface SignalBelowOptions {
  readonly seed: Seed;
  readonly context: SignalBelowContext;
}

/** PocketJS component root for the complete game UI. */
export function SignalBelow(options: SignalBelowOptions): NodeMirror {
  const { context } = options;
  const game = createGame({
    width: 68,
    height: 30,
    seed: options.seed,
    fovRadius: 9,
    enemyCount: 10,
    itemCount: 7,
  });

  let timeline: EchoTimeline = bootTimeline(game);
  let visualNow = BOOT_LEAD_MS;
  let unlockAt = 0;
  let queued: GameCommand | undefined;
  let observedViewport = context.viewport();
  const [revision, setRevision] = createSignal(0);
  const [clock, setClock] = createSignal(visualNow);
  const [viewportRevision, setViewportRevision] = createSignal(0);
  const actorSlots = new Map<string, number>();
  const panelSlots = new Map<string, number>();

  const scene = createMemo(() => {
    revision();
    viewportRevision();
    const now = clock();
    return present(game, timeline, observedViewport, now, context.diagnostics());
  });
  const runs = createMemo(() => sceneRuns(scene(), actorSlots, panelSlots));

  const root = pocketView({
    width: -1,
    height: -1,
    overflow: 1,
    bgColor: tokenHex("abyss"),
  });
  for (let index = 0; index < RUN_POOL_SIZE; index += 1) {
    const node = pocketText(
      () => runs()[index]?.text ?? "",
      () => runStyle(runs()[index]),
    );
    appendPocketChildren(root, node);
  }

  const submit = (command: GameCommand): void => {
    if (visualNow < unlockAt) {
      queued = command;
      return;
    }
    perform(command);
  };

  const perform = (command: GameCommand): void => {
    if (command === "restart" && game.phase === "playing") return;
    if (command !== "restart" && game.phase !== "playing") return;
    const result = game.step(command);
    timeline = timelineForResult(result, visualNow);
    unlockAt = visualNow + interactionLock(result, timeline);
    setRevision((value) => value + 1);
  };

  onButtonPress(POCKET_BUTTON.SELECT, () => context.requestClose());
  onButtonPress(POCKET_BUTTON.UP, () => submit("up"));
  onButtonPress(POCKET_BUTTON.RIGHT, () => submit("right"));
  onButtonPress(POCKET_BUTTON.DOWN, () => submit("down"));
  onButtonPress(POCKET_BUTTON.LEFT, () => submit("left"));
  onButtonPress(POCKET_BUTTON.CIRCLE, () => submit("pulse"));
  onButtonPress(POCKET_BUTTON.SQUARE, () => submit("wait"));
  onButtonPress(POCKET_BUTTON.START | POCKET_BUTTON.CROSS, () => submit("restart"));

  onFrame(() => {
    const viewport = context.viewport();
    if (
      viewport.columns !== observedViewport.columns ||
      viewport.rows !== observedViewport.rows
    ) {
      observedViewport = viewport;
      setViewportRevision((value) => value + 1);
    }

    const timelineEnd = timeline.startedAt + timeline.durationMs;
    if (visualNow < timelineEnd || (queued !== undefined && visualNow < unlockAt)) {
      visualNow += FRAME_MS;
      setClock(visualNow);
    }
    if (queued !== undefined && visualNow >= unlockAt) {
      const command = queued;
      queued = undefined;
      perform(command);
    }
  });

  effect<PresentationScene | undefined>(() => {
    const next = scene();
    context.present(next, game);
    return next;
  });

  // Refresh HOST LINK once after Pocket has created the complete retained
  // pool. Subsequent telemetry updates ride ordinary gameplay/resize signals;
  // idle does not repaint merely to animate counters.
  queueMicrotask(() => setRevision((value) => value + 1));

  return root;
}

function bootTimeline(game: RoguelikeGame): EchoTimeline {
  return {
    startedAt: 0,
    durationMs: 1_200,
    cues: [{
      id: "array-handshake",
      kind: "pulse",
      startsAt: 0,
      durationMs: 1_200,
      anchor: { x: game.player.x, y: game.player.y },
      radius: game.pulseRadius + 1,
      actor: "player",
    }],
    trace: ["array online", "aperture handshake / listening"],
  };
}

function timelineForResult(result: TurnResult, now: number): EchoTimeline {
  const scheduled = scheduleEchoTimeline(result.events, now);
  const fallback = result.events.some(
    (event) => event.type === "blocked" && event.reason === "energy",
  )
    ? ["charge below emission threshold"]
    : result.events.some((event) => event.type === "blocked")
      ? ["bearing rejected / hard return"]
      : result.events.some((event) => event.type === "restart")
        ? ["array resynchronized"]
        : [];
  return {
    ...scheduled,
    trace: [...fallback, ...scheduled.trace].slice(-4),
  };
}

function interactionLock(result: TurnResult, timeline: EchoTimeline): number {
  if (!result.consumedTurn) return 0;
  if (result.events.some((event) => event.type === "win" || event.type === "game-over")) {
    return Math.min(320, timeline.durationMs);
  }
  if (result.events.some((event) => event.type === "pulse")) return 220;
  if (result.events.some((event) => event.type === "attack")) return 150;
  return Math.min(100, timeline.durationMs);
}

function sceneRuns(
  scene: PresentationScene,
  actorSlots: Map<string, number>,
  panelSlots: Map<string, number>,
): readonly (RenderRun | undefined)[] {
  const terrain: RenderRun[] = [];
  const effects: RenderRun[] = [];
  const actors: RenderRun[] = [];
  const pending = new Map<number, RenderRun>();
  for (const cell of scene.cells) {
    const zIndex = cellZ(cell.layer);
    const output = zIndex === 1 ? terrain : zIndex === 2 ? effects : actors;
    const previous = pending.get(zIndex);
    if (
      zIndex !== 3 &&
      previous !== undefined &&
      previous.row === cell.row &&
      previous.column + [...previous.text].length === cell.column &&
      previous.token === cell.token &&
      previous.emphasis === !!cell.emphasis &&
      previous.dim === !!cell.dim
    ) {
      const merged = { ...previous, text: previous.text + cell.glyph };
      pending.set(zIndex, merged);
      output[output.length - 1] = merged;
      continue;
    }
    const next: RenderRun = {
      key: zIndex === 3 ? cell.id : undefined,
      text: cell.glyph,
      column: cell.column,
      row: cell.row,
      token: cell.token,
      emphasis: !!cell.emphasis,
      dim: !!cell.dim,
      zIndex,
    };
    pending.set(zIndex, next);
    output.push(next);
  }

  const panels: RenderRun[] = [];
  for (const panel of scene.panels) {
    for (const text of panel.texts) {
      panels.push({
        key: `${panel.id}:text:${text.id}`,
        text: text.text,
        column: text.column,
        row: text.row,
        token: text.token,
        emphasis: !!text.emphasis,
        dim: !!text.dim,
        zIndex: 5,
      });
    }
    for (const rule of panel.rules) appendRule(panels, rule, panel.id);
  }

  const dropped =
    Math.max(0, terrain.length - TERRAIN_RUNS) +
    Math.max(0, effects.length - EFFECT_RUNS) +
    Math.max(0, actors.length - ACTOR_RUNS) +
    Math.max(0, panels.length - PANEL_RUNS);
  if (dropped > 0 && scene.layout.viewport.width >= 48) {
    const warning = `HOST DROP ${dropped}`;
    panels.unshift({
      key: "host.drop",
      text: warning,
      column: Math.max(0, scene.layout.viewport.width - warning.length - 8),
      row: 0,
      token: "flare",
      emphasis: true,
      dim: false,
      zIndex: 6,
    });
  }

  return [
    ...fixedBucket(terrain, TERRAIN_RUNS),
    ...fixedBucket(effects, EFFECT_RUNS),
    ...keyedBucket(actors, ACTOR_RUNS, actorSlots),
    ...keyedBucket(panels, PANEL_RUNS, panelSlots),
  ];
}

function cellZ(layer: "terrain" | "effect" | "actor"): number {
  return layer === "actor" ? 3 : layer === "effect" ? 2 : 1;
}

function fixedBucket(
  values: readonly RenderRun[],
  capacity: number,
): readonly (RenderRun | undefined)[] {
  const output = new Array<RenderRun | undefined>(capacity);
  const count = Math.min(values.length, capacity);
  for (let index = 0; index < count; index += 1) output[index] = values[index];
  return output;
}

function keyedBucket(
  values: readonly RenderRun[],
  capacity: number,
  assignments: Map<string, number>,
): readonly (RenderRun | undefined)[] {
  const output = new Array<RenderRun | undefined>(capacity);
  const liveKeys = new Set<string>();
  for (const value of values) {
    if (value.key !== undefined) liveKeys.add(value.key);
  }
  for (const [key, slot] of assignments) {
    if (!liveKeys.has(key) || slot >= capacity) assignments.delete(key);
  }

  const used = new Uint8Array(capacity);
  for (const slot of assignments.values()) used[slot] = 1;
  let nextFree = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    const key = value.key ?? `anonymous:${index}`;
    let slot = assignments.get(key);
    if (slot === undefined) {
      while (nextFree < capacity && used[nextFree] !== 0) nextFree += 1;
      if (nextFree >= capacity) continue;
      slot = nextFree;
      assignments.set(key, slot);
      used[slot] = 1;
    }
    output[slot] = value;
  }
  return output;
}

function appendRule(output: RenderRun[], rule: PanelRule, panelId: string): void {
  if (rule.orientation === "horizontal") {
    output.push({
      key: `${panelId}:rule:${rule.id}`,
      text: "─".repeat(rule.length),
      column: rule.column,
      row: rule.row,
      token: rule.token,
      emphasis: false,
      dim: true,
      zIndex: 4,
    });
    return;
  }
  for (let offset = 0; offset < rule.length; offset += 1) {
    output.push({
      key: `${panelId}:rule:${rule.id}:${offset}`,
      text: "│",
      column: rule.column,
      row: rule.row + offset,
      token: rule.token,
      emphasis: false,
      dim: true,
      zIndex: 4,
    });
  }
}

function runStyle(run: RenderRun | undefined): PocketStyle {
  if (run === undefined || run.text.length === 0) {
    return {
      display: 1,
      posType: 1,
      insetL: 0,
      insetT: 0,
      width: 1,
      height: 1,
    };
  }
  return {
    display: 0,
    posType: 1,
    insetL: run.column,
    insetT: run.row,
    width: [...run.text].length,
    height: 1,
    zIndex: run.zIndex,
    textColor: tokenHex(run.token),
    opacity: run.dim ? 0.44 : run.emphasis ? 1 : 0.78,
  };
}

function tokenHex(token: PresentationToken): string {
  const { red, green, blue } = PRESENTATION_TOKENS[token].rgb;
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
