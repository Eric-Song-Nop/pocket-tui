import type {
  Entity,
  GameEvent,
  GameSnapshot,
  Point as EnginePoint,
  RuleClause,
  RuleSet,
  TextEntity,
} from "./engine.js";

/**
 * Backend-neutral presentation model for Rule Shift.
 *
 * The visual language is a small movable-type proofing press: object glyphs
 * sit on a graphite chase while word entities are solid pieces of lead type.
 * Rule changes run a brass registration sweep across the newly composed line.
 * Nothing in this module knows about PocketJS, Canvas frames, ANSI, or Ghostty.
 */

export const RULE_SHIFT_TOKENS = {
  ink: { rgb: { red: 0x13, green: 0x16, blue: 0x1d }, ansi: 0 },
  lead: { rgb: { red: 0x55, green: 0x5d, blue: 0x6a }, ansi: 8 },
  paper: { rgb: { red: 0xee, green: 0xe5, blue: 0xc9 }, ansi: 15 },
  vermilion: { rgb: { red: 0xeb, green: 0x54, blue: 0x43 }, ansi: 9 },
  cyan: { rgb: { red: 0x55, green: 0xbf, blue: 0xd7 }, ansi: 14 },
  brass: { rgb: { red: 0xe8, green: 0xb8, blue: 0x4f }, ansi: 11 },
} as const;

export type RuleShiftToken = keyof typeof RULE_SHIFT_TOKENS;
export type PresentationMode = "wide" | "compact";
export type PresentationLayer = "bed" | "effect" | "entity";
export type PrintEffectKind =
  | "move"
  | "push"
  | "blocked"
  | "calibrate"
  | "transform"
  | "win";

export type Point = EnginePoint;

export interface PresentationViewport {
  readonly columns: number;
  readonly rows: number;
}

export interface CellRect {
  readonly column: number;
  readonly row: number;
  readonly width: number;
  readonly height: number;
}

export interface PresentationLayout {
  readonly mode: PresentationMode;
  readonly viewport: CellRect;
  readonly masthead: CellRect;
  readonly telemetry: CellRect;
  readonly board: CellRect;
  readonly proof: CellRect | null;
  readonly trace: CellRect;
  readonly command: CellRect;
}

export interface BoardProjection {
  readonly worldX: number;
  readonly worldY: number;
  readonly width: number;
  readonly height: number;
  readonly column: number;
  readonly row: number;
  /** Terminal columns reserved for one logical board cell. */
  readonly pitch: number;
  /** Visible ink width inside a logical cell; the remainder is a gutter. */
  readonly faceWidth: number;
}

export type RuleEntityLike = Entity;
export type RuleClauseLike = RuleClause;
export type RuleSetLike = RuleSet;
export type RuleSnapshotLike = GameSnapshot;
export type RuleEventLike = GameEvent;

export interface PresentationCell {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly text: string;
  readonly token: RuleShiftToken;
  readonly background?: RuleShiftToken;
  readonly layer: PresentationLayer;
  readonly world?: Readonly<Point>;
  readonly emphasis?: boolean;
  readonly dim?: boolean;
}

export interface PanelText {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly text: string;
  readonly token: RuleShiftToken;
  readonly emphasis?: boolean;
  readonly dim?: boolean;
}

export interface PanelRule {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly length: number;
  readonly orientation: "horizontal" | "vertical";
  readonly token: RuleShiftToken;
}

export interface PresentationPanel {
  readonly id: "masthead" | "telemetry" | "proof" | "trace" | "command";
  readonly rect: CellRect;
  readonly texts: readonly PanelText[];
  readonly rules: readonly PanelRule[];
}

export interface PrintCue {
  readonly id: string;
  readonly kind: PrintEffectKind;
  readonly startsAt: number;
  readonly durationMs: number;
  readonly anchor: Readonly<Point>;
  readonly from?: Readonly<Point>;
  readonly to?: Readonly<Point>;
  readonly entityId?: string;
  readonly direction?: string;
  readonly ruleRows?: readonly number[];
  /** Exact type cells taking part in a changed clause, in reading order. */
  readonly ruleCells?: readonly Readonly<Point>[];
  /** Object nouns whose live behavior changed with the calibrated clause. */
  readonly affectedNouns?: readonly string[];
  readonly affectedEntityIds?: readonly string[];
}

export interface PrintTimeline {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly cues: readonly PrintCue[];
  readonly trace: readonly string[];
}

export interface SampledPrintCue extends PrintCue {
  readonly elapsedMs: number;
  readonly progress: number;
}

export interface PresentationCursor {
  readonly column: number;
  readonly row: number;
  readonly visible: boolean;
  readonly shape: "underline";
  readonly token: RuleShiftToken;
}

export interface PresentationEffectSignal {
  readonly kind: PrintEffectKind | "idle";
  readonly anchor: Readonly<{ column: number; row: number }>;
  readonly token: RuleShiftToken;
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly progress: number;
}

