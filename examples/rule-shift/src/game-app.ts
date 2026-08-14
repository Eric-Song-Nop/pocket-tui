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
  createRuleGame,
  type Direction,
  type GameCommand,
  type GameSnapshot,
  type TurnResult,
} from "./engine.js";
import {
  PRINT_DURATIONS,
  RULE_SHIFT_TOKENS,
  present,
  schedulePrintTimeline,
  type PanelRule,
  type PresentationDiagnostics,
  type PresentationScene,
  type PrintTimeline,
  type RuleShiftToken,
  type PresentationViewport,
} from "./presentation.js";
import { appendPocketChildren, pocketText, pocketView, type PocketStyle } from "./pocket-ui.js";

// Pocket's simulation clock must divide 60 exactly. Thirty hertz keeps the
// registration sweep fluid while leaving terminal diff output comfortably low.
export const RULE_SHIFT_FPS = 30;
const FRAME_MS = 1_000 / RULE_SHIFT_FPS;
const BOOT_NOW_MS = 80;

// Proven against the built-in pack's 13×9 maximum board: the sparse chase
// needs <80 runs, the largest win ring <60, every level has <24 entities, and
// the wide proof/trace uses <70 runs. These caps leave deliberate headroom
// without paying two HostOps nodes for hundreds of unreachable slots.
const BED_RUNS = 160;
const EFFECT_RUNS = 128;
const ENTITY_RUNS = 64;
const PANEL_RUNS = 96;
const RUN_POOL_SIZE = BED_RUNS + EFFECT_RUNS + ENTITY_RUNS + PANEL_RUNS;
const MAX_PENDING_ACTIONS = 8;

interface RenderRun {
  readonly key?: string;
  readonly text: string;
  readonly column: number;
  readonly row: number;
  readonly token: RuleShiftToken;
  readonly background?: RuleShiftToken;
  readonly emphasis: boolean;
  readonly dim: boolean;
  readonly zIndex: number;
}

type QueuedAction = Direction | "undo" | "restart" | "next-level" | "previous-level";

export interface RuleShiftContext {
  viewport(): PresentationViewport;
  diagnostics(): PresentationDiagnostics;
  present(scene: PresentationScene, snapshot: GameSnapshot): void;
  requestClose(): void;
}

export interface RuleShiftOptions {
  readonly context: RuleShiftContext;
  readonly startLevel?: string | number;
}

/** Complete PocketJS component tree for the rule puzzle showcase. */
export function RuleShift(options: RuleShiftOptions): NodeMirror {
  const { context } = options;
  const game = createRuleGame(undefined, options.startLevel ?? 0);
  let snapshot = game.snapshot();
  let timeline = initialTimeline(snapshot);
  let visualNow = BOOT_NOW_MS;
  let unlockAt = 0;
  // Button handlers run earlier than this component's onFrame hook. Hold a
  // freshly scheduled cue at progress zero for the current host render rather
  // than immediately skipping its first portable CanvasFrame.
  let timelineChangedThisFrame = false;
  const pendingActions: QueuedAction[] = [];
  let observedViewport = context.viewport();

  const [revision, setRevision] = createSignal(0);
  const [clock, setClock] = createSignal(visualNow);
  const [viewportRevision, setViewportRevision] = createSignal(0);
  const entitySlots = new Map<string, number>();
  const panelSlots = new Map<string, number>();

  const scene = createMemo(() => {
    revision();
    viewportRevision();
    return present(snapshot, timeline, observedViewport, clock(), context.diagnostics());
  });
  const runs = createMemo(() => sceneRuns(scene(), entitySlots, panelSlots));

  const root = pocketView({
    width: -1,
    height: -1,
    overflow: 1,
    bgColor: tokenHex("ink"),
  });
  for (let index = 0; index < RUN_POOL_SIZE; index += 1) {
    const node = pocketText(
      () => runs()[index]?.text ?? "",
      () => ruleShiftRunStyle(runs()[index]),
    );
    appendPocketChildren(root, node);
  }

  const submit = (action: QueuedAction): void => {
    if (visualNow < unlockAt) {
      // PocketTUI delivers bounded discrete button edges. Preserve them in
      // order through the animation lock so a batched terminal read
      // cannot lose a deliberate turn while a short print cue is playing.
      if (pendingActions.length === MAX_PENDING_ACTIONS) pendingActions.shift();
      pendingActions.push(action);
      return;
    }
    perform(action);
  };

  const perform = (action: QueuedAction): void => {
    const result = game.dispatch(action as GameCommand);
    snapshot = result.snapshot;
    const nextTimeline = timelineForResult(result, visualNow);
    timeline = replacesPrintTimeline(result)
      ? nextTimeline
      : mergeActivePrintTimelines(timeline, nextTimeline, visualNow);
    unlockAt = visualNow + interactionLock(result);
    timelineChangedThisFrame = nextTimeline.cues.length > 0;
    setRevision((value) => value + 1);
  };

  onButtonPress(POCKET_BUTTON.SELECT, () => context.requestClose());
  onButtonPress(POCKET_BUTTON.UP, () => submit("up"));
  onButtonPress(POCKET_BUTTON.RIGHT, () => submit("right"));
  onButtonPress(POCKET_BUTTON.DOWN, () => submit("down"));
  onButtonPress(POCKET_BUTTON.LEFT, () => submit("left"));
  onButtonPress(POCKET_BUTTON.SQUARE, () => submit("undo"));
  onButtonPress(POCKET_BUTTON.START, () => submit("restart"));
  onButtonPress(POCKET_BUTTON.RTRIGGER, () => submit("next-level"));
  onButtonPress(POCKET_BUTTON.LTRIGGER, () => submit("previous-level"));

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
    if (
      !timelineChangedThisFrame &&
      (visualNow < timelineEnd || (pendingActions.length > 0 && visualNow < unlockAt))
    ) {
      visualNow += FRAME_MS;
      setClock(visualNow);
    }
    if (pendingActions.length > 0 && visualNow >= unlockAt) {
      const action = pendingActions.shift();
      if (action !== undefined) perform(action);
    }
    timelineChangedThisFrame = false;
  });

  effect<PresentationScene | undefined>(() => {
    const next = scene();
    context.present(next, snapshot);
    return next;
  });

  // Refresh backend telemetry once the complete retained pool exists.
  queueMicrotask(() => setRevision((value) => value + 1));
  return root;
}