export interface PresentationDiagnostics {
  readonly liveNodes?: number;
  readonly operations?: number;
  readonly frameGeneration?: number | bigint;
}

export interface PresentationScene {
  readonly palette: typeof RULE_SHIFT_TOKENS;
  readonly layout: PresentationLayout;
  readonly projection: BoardProjection;
  readonly cells: readonly PresentationCell[];
  readonly panels: readonly PresentationPanel[];
  readonly cursor: PresentationCursor;
  readonly effectSignal: PresentationEffectSignal;
}

export const PRINT_DURATIONS = {
  move: 120,
  push: 180,
  blocked: 240,
  calibrate: 540,
  transform: 320,
  win: 920,
} as const satisfies Readonly<Record<PrintEffectKind, number>>;

const EFFECT_PRIORITY: Readonly<Record<PrintEffectKind, number>> = {
  move: 1,
  push: 2,
  blocked: 3,
  calibrate: 4,
  transform: 5,
  win: 6,
};

const OBJECT_GLYPHS: Readonly<Record<string, string>> = {
  mote: "✦",
  orb: "◉",
  wall: "▥",
  goal: "◆",
  crate: "▣",
  bloom: "✿",
  gate: "╫",
};

const WORD_ABBREVIATIONS: Readonly<Record<string, string>> = {
  mote: "MO",
  orb: "OR",
  wall: "WA",
  goal: "GO",
  crate: "CR",
  bloom: "BL",
  gate: "GT",
  is: "IS",
  you: "YOU",
  win: "WIN",
  push: "PS",
  stop: "ST",
};

/** Cell-unit layout only. Board sizing and camera projection happen later. */
export function computePresentationLayout(
  viewport: PresentationViewport,
  board: Readonly<{ width: number; height: number }> = { width: 18, height: 12 },
): PresentationLayout {
  const columns = dimension(viewport.columns, "columns");
  const rows = dimension(viewport.rows, "rows");
  const boardWidth = dimension(board.width, "board.width");
  const boardHeight = dimension(board.height, "board.height");
  const viewportRect = rect(0, 0, columns, rows);
  const masthead = rect(0, 0, columns, rows > 0 ? 1 : 0);
  const commandHeight = rows >= 2 ? 1 : 0;
  const command = rect(0, rows - commandHeight, columns, commandHeight);

  // A wide proofing rail is earned only when the board can still display at
  // least a two-column type face. This prevents the responsive breakpoint
  // from shrinking the actual puzzle as the terminal becomes wider.
  const proofWidth = clamp(Math.floor(columns * 0.24), 20, 28);
  const wideFieldWidth = Math.max(0, columns - proofWidth - 2);
  const contentHeight = Math.max(0, command.row - 2);
  const canKeepBoard = wideFieldWidth >= boardWidth * 2 &&
    contentHeight >= Math.min(boardHeight, 3);
  const mode: PresentationMode = columns >= 86 && rows >= 18 && canKeepBoard
    ? "wide"
    : "compact";

  if (mode === "wide") {
    const divider = columns - proofWidth - 1;
    const boardRect = rect(0, 2, Math.max(0, divider - 1), Math.max(0, command.row - 2));
    const proof = rect(divider + 1, 2, proofWidth, Math.max(0, command.row - 2));
    const traceHeight = Math.min(3, proof.height);
    const trace = rect(proof.column, proof.row + proof.height - traceHeight, proof.width, traceHeight);
    return {
      mode,
      viewport: viewportRect,
      masthead,
      telemetry: rect(0, 1, columns, rows >= 3 ? 1 : 0),
      board: boardRect,
      proof,
      trace,
      command,
    };
  }

  const telemetryHeight = rows >= 3 ? 1 : 0;
  const contentRow = 1 + telemetryHeight;
  const available = Math.max(0, command.row - contentRow);
  const desiredTraceHeight = available >= 6 ? 2 : available >= 3 ? 1 : 0;
  let traceHeight: number;
  let separatorHeight: number;
  if (available >= boardHeight) {
    // The rules themselves outrank narration. Only spend surplus rows on the
    // trace once the entire board can remain visible.
    const surplus = available - boardHeight;
    traceHeight = surplus >= 2 ? Math.min(desiredTraceHeight, surplus - 1) : 0;
    separatorHeight = traceHeight > 0 ? 1 : 0;
  } else {
    // When the viewport is genuinely shorter than the board, keep one line
    // of trace when possible and let the camera follow the controlled object.
    traceHeight = available >= 3 ? 1 : 0;
    separatorHeight = traceHeight > 0 ? 1 : 0;
  }
  const boardHeightCells = available - traceHeight - separatorHeight;
  const traceRow = contentRow + boardHeightCells + separatorHeight;
  return {
    mode,
    viewport: viewportRect,
    masthead,
    telemetry: rect(0, 1, columns, telemetryHeight),
    board: rect(0, contentRow, columns, boardHeightCells),
    proof: null,
    trace: rect(0, traceRow, columns, traceHeight),
    command,
  };
}

/** Translate engine events into deterministic, overlapping print-shop cues. */
export function schedulePrintTimeline(
  events: readonly GameEvent[],
  startedAt: number,
): PrintTimeline {
  finiteNumber(startedAt, "startedAt");
  const cues: PrintCue[] = [];
  const trace: string[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    const offset = Math.min(index * 16, 96);
    const id = `print-${index}`;
    switch (event.type) {
      case "move": {
        const from = event.from;
        const to = event.to;
        cues.push(makeCue(`${id}-move`, "move", startedAt + offset, to, {
          from,
          to,
          entityId: event.entityId,
        }));
        break;
      }
      case "push": {
        const from = event.from;
        const to = event.to;
        cues.push(makeCue(`${id}-push`, "push", startedAt + offset, to, {
          from,
          to,
          entityId: event.entityId,
        }));
        trace.push("type advanced / impression held");
        break;
      }
      case "blocked": {
        const at = event.cell ?? event.from[0] ?? { x: 0, y: 0 };
        cues.push(makeCue(`${id}-blocked`, "blocked", startedAt + offset, at, {
          direction: event.direction,
        }));
        trace.push(`chase locked / ${event.reason ?? "blocked"}`);
        break;
      }
      case "transform": {
        const at = event.at;
        cues.push(makeCue(`${id}-transform`, "transform", startedAt + offset + 24, at, {
          entityId: event.entityId,
        }));
        trace.push("face recut / form changed");
        break;
      }
      case "rules-changed": {
        const addedKeys = new Set(event.added);
        const added = event.after.clauses.filter((clause) => addedKeys.has(clause.key));
        const removedKeys = new Set(event.removed);
        const removed = event.before.clauses.filter((clause) => removedKeys.has(clause.key));
        const changed = [...added, ...removed];
        const rows = ruleRows(changed);
        const anchor = ruleAnchor(changed) ?? { x: 0, y: rows[0] ?? 0 };
        if (changed.length > 0) {
          cues.push(makeCue(`${id}-calibrate`, "calibrate", startedAt + offset + 42, anchor, {
            ruleRows: rows,
            ruleCells: uniquePoints(changed.flatMap((clause) => clause.cells)),
            affectedNouns: [...new Set(changed.map((clause) => clause.subject))].sort(),
          }));
        }
        if (added.length > 0) {
          trace.push(`rule locked / ${added.length} new impression${added.length === 1 ? "" : "s"}`);
        }
        if (removed.length > 0) trace.push(`rule lifted / ${removed.length}`);
        break;
      }
      case "win": {
        const at = event.at;
        cues.push(makeCue(`${id}-win`, "win", startedAt + offset + 80, at));
        trace.push("proof approved / edition complete");
        break;
      }
      case "undo":
        trace.push("carriage returned / undo");
        break;
      case "restart":
        trace.push("chase reset / fresh proof");
        break;
      case "level-change":
        trace.push("new forme loaded");
        break;
      default:
        break;
    }
  }

  let durationMs = 0;
  for (const cue of cues) {
    durationMs = Math.max(durationMs, cue.startsAt + cue.durationMs - startedAt);
  }
  return { startedAt, durationMs, cues, trace: trace.slice(-4) };
}

export function samplePrintTimeline(
  timeline: PrintTimeline,
  now: number,
): readonly SampledPrintCue[] {
  finiteNumber(now, "now");
  const active: SampledPrintCue[] = [];
  for (const cue of timeline.cues) {
    const elapsedMs = now - cue.startsAt;
    if (elapsedMs < 0 || elapsedMs >= cue.durationMs) continue;
    active.push({
      ...cue,
      elapsedMs,
      progress: clamp(elapsedMs / cue.durationMs, 0, 1),
    });
  }
  return active;
}

/** Produce one complete retained-scene sample. */
export function present(
  snapshot: RuleSnapshotLike,
  timeline: PrintTimeline,
  viewport: PresentationViewport,
  now: number,
  diagnostics: PresentationDiagnostics = {},
): PresentationScene {
  const layout = computePresentationLayout(viewport, snapshot);
  const projection = projectBoard(snapshot, layout.board);
  const samples = samplePrintTimeline(timeline, now);
  const bed = paintBed(snapshot, projection);
  const effects = paintEffects(snapshot, projection, samples);
  const entities = paintEntities(snapshot, projection, samples);
  const cells = [...bed, ...effects, ...entities].sort(compareCells);
  const focus = focusEntity(snapshot);
  const focusCell = focus === undefined
    ? fallbackCursor(layout)
    : worldToScreen(projection, focus) ?? fallbackCursor(layout);
  const effectSignal = selectEffectSignal(samples, projection, focusCell);

  return {
    palette: RULE_SHIFT_TOKENS,
    layout,
    projection,
    cells,
    panels: buildPanels(snapshot, timeline, layout, diagnostics),
    cursor: {
      ...focusCell,
      visible: focus !== undefined && worldToScreen(projection, focus) !== undefined,
      shape: "underline",
      token: effectSignal.token,
    },
    effectSignal,
  };
}