function initialTimeline(
  snapshot: GameSnapshot,
  startedAt = 0,
  transition: "initial-load" | "undo" | "restart" | "stage-change" = "initial-load",
): PrintTimeline {
  const coordinates = snapshot.rules.clauses.flatMap((clause) => clause.cells);
  const ruleCells = [...new Map(coordinates.map((point) => [`${point.x},${point.y}`, point])).values()];
  const rows = [...new Set(coordinates.map((point) => point.y))].sort((left, right) => left - right);
  const affectedNouns = [...new Set(snapshot.rules.clauses.map((clause) => clause.subject))].sort();
  const first = coordinates[0] ?? { x: Math.floor(snapshot.width / 2), y: Math.floor(snapshot.height / 2) };
  return {
    startedAt,
    durationMs: PRINT_DURATIONS.calibrate + 140,
    cues: [{
      id: `forme-${snapshot.levelId}`,
      kind: "calibrate",
      startsAt: startedAt,
      durationMs: PRINT_DURATIONS.calibrate + 140,
      anchor: first,
      ruleRows: rows,
      ruleCells,
      affectedNouns,
      transition,
    }],
    trace: ["forme seated / pins aligned", `${snapshot.rules.clauses.length} rules under pressure`],
  };
}

/** Event-to-animation policy exported for deterministic presentation tests. */
export function timelineForResult(result: TurnResult, now: number): PrintTimeline {
  if (result.events.some((event) => event.type === "level-change")) {
    return initialTimeline(result.snapshot, now, "stage-change");
  }
  if (result.events.some((event) => event.type === "restart")) {
    return initialTimeline(result.snapshot, now, "restart");
  }
  if (result.events.some((event) => event.type === "undo")) {
    const restored = initialTimeline(result.snapshot, now, "undo");
    return {
      ...restored,
      trace: ["carriage returned / proof restored"],
    };
  }
  return schedulePrintTimeline(result.events, now);
}

function replacesPrintTimeline(result: TurnResult): boolean {
  return result.events.some(
    (event) => event.type === "level-change" || event.type === "restart" || event.type === "undo",
  );
}

/**
 * Keep unfinished ink in the portable renderer when another queued turn
 * starts. The semantic Ghostty bus samples the same merged cue set, but this
 * primarily prevents CanvasFrame particles from being cut off by the shorter
 * interaction lock.
 */
function mergeActivePrintTimelines(
  previous: PrintTimeline,
  next: PrintTimeline,
  now: number,
): PrintTimeline {
  const surviving = previous.cues.filter((cue) => cue.startsAt + cue.durationMs > now);
  if (surviving.length === 0) return next;

  const cues = [...surviving, ...next.cues];
  const startedAt = Math.min(next.startedAt, ...cues.map((cue) => cue.startsAt));
  const end = Math.max(startedAt, ...cues.map((cue) => cue.startsAt + cue.durationMs));
  return {
    startedAt,
    durationMs: end - startedAt,
    cues,
    trace: [...previous.trace, ...next.trace].slice(-4),
  };
}