function projectBoard(snapshot: RuleSnapshotLike, field: CellRect): BoardProjection {
  const pitch = choosePitch(snapshot.width, field.width);
  const visibleWidth = Math.min(snapshot.width, Math.floor(field.width / pitch));
  const visibleHeight = Math.min(snapshot.height, field.height);
  const focus = focusEntity(snapshot) ?? { x: Math.floor(snapshot.width / 2), y: Math.floor(snapshot.height / 2) };
  const worldX = clamp(focus.x - Math.floor(visibleWidth / 2), 0, Math.max(0, snapshot.width - visibleWidth));
  const worldY = clamp(focus.y - Math.floor(visibleHeight / 2), 0, Math.max(0, snapshot.height - visibleHeight));
  return {
    worldX,
    worldY,
    width: visibleWidth,
    height: visibleHeight,
    column: field.column + Math.floor((field.width - visibleWidth * pitch) / 2),
    row: field.row + Math.floor((field.height - visibleHeight) / 2),
    pitch,
    faceWidth: Math.max(1, pitch - (pitch >= 3 ? 1 : 0)),
  };
}

function choosePitch(boardWidth: number, fieldWidth: number): number {
  if (boardWidth > 0 && boardWidth * 6 <= fieldWidth) return 6;
  if (boardWidth > 0 && boardWidth * 5 <= fieldWidth) return 5;
  if (boardWidth > 0 && boardWidth * 4 <= fieldWidth) return 4;
  if (boardWidth > 0 && boardWidth * 3 <= fieldWidth) return 3;
  if (boardWidth > 0 && boardWidth * 2 <= fieldWidth) return 2;
  return 1;
}

function paintBed(
  snapshot: RuleSnapshotLike,
  projection: BoardProjection,
): PresentationCell[] {
  const cells: PresentationCell[] = [];
  const seed = hashString(snapshot.levelId);
  for (let dy = 0; dy < projection.height; dy += 1) {
    for (let dx = 0; dx < projection.width; dx += 1) {
      const x = projection.worldX + dx;
      const y = projection.worldY + dy;
      const edge = x === 0 || y === 0 || x === snapshot.width - 1 || y === snapshot.height - 1;
      const registration = x % 5 === 0 && y % 4 === 0;
      const grain = hashCell(seed, x, y) % 17 === 0;
      if (!edge && !registration && !grain) continue;
      cells.push({
        id: `bed-${x}-${y}`,
        column: projection.column + dx * projection.pitch,
        row: projection.row + dy,
        text: edge ? (projection.pitch > 1 ? "─".repeat(projection.faceWidth) : "·") : registration ? "+" : "·",
        token: "lead",
        layer: "bed",
        world: { x, y },
        dim: true,
      });
    }
  }
  return cells;
}

function paintEntities(
  snapshot: RuleSnapshotLike,
  projection: BoardProjection,
  samples: readonly SampledPrintCue[],
): PresentationCell[] {
  const activeIds = new Set(samples.map((sample) => sample.entityId).filter(isString));
  const activeRuleTextIds = new Set(
    snapshot.rules.clauses.flatMap((clause) => clause.textEntityIds),
  );
  const output: PresentationCell[] = [];
  const groups = new Map<string, Entity[]>();
  for (const entity of snapshot.entities) {
    const coordinate = `${entity.x},${entity.y}`;
    const group = groups.get(coordinate);
    if (group === undefined) groups.set(coordinate, [entity]);
    else group.push(entity);
  }

  for (const group of groups.values()) {
    const anchor = group[0];
    if (anchor === undefined) continue;
    const screen = worldToScreen(projection, anchor);
    if (screen === undefined) continue;

    // Multiple objects may intentionally share a coordinate (YOU touching
    // WIN is the important case). Give each face a stable sub-slot whenever
    // possible; at one-column zoom render an explicit composite proof mark
    // instead of silently painting the later object over the first.
    if (group.length > 1 && projection.faceWidth < group.length) {
      const ids = group.map((entity) => entity.id).sort();
      output.push({
        id: `entity-stack-${ids.join("+")}`,
        column: screen.column,
        row: screen.row,
        text: "◈",
        token: "brass",
        layer: "entity",
        world: { x: anchor.x, y: anchor.y },
        emphasis: true,
      });
      continue;
    }

    const slotWidth = Math.max(1, Math.floor(projection.faceWidth / group.length));
    for (let index = 0; index < group.length; index += 1) {
      const entity = group[index];
      if (entity === undefined) continue;
      const width = index === group.length - 1
        ? projection.faceWidth - slotWidth * index
        : slotWidth;
      const text = entity.kind === "text"
        ? wordFace(entityWord(entity), width)
        : objectFace(entity.noun, width);
      const activeRule = entity.kind === "text" && activeRuleTextIds.has(entity.id);
      const calibration = entity.kind === "object"
        ? samples.find((sample) => sample.kind === "calibrate" && cueAffectsEntity(sample, entity))
        : undefined;
      const calibrationFlash = calibration !== undefined &&
        Math.floor(calibration.progress * 12) % 2 === 0;
      const token = activeRule
        ? "ink"
        : calibrationFlash
          ? "ink"
        : entity.kind === "text"
          ? wordToken(entityWord(entity))
          : objectToken(entity.noun);
      const background = activeRule
        ? entity.kind === "text" && entity.word === "IS" ? "brass" : "paper"
        : calibrationFlash
          ? "brass"
        : entity.kind === "text" && width >= 2 ? "lead" : undefined;
      output.push({
        id: `entity-${entity.id}`,
        column: screen.column + slotWidth * index,
        row: screen.row,
        text,
        token,
        background,
        layer: "entity",
        world: { x: entity.x, y: entity.y },
        emphasis: activeIds.has(entity.id) || activeRule || calibration !== undefined || entity.kind === "text" || group.length > 1,
      });
    }
  }
  return output;
}

function paintEffects(
  snapshot: RuleSnapshotLike,
  projection: BoardProjection,
  samples: readonly SampledPrintCue[],
): PresentationCell[] {
  const output: PresentationCell[] = [];
  for (const sample of samples) {
    if (sample.kind === "calibrate") {
      const rows = sample.ruleRows?.length ? sample.ruleRows : [sample.anchor.y];
      const sweepX = projection.worldX + Math.min(
        projection.width - 1,
        Math.max(0, Math.floor(sample.progress * projection.width)),
      );
      for (const row of rows) {
        const screen = worldToScreen(projection, { x: sweepX, y: row });
        if (screen === undefined) continue;
        output.push(effectCell(sample, screen, projection.faceWidth >= 3 ? "━━" : "━", "brass", { x: sweepX, y: row }, `shuttle-${row}`));
      }

      const ruleCells = sample.ruleCells ?? [];
      for (let index = 0; index < ruleCells.length; index += 1) {
        const point = ruleCells[index];
        if (point === undefined) continue;
        const threshold = ((index + 1) / (ruleCells.length + 1)) * 0.7;
        if (sample.progress < threshold) continue;
        const screen = worldToScreen(projection, point);
        if (screen === undefined) continue;
        const markerColumn = projection.pitch > projection.faceWidth
          ? screen.column + projection.faceWidth
          : screen.column;
        output.push(effectCell(
          sample,
          { column: markerColumn, row: screen.row },
          sample.progress > 0.82 ? "·" : "▏",
          "brass",
          point,
          `rule-${index}`,
        ));
      }

      for (const entity of snapshot.entities) {
        if (entity.kind !== "object" || !cueAffectsEntity(sample, entity)) continue;
        const screen = worldToScreen(projection, entity);
        if (screen === undefined) continue;
        const markerColumn = projection.pitch > projection.faceWidth
          ? screen.column + projection.faceWidth
          : screen.column;
        output.push(effectCell(
          sample,
          { column: markerColumn, row: screen.row },
          Math.floor(sample.progress * 12) % 2 === 0 ? "┃" : "│",
          "cyan",
          entity,
          `object-${entity.id}`,
        ));
      }
      continue;
    }

    if (sample.kind === "win") {
      const radius = Math.max(1, Math.floor(sample.progress * Math.max(snapshot.width, snapshot.height)));
      for (const point of diamondRing(sample.anchor, radius)) {
        const screen = worldToScreen(projection, point);
        if (screen === undefined) continue;
        output.push(effectCell(sample, screen, sample.progress > 0.72 ? "·" : "✦", "brass", point));
      }
      continue;
    }

    if (sample.kind === "move" || sample.kind === "push") {
      if (sample.from === undefined) continue;
      const screen = worldToScreen(projection, sample.from);
      if (screen === undefined) continue;
      const marker = sample.kind === "push"
        ? proofMarkPosition(screen, projection)
        : screen;
      output.push(effectCell(
        sample,
        marker,
        sample.kind === "push" ? directionGlyph(sample.from, sample.to) : "·",
        sample.kind === "push" ? "brass" : "lead",
        sample.from,
      ));
      continue;
    }

    const screen = worldToScreen(projection, sample.anchor);
    if (screen === undefined) continue;
    const flash = Math.floor(sample.progress * 8) % 2 === 0;
    output.push(effectCell(
      sample,
      proofMarkPosition(screen, projection),
      sample.kind === "blocked" ? (flash ? "╳" : "×") : (flash ? "✣" : "✦"),
      sample.kind === "blocked" ? "vermilion" : "cyan",
      sample.anchor,
    ));
  }
  return output;
}