function interactionLock(result: TurnResult): number {
  if (result.events.some((event) => event.type === "win")) return 360;
  if (result.events.some((event) => event.type === "rules-changed")) return 250;
  if (result.events.some((event) => event.type === "blocked")) return 150;
  if (result.events.some((event) => event.type === "push")) return 120;
  if (result.consumedTurn) return 75;
  return 0;
}

function sceneRuns(
  scene: PresentationScene,
  entitySlots: Map<string, number>,
  panelSlots: Map<string, number>,
): readonly (RenderRun | undefined)[] {
  const bed: RenderRun[] = [];
  const effects: RenderRun[] = [];
  const entities: RenderRun[] = [];
  const lastByLayer = new Map<number, RenderRun>();

  for (const cell of scene.cells) {
    // Portable particles are short-lived gameplay feedback, so they must sit
    // above the physical tile they annotate. Keeping effects below entities
    // made push trails technically present but visually erased by the moving
    // actor/crate faces.
    const zIndex = cell.layer === "effect" ? 4 : cell.layer === "entity" ? 3 : 1;
    const bucket = cell.layer === "bed" ? bed : cell.layer === "effect" ? effects : entities;
    const previous = lastByLayer.get(zIndex);
    if (
      zIndex === 1 &&
      previous !== undefined &&
      previous.row === cell.row &&
      previous.column + [...previous.text].length === cell.column &&
      previous.token === cell.token &&
      previous.background === cell.background &&
      previous.emphasis === !!cell.emphasis &&
      previous.dim === !!cell.dim
    ) {
      const merged = { ...previous, text: previous.text + cell.text };
      lastByLayer.set(zIndex, merged);
      bucket[bucket.length - 1] = merged;
      continue;
    }
    const next: RenderRun = {
      key: zIndex === 3 ? cell.id : undefined,
      text: cell.text,
      column: cell.column,
      row: cell.row,
      token: cell.token,
      background: cell.background,
      emphasis: !!cell.emphasis,
      dim: !!cell.dim,
      zIndex,
    };
    lastByLayer.set(zIndex, next);
    bucket.push(next);
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
    for (const rule of panel.rules) appendRule(panels, panel.id, rule);
  }

  const dropped =
    Math.max(0, bed.length - BED_RUNS) +
    Math.max(0, effects.length - EFFECT_RUNS) +
    Math.max(0, entities.length - ENTITY_RUNS) +
    Math.max(0, panels.length - PANEL_RUNS);
  if (dropped > 0 && scene.layout.viewport.width >= 44) {
    const warning = `HOST DROP ${dropped}`;
    panels.unshift({
      key: "host.drop",
      text: warning,
      column: Math.max(0, scene.layout.viewport.width - warning.length - 9),
      row: 0,
      token: "vermilion",
      emphasis: true,
      dim: false,
      zIndex: 6,
    });
  }

  return [
    ...fixedBucket(bed, BED_RUNS),
    ...fixedBucket(effects, EFFECT_RUNS),
    ...keyedBucket(entities, ENTITY_RUNS, entitySlots),
    ...keyedBucket(panels, PANEL_RUNS, panelSlots),
  ];
}

function appendRule(output: RenderRun[], panelId: string, rule: PanelRule): void {
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
  const live = new Set(values.map((value, index) => value.key ?? `anonymous:${index}`));
  for (const [key, slot] of assignments) {
    if (!live.has(key) || slot >= capacity) assignments.delete(key);
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

/** Project one retained run-pool slot into PocketJS inline style properties. */
export function ruleShiftRunStyle(run: RenderRun | undefined): PocketStyle {
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
  const base: Record<string, number | string> = {
    display: 0,
    posType: 1,
    insetL: run.column,
    insetT: run.row,
    width: [...run.text].length,
    height: 1,
    zIndex: run.zIndex,
    textColor: tokenHex(run.token),
    // PocketJS 0.6 only sends keys present in the next inline style object.
    // Explicitly clear a pooled slot's prior background when its new run has
    // none, otherwise the retained HostNode keeps the stale color.
    bgColor: run.background === undefined ? 0 : tokenHex(run.background),
    opacity: run.dim ? 0.42 : run.emphasis ? 1 : 0.82,
  };
  return base;
}

function tokenHex(token: RuleShiftToken): string {
  const { red, green, blue } = RULE_SHIFT_TOKENS[token].rgb;
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