function effectCell(
  cue: SampledPrintCue,
  screen: Readonly<{ column: number; row: number }>,
  text: string,
  token: RuleShiftToken,
  world: Readonly<Point>,
  idSuffix = `${world.x}-${world.y}`,
): PresentationCell {
  return {
    id: `effect-${cue.id}-${idSuffix}`,
    column: screen.column,
    row: screen.row,
    text,
    token,
    layer: "effect",
    world,
    emphasis: cue.progress < 0.75,
    dim: cue.progress > 0.82,
  };
}

function proofMarkPosition(
  screen: Readonly<{ column: number; row: number }>,
  projection: BoardProjection,
): { column: number; row: number } {
  return {
    column: projection.pitch > projection.faceWidth
      ? screen.column + projection.faceWidth
      : screen.column,
    row: screen.row,
  };
}

function buildPanels(
  snapshot: RuleSnapshotLike,
  timeline: PrintTimeline,
  layout: PresentationLayout,
  diagnostics: PresentationDiagnostics,
): readonly PresentationPanel[] {
  const edition = `F${String(snapshot.levelIndex + 1).padStart(2, "0")}`;
  const turn = `P${String(snapshot.turn).padStart(3, "0")}`;
  const mastheadTitle = "RULE//SHIFT  MOVABLE TYPE PROOF";
  const mastheadRight = `${edition} ${turn}`;
  const masthead: PresentationPanel = {
    id: "masthead",
    rect: layout.masthead,
    texts: layout.masthead.height > 0
      ? [
          panelText("masthead.title", 0, 0, clip(mastheadTitle, layout.masthead.width), "paper", true),
          panelText(
            "masthead.edition",
            Math.max(0, layout.masthead.width - mastheadRight.length),
            0,
            clip(mastheadRight, layout.masthead.width),
            snapshot.phase === "won" ? "brass" : "lead",
            snapshot.phase === "won",
          ),
        ]
      : [],
    rules: [],
  };

  const host = hostLinkText(diagnostics);
  const compactStatus = `${edition} ${turn}  ${snapshot.phase === "won" ? "PROOF ✓" : "PRESS READY"}  ${host}`;
  const telemetry: PresentationPanel = {
    id: "telemetry",
    rect: layout.telemetry,
    texts: layout.telemetry.height > 0
      ? [panelText(
          "telemetry.line",
          layout.telemetry.column,
          layout.telemetry.row,
          clip(compactStatus, layout.telemetry.width),
          snapshot.phase === "won" ? "brass" : "cyan",
          true,
        )]
      : [],
    rules: [],
  };

  const traceCount = Math.min(2, layout.trace.height);
  const sourceTrace = timeline.trace.length > 0
    ? timeline.trace
    : [snapshot.hint?.trim() || "set the words; change the world"];
  const traceLines = traceCount > 0 ? sourceTrace.slice(-traceCount) : [];
  const trace: PresentationPanel = {
    id: "trace",
    rect: layout.trace,
    texts: traceLines.map((text, index) => panelText(
      `trace.${index}`,
      layout.trace.column,
      layout.trace.row + index,
      clip(text, layout.trace.width),
      index === traceLines.length - 1 ? "paper" : "lead",
      false,
      index !== traceLines.length - 1,
    )),
    rules: layout.mode === "compact" && layout.trace.height > 0 && layout.trace.row > 0
      ? [{
          id: "trace.rule",
          column: layout.trace.column,
          row: layout.trace.row - 1,
          length: layout.trace.width,
          orientation: "horizontal",
          token: "lead",
        }]
      : [],
  };

  const commandCopy = layout.mode === "wide"
    ? "WASD / arrows move   Z undo   R reset   P/N forme   Q leave"
    : "MOVE wasd  UNDO z  RESET r  LEVEL p/n  QUIT q";
  const command: PresentationPanel = {
    id: "command",
    rect: layout.command,
    texts: layout.command.height > 0
      ? [panelText(
          "command.help",
          layout.command.column,
          layout.command.row,
          clip(commandCopy, layout.command.width),
          snapshot.phase === "won" ? "brass" : "lead",
          snapshot.phase === "won",
        )]
      : [],
    rules: [],
  };

  if (layout.proof === null) return [masthead, telemetry, trace, command];

  const proof = layout.proof;
  const contentWidth = Math.max(0, proof.width - 1);
  const rules = activeRuleLabels(snapshot.rules);
  const lines: PanelText[] = [
    panelText("proof.heading", proof.column, proof.row, clip("ACTIVE IMPRESSIONS", contentWidth), "brass", true),
    panelText("proof.level", proof.column, proof.row + 2, clip(snapshot.title.toUpperCase(), contentWidth), "paper", true),
    panelText("proof.rule-label", proof.column, proof.row + 4, clip("LOCKED RULES", contentWidth), "lead"),
    ...rules.slice(0, Math.max(0, Math.min(7, proof.height - 11))).map((rule, index) => panelText(
      `proof.rule.${index}`,
      proof.column,
      proof.row + 5 + index,
      clip(`${String(index + 1).padStart(2, "0")} ${rule}`, contentWidth),
      "paper",
      true,
    )),
  ];
  const hostRow = Math.min(proof.row + proof.height - 4, layout.trace.row - 1);
  if (hostRow >= proof.row) {
    lines.push(panelText("proof.host-label", proof.column, Math.max(proof.row, hostRow - 1), "POCKETJS HOST", "lead"));
    lines.push(panelText("proof.host", proof.column, hostRow, clip(host, contentWidth), "cyan", true));
  }
  const proofPanel: PresentationPanel = {
    id: "proof",
    rect: proof,
    texts: lines.filter((line) => line.row >= proof.row && line.row < proof.row + proof.height),
    rules: proof.height > 0
      ? [{
          id: "proof.divider",
          column: proof.column - 1,
          row: proof.row,
          length: proof.height,
          orientation: "vertical",
          token: "lead",
        }]
      : [],
  };
  return [masthead, telemetry, proofPanel, trace, command];
}

function selectEffectSignal(
  samples: readonly SampledPrintCue[],
  projection: BoardProjection,
  fallback: Readonly<{ column: number; row: number }>,
): PresentationEffectSignal {
  let selected: SampledPrintCue | undefined;
  for (const sample of samples) {
    if (
      selected === undefined ||
      EFFECT_PRIORITY[sample.kind] > EFFECT_PRIORITY[selected.kind] ||
      (EFFECT_PRIORITY[sample.kind] === EFFECT_PRIORITY[selected.kind] && sample.startsAt > selected.startsAt)
    ) {
      selected = sample;
    }
  }
  if (selected === undefined) {
    return {
      kind: "idle",
      anchor: fallback,
      token: "cyan",
      startedAt: null,
      durationMs: 0,
      progress: 1,
    };
  }
  return {
    kind: selected.kind,
    anchor: worldToScreen(projection, selected.anchor) ?? fallback,
    token: effectToken(selected.kind),
    startedAt: selected.startsAt,
    durationMs: selected.durationMs,
    progress: selected.progress,
  };
}

function focusEntity(snapshot: RuleSnapshotLike): RuleEntityLike | undefined {
  const youSubjects = activeClauses(snapshot.rules)
    .filter((clause) => normalizedWord(clause.predicate) === "you")
    .map((clause) => normalizedWord(clause.subject));
  if (youSubjects.length > 0) {
    const match = snapshot.entities.find(
      (entity) => entity.kind === "object" && youSubjects.includes(entity.noun.toLowerCase()),
    );
    if (match !== undefined) return match;
  }
  return snapshot.entities.find((entity) => entity.kind === "object" && entity.noun.toLowerCase() === "mote")
    ?? snapshot.entities.find((entity) => entity.kind === "object");
}

function activeRuleLabels(rules: RuleSet): readonly string[] {
  return activeClauses(rules).map((clause) => {
    const subject = normalizedWord(clause.subject).toUpperCase();
    const predicate = normalizedWord(clause.predicate).toUpperCase();
    if (subject.length > 0 && predicate.length > 0) return `${subject} IS ${predicate}`;
    return String(clause.key ?? "RULE").toUpperCase().replaceAll("_", " ");
  });
}

function activeClauses(rules: RuleSet): readonly RuleClause[] {
  return rules.clauses;
}

function normalizedWord(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (value !== null && typeof value === "object") {
    for (const key of ["word", "name", "noun", "property", "value"] as const) {
      const candidate = (value as Readonly<Record<string, unknown>>)[key];
      if (typeof candidate === "string") return candidate.toLowerCase();
    }
  }
  return "";
}

function entityWord(entity: TextEntity): string {
  return entity.word.toLowerCase();
}

function wordFace(word: string, width: number): string {
  const normalized = word.toLowerCase();
  if (width === 1) return (normalized === "is" ? "=" : normalized[0] ?? "?").toUpperCase();
  const full = normalized.toUpperCase();
  // A clipped word looks like a different rule. If a face cannot hold the
  // complete spelling, switch to the deliberate two-letter sort mark.
  const candidate = [...full].length > width
    ? WORD_ABBREVIATIONS[normalized] ?? full[0] ?? "?"
    : full;
  return center(clip(candidate.toUpperCase(), width), width);
}

function objectFace(noun: string, width: number): string {
  const glyph = OBJECT_GLYPHS[noun.toLowerCase()] ?? noun[0]?.toUpperCase() ?? "?";
  return center(glyph, width);
}

function objectToken(noun: string): RuleShiftToken {
  switch (noun.toLowerCase()) {
    case "mote":
    case "gate":
      return "paper";
    case "goal":
    case "orb":
    case "crate":
      return "brass";
    case "wall":
      return "lead";
    case "bloom":
      return "cyan";
    default:
      return "lead";
  }
}

function wordToken(word: string): RuleShiftToken {
  switch (word.toLowerCase()) {
    case "is":
      return "brass";
    case "you":
    case "win":
      return "cyan";
    case "push":
    case "stop":
      return "paper";
    default:
      return objectToken(word);
  }
}

function effectToken(kind: PrintEffectKind): RuleShiftToken {
  if (kind === "blocked") return "vermilion";
  if (kind === "move") return "lead";
  if (kind === "transform") return "cyan";
  return "brass";
}

function activeRuleCoordinates(clauses: readonly RuleClause[]): readonly Point[] {
  const output: Point[] = [];
  for (const clause of clauses) {
    for (const point of clause.cells) output.push(point);
  }
  return output;
}

function ruleRows(clauses: readonly RuleClause[]): readonly number[] {
  return [...new Set(activeRuleCoordinates(clauses).map((point) => point.y))].sort((a, b) => a - b);
}

function ruleAnchor(clauses: readonly RuleClause[]): Point | undefined {
  const coordinates = activeRuleCoordinates(clauses);
  if (coordinates.length === 0) return undefined;
  let x = 0;
  let y = 0;
  for (const point of coordinates) {
    x += point.x;
    y += point.y;
  }
  return { x: Math.round(x / coordinates.length), y: Math.round(y / coordinates.length) };
}

function uniquePoints(points: readonly Readonly<Point>[]): readonly Point[] {
  const seen = new Set<string>();
  const output: Point[] = [];
  for (const point of points) {
    const key = `${point.x},${point.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ x: point.x, y: point.y });
  }
  return output;
}

function cueAffectsEntity(
  cue: PrintCue,
  entity: Extract<Entity, { readonly kind: "object" }>,
): boolean {
  if (cue.affectedEntityIds?.includes(entity.id) === true) return true;
  const noun = entity.noun.toLowerCase();
  return cue.affectedNouns?.some((candidate) => candidate.toLowerCase() === noun) === true;
}

function makeCue(
  id: string,
  kind: PrintEffectKind,
  startsAt: number,
  anchor: Readonly<Point>,
  extra: Partial<Omit<PrintCue, "id" | "kind" | "startsAt" | "durationMs" | "anchor">> = {},
): PrintCue {
  return { id, kind, startsAt, durationMs: PRINT_DURATIONS[kind], anchor, ...extra };
}

function worldToScreen(
  projection: BoardProjection,
  world: Readonly<Point>,
): { column: number; row: number } | undefined {
  const x = world.x - projection.worldX;
  const y = world.y - projection.worldY;
  if (x < 0 || y < 0 || x >= projection.width || y >= projection.height) return undefined;
  return {
    column: projection.column + x * projection.pitch,
    row: projection.row + y,
  };
}

function fallbackCursor(layout: PresentationLayout): { column: number; row: number } {
  return {
    column: clamp(layout.board.column, 0, Math.max(0, layout.viewport.width - 1)),
    row: clamp(layout.board.row, 0, Math.max(0, layout.viewport.height - 1)),
  };
}

function diamondRing(centerPoint: Readonly<Point>, radius: number): readonly Point[] {
  if (radius <= 0) return [centerPoint];
  const points: Point[] = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    const dy = radius - Math.abs(dx);
    points.push({ x: centerPoint.x + dx, y: centerPoint.y + dy });
    if (dy !== 0) points.push({ x: centerPoint.x + dx, y: centerPoint.y - dy });
  }
  return points;
}

function directionGlyph(from: Readonly<Point>, to?: Readonly<Point>): string {
  if (to === undefined) return "›";
  if (to.x > from.x) return "›";
  if (to.x < from.x) return "‹";
  if (to.y > from.y) return "⌄";
  return "⌃";
}

function compareCells(left: PresentationCell, right: PresentationCell): number {
  return left.row - right.row || left.column - right.column || layerZ(left.layer) - layerZ(right.layer) || left.id.localeCompare(right.id);
}

function layerZ(layer: PresentationLayer): number {
  return layer === "entity" ? 3 : layer === "effect" ? 2 : 1;
}

function hostLinkText(diagnostics: PresentationDiagnostics): string {
  const nodes = diagnostics.liveNodes === undefined ? "—" : String(diagnostics.liveNodes);
  const ops = diagnostics.operations === undefined ? "—" : String(diagnostics.operations);
  const frame = diagnostics.frameGeneration === undefined ? "—" : String(diagnostics.frameGeneration);
  return `HOST N${nodes} O${ops} F${frame}`;
}

function panelText(
  id: string,
  column: number,
  row: number,
  text: string,
  token: RuleShiftToken,
  emphasis = false,
  dim = false,
): PanelText {
  return { id, column, row, text, token, emphasis, dim };
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function center(text: string, width: number): string {
  const clipped = clip(text, width);
  const missing = Math.max(0, width - [...clipped].length);
  const left = Math.floor(missing / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(missing - left)}`;
}

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  return [...value].slice(0, width).join("");
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashCell(seed: number, x: number, y: number): number {
  let value = seed ^ Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0xc2b2, 0x27d4eb2d);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return value >>> 0;
}

function rect(column: number, row: number, width: number, height: number): CellRect {
  return { column, row, width, height };
}

function dimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function finiteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
