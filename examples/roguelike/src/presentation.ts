import type {
  EnemyKind,
  GameEvent,
  ItemKind,
  Point,
  RoguelikeGame,
} from "./game.js";

/**
 * Terminal-independent presentation model for Signal Below.
 *
 * The module deliberately knows nothing about PocketTUI, ANSI, timers, or an
 * output device. A PocketJS view can retain the panels by their stable IDs,
 * while a backend paints the sparse field cells and translates effectSignal
 * into an optional terminal-specific enhancement.
 */

export const PRESENTATION_TOKENS = {
  abyss: { rgb: { red: 0x07, green: 0x10, blue: 0x14 }, ansi: 0 },
  silt: { rgb: { red: 0x32, green: 0x4a, blue: 0x48 }, ansi: 8 },
  bone: { rgb: { red: 0xd8, green: 0xd2, blue: 0xbc }, ansi: 15 },
  verdigris: { rgb: { red: 0x55, green: 0xc7, blue: 0xae }, ansi: 14 },
  bruise: { rgb: { red: 0xa7, green: 0x9a, blue: 0xef }, ansi: 13 },
  flare: { rgb: { red: 0xff, green: 0x71, blue: 0x5b }, ansi: 9 },
} as const;

export type PresentationToken = keyof typeof PRESENTATION_TOKENS;
export type PresentationMode = "wide" | "compact";
export type PresentationLayer = "terrain" | "effect" | "actor";
export type EchoEffectKind =
  | "move"
  | "melee"
  | "beam"
  | "pulse"
  | "pickup"
  | "damage"
  | "death"
  | "win";

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
  readonly topline: CellRect;
  readonly field: CellRect;
  readonly receiver: CellRect | null;
  readonly trace: CellRect;
  readonly command: CellRect;
}

export interface MapProjection {
  /** Top-left world cell currently materialized. */
  readonly worldX: number;
  readonly worldY: number;
  readonly width: number;
  readonly height: number;
  /** Top-left terminal cell; may letterbox a world smaller than the field. */
  readonly column: number;
  readonly row: number;
}

export interface PresentationCell {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly glyph: string;
  readonly token: PresentationToken;
  readonly layer: PresentationLayer;
  readonly emphasis?: boolean;
  readonly dim?: boolean;
  readonly world: Readonly<Point>;
}

/** Stable text slot suitable for a retained Text node. */
export interface PanelText {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly text: string;
  readonly token: PresentationToken;
  readonly emphasis?: boolean;
  readonly dim?: boolean;
}

export interface PanelRule {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly length: number;
  readonly orientation: "horizontal" | "vertical";
  readonly token: PresentationToken;
}

export interface PresentationPanel {
  readonly id: "topline" | "receiver" | "trace" | "command";
  readonly rect: CellRect;
  readonly texts: readonly PanelText[];
  readonly rules: readonly PanelRule[];
}

export interface EchoCue {
  readonly id: string;
  readonly kind: EchoEffectKind;
  readonly startsAt: number;
  readonly durationMs: number;
  readonly anchor: Readonly<Point>;
  readonly from?: Readonly<Point>;
  readonly to?: Readonly<Point>;
  readonly radius?: number;
  readonly actor?: "player" | "enemy";
  readonly actorId?: string;
  readonly item?: ItemKind;
}

export interface EchoTimeline {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly cues: readonly EchoCue[];
  readonly trace: readonly string[];
}

export interface SampledEchoCue extends EchoCue {
  readonly elapsedMs: number;
  readonly progress: number;
}

export interface PresentationCursor {
  readonly column: number;
  readonly row: number;
  readonly visible: boolean;
  readonly shape: "underline";
  readonly token: PresentationToken;
}

export interface PresentationEffectSignal {
  readonly kind: EchoEffectKind | "idle";
  readonly anchor: Readonly<{ column: number; row: number }>;
  readonly token: PresentationToken;
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly progress: number;
}

/** Optional host metrics; callers may source them from any retained UI runtime. */
export interface PresentationDiagnostics {
  readonly liveNodes?: number;
  readonly operations?: number;
  readonly frameGeneration?: number | bigint;
}

export interface PresentationScene {
  readonly palette: typeof PRESENTATION_TOKENS;
  readonly layout: PresentationLayout;
  readonly projection: MapProjection;
  /** One resolved sparse cell per coordinate, already ordered by paint priority. */
  readonly cells: readonly PresentationCell[];
  readonly panels: readonly PresentationPanel[];
  readonly cursor: PresentationCursor;
  readonly effectSignal: PresentationEffectSignal;
}

export interface EchoRingPoint {
  readonly dx: number;
  readonly dy: number;
  readonly glyph: string;
}

// The demo map is 68 cells wide. At 92 columns the receiver rail can appear
// without reducing that visible map width; a lower breakpoint made a terminal
// that grew from 71 to 72 columns suddenly show less of the world.
const WIDE_COLUMNS = 92;
const WIDE_ROWS = 20;
const CELL_ASPECT_RATIO = 2;
const RING_THICKNESS = 0.65;

export const ECHO_DURATIONS = {
  move: 140,
  melee: 180,
  beam: 220,
  pulse: 460,
  pickup: 280,
  damage: 240,
  death: 360,
  win: 850,
} as const satisfies Readonly<Record<EchoEffectKind, number>>;

const EFFECT_PRIORITY: Readonly<Record<EchoEffectKind, number>> = {
  move: 1,
  pickup: 2,
  melee: 3,
  beam: 4,
  pulse: 5,
  death: 6,
  damage: 7,
  win: 8,
};

const ENEMY_GLYPHS: Readonly<Record<EnemyKind, string>> = {
  crawler: "╳",
  brute: "▣",
  watcher: "⊹",
};

const ITEM_GLYPHS: Readonly<Record<ItemKind, string>> = {
  medkit: "+",
  battery: "⌁",
  relic: "∴",
};

/** Compute only cell-unit geometry; no backend layout objects leak in here. */
export function computePresentationLayout(viewport: PresentationViewport): PresentationLayout {
  const columns = dimension(viewport.columns, "columns");
  const rows = dimension(viewport.rows, "rows");
  const mode: PresentationMode = columns >= WIDE_COLUMNS && rows >= WIDE_ROWS ? "wide" : "compact";
  const viewportRect = rect(0, 0, columns, rows);
  const topline = rect(0, 0, columns, 1);
  const commandHeight = rows >= 2 ? 1 : 0;
  const command = rect(0, rows - commandHeight, columns, commandHeight);

  if (mode === "wide") {
    const receiverWidth = clamp(Math.floor(columns * 0.24), 18, 24);
    const dividerColumn = Math.max(2, columns - receiverWidth - 1);
    const field = rect(0, 2, Math.max(1, dividerColumn - 1), Math.max(1, rows - 3));
    const receiver = rect(dividerColumn + 1, 2, receiverWidth, Math.max(1, rows - 3));
    const traceHeight = Math.min(3, receiver.height);
    const trace = rect(
      receiver.column,
      receiver.row + Math.max(0, receiver.height - traceHeight),
      receiver.width,
      traceHeight,
    );
    return { mode, viewport: viewportRect, topline, field, receiver, trace, command };
  }

  // Compact bands degrade without ever escaping the viewport:
  // topline -> optional telemetry -> field -> optional rule/trace -> command.
  // On a tiny terminal, lower-priority bands collapse to zero height instead
  // of manufacturing off-screen one-cell rectangles.
  const telemetryHeight = rows >= 3 ? 1 : 0;
  const contentRow = 1 + telemetryHeight;
  const contentHeight = Math.max(0, command.row - contentRow);
  const traceHeight = contentHeight >= 4 ? 2 : contentHeight >= 2 ? 1 : 0;
  const separatorHeight = traceHeight > 0 && contentHeight - traceHeight >= 2 ? 1 : 0;
  const fieldHeight = contentHeight - traceHeight - separatorHeight;
  const traceRow = contentRow + fieldHeight + separatorHeight;
  const field = rect(0, contentRow, columns, fieldHeight);
  const trace = rect(0, traceRow, columns, traceHeight);
  return { mode, viewport: viewportRect, topline, field, receiver: null, trace, command };
}

/** Convert semantic game events into a deterministic, overlapping choreography. */
export function scheduleEchoTimeline(
  events: readonly GameEvent[],
  startedAt: number,
): EchoTimeline {
  finiteNumber(startedAt, "startedAt");
  const cues: EchoCue[] = [];
  const trace: string[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    const eventOffset = Math.min(index * 18, 108);
    const idPrefix = `echo-${index}`;
    switch (event.type) {
      case "move":
        cues.push(cue(`${idPrefix}-move`, "move", startedAt + eventOffset, event.to, {
          from: event.from,
          to: event.to,
          actor: event.actor,
          actorId: event.actorId,
        }));
        if (event.actor === "player") trace.push(`bearing ${bearing(event.from, event.to)} / tuned`);
        break;
      case "attack":
        if (event.mode === "pulse") break;
        cues.push(cue(
          `${idPrefix}-${event.mode}`,
          event.mode,
          startedAt + eventOffset,
          event.to,
          { from: event.from, to: event.to, actorId: event.attackerId },
        ));
        trace.push(event.mode === "beam" ? "beam / inbound" : "contact / melee");
        break;
      case "pulse":
        cues.push(cue(`${idPrefix}-pulse`, "pulse", startedAt + eventOffset, event.at, {
          radius: event.radius,
        }));
        trace.push(`echo / radius ${event.radius}`);
        break;
      case "pickup":
        cues.push(cue(`${idPrefix}-pickup`, "pickup", startedAt + eventOffset + 36, event.at, {
          item: event.item,
        }));
        trace.push(`${itemLabel(event.item)} / +${event.amount}`);
        break;
      case "damage":
        cues.push(cue(`${idPrefix}-damage`, "damage", startedAt + eventOffset + 45, event.at));
        if (event.targetId === "player") trace.push(`hull −${event.amount} / impact`);
        break;
      case "death":
        cues.push(cue(`${idPrefix}-death`, "death", startedAt + eventOffset + 90, event.at, {
          actor: event.actor,
          actorId: event.actorId,
        }));
        if (event.actor === "enemy") trace.push("contact / extinguished");
        break;
      case "win":
        cues.push(cue(`${idPrefix}-win`, "win", startedAt + eventOffset + 120, event.at));
        trace.push("carrier lock / true");
        break;
      default:
        break;
    }
  }

  let durationMs = 0;
  for (const entry of cues) {
    durationMs = Math.max(durationMs, entry.startsAt + entry.durationMs - startedAt);
  }
  return { startedAt, durationMs, cues, trace: trace.slice(-4) };
}

export function sampleEchoTimeline(timeline: EchoTimeline, now: number): readonly SampledEchoCue[] {
  finiteNumber(now, "now");
  const active: SampledEchoCue[] = [];
  for (const entry of timeline.cues) {
    const elapsedMs = now - entry.startsAt;
    if (elapsedMs < 0 || elapsedMs >= entry.durationMs) continue;
    active.push({ ...entry, elapsedMs, progress: clamp(elapsedMs / entry.durationMs, 0, 1) });
  }
  return active;
}

/**
 * Sample a visually circular ring in terminal cells. Terminal cells are
 * approximately twice as tall as they are wide, so a six-unit ring reaches
 * x=±6 but y=±3.
 */
export function sampleEchoRing(radius: number): readonly EchoRingPoint[] {
  if (!Number.isFinite(radius) || radius < 0) throw new RangeError("radius must be a non-negative finite number");
  if (radius < 0.5) return [{ dx: 0, dy: 0, glyph: "·" }];
  const horizontal = Math.ceil(radius + RING_THICKNESS);
  const vertical = Math.ceil((radius + RING_THICKNESS) / CELL_ASPECT_RATIO);
  const points: EchoRingPoint[] = [];
  for (let dy = -vertical; dy <= vertical; dy += 1) {
    for (let dx = -horizontal; dx <= horizontal; dx += 1) {
      const distance = Math.sqrt(dx * dx + (dy * CELL_ASPECT_RATIO) ** 2);
      if (Math.abs(distance - radius) > RING_THICKNESS) continue;
      points.push({ dx, dy, glyph: ringGlyph(dx, dy) });
    }
  }
  return points;
}

/** Produce a complete backend-neutral presentation sample. */
export function present(
  game: RoguelikeGame,
  timeline: EchoTimeline,
  viewport: PresentationViewport,
  now: number,
  diagnostics: PresentationDiagnostics = {},
): PresentationScene {
  const layout = computePresentationLayout(viewport);
  const projection = projectMap(game, layout.field);
  const activeCues = sampleEchoTimeline(timeline, now);
  const terrain = paintTerrain(game, projection);
  const actors = paintActors(game, projection);
  const actorCoordinates = new Set(actors.map(cellCoordinate));
  const effects = paintEffects(game, projection, activeCues, actorCoordinates);

  const resolved = new Map<string, PresentationCell>();
  for (const cell of terrain) resolved.set(cellCoordinate(cell), cell);
  for (const cell of effects) resolved.set(cellCoordinate(cell), cell);
  for (const cell of actors) resolved.set(cellCoordinate(cell), cell);
  const cells = [...resolved.values()].sort(compareCells);

  const playerCell = worldToScreen(projection, game.player) ?? {
    column: clamp(layout.field.column, 0, layout.viewport.width - 1),
    row: clamp(layout.field.row, 0, layout.viewport.height - 1),
  };
  const effectSignal = selectEffectSignal(activeCues, projection, playerCell);
  const cursor: PresentationCursor = {
    ...playerCell,
    visible: worldToScreen(projection, game.player) !== undefined,
    shape: "underline",
    token: effectSignal.token,
  };

  return {
    palette: PRESENTATION_TOKENS,
    layout,
    projection,
    cells,
    panels: buildPanels(game, timeline, layout, diagnostics),
    cursor,
    effectSignal,
  };
}

function paintTerrain(game: RoguelikeGame, projection: MapProjection): PresentationCell[] {
  const output: PresentationCell[] = [];
  const seed = hashString(String(game.seed));
  for (let screenY = 0; screenY < projection.height; screenY += 1) {
    const y = projection.worldY + screenY;
    for (let screenX = 0; screenX < projection.width; screenX += 1) {
      const x = projection.worldX + screenX;
      if (!game.isExplored(x, y)) continue;
      const visible = game.isVisible(x, y);
      const world = { x, y };
      if (game.tileAt(x, y) === "wall") {
        const distance = aspectDistance(world, game.player);
        output.push(makeCell(
          `terrain-${x}-${y}`,
          projection.column + screenX,
          projection.row + screenY,
          visible ? (distance <= 3.5 ? "▓" : "▒") : "░",
          visible ? "verdigris" : "silt",
          "terrain",
          world,
          false,
          !visible,
        ));
        continue;
      }

      const density = hashCell(seed, x, y);
      const shouldMark = visible ? density % 5 === 0 : density % 13 === 0;
      if (!shouldMark) continue;
      output.push(makeCell(
        `terrain-${x}-${y}`,
        projection.column + screenX,
        projection.row + screenY,
        "·",
        visible ? "verdigris" : "silt",
        "terrain",
        world,
        false,
        !visible,
      ));
    }
  }
  return output;
}

function paintActors(game: RoguelikeGame, projection: MapProjection): PresentationCell[] {
  const output: PresentationCell[] = [];
  if (game.isExplored(game.exit.x, game.exit.y)) {
    pushWorldCell(
      output,
      projection,
      "actor-exit",
      game.exit,
      game.isVisible(game.exit.x, game.exit.y) ? "◆" : "◇",
      game.isVisible(game.exit.x, game.exit.y) ? "bruise" : "silt",
      true,
    );
  }
  for (const item of game.items) {
    if (!game.isVisible(item.x, item.y)) continue;
    pushWorldCell(output, projection, `actor-${item.id}`, item, ITEM_GLYPHS[item.kind], item.kind === "relic" ? "bruise" : "bone", true);
  }
  for (const enemy of game.enemies) {
    if (!game.isVisible(enemy.x, enemy.y)) continue;
    pushWorldCell(output, projection, `actor-${enemy.id}`, enemy, ENEMY_GLYPHS[enemy.kind], "flare", true);
  }
  pushWorldCell(output, projection, "actor-player", game.player, "◉", "verdigris", true);
  return output;
}

function paintEffects(
  game: RoguelikeGame,
  projection: MapProjection,
  samples: readonly SampledEchoCue[],
  actorCoordinates: ReadonlySet<string>,
): PresentationCell[] {
  const effects = new Map<string, PresentationCell>();
  for (const sample of samples) {
    const token = effectToken(sample.kind);
    const candidates = effectPoints(game, sample);
    for (const candidate of candidates) {
      if (!game.inBounds(candidate.point.x, candidate.point.y)) continue;
      if (!game.isExplored(candidate.point.x, candidate.point.y)) continue;
      const screen = worldToScreen(projection, candidate.point);
      if (screen === undefined) continue;
      const coordinate = `${screen.column},${screen.row}`;
      if (actorCoordinates.has(coordinate)) continue;
      effects.set(coordinate, makeCell(
        `effect-${sample.id}-${candidate.point.x}-${candidate.point.y}`,
        screen.column,
        screen.row,
        candidate.glyph,
        token,
        "effect",
        candidate.point,
        sample.progress < 0.72,
        sample.progress > 0.78,
      ));
    }
  }
  return [...effects.values()];
}

function effectPoints(
  game: RoguelikeGame,
  sample: SampledEchoCue,
): readonly { point: Point; glyph: string }[] {
  if (sample.kind === "beam" && sample.from !== undefined && sample.to !== undefined) {
    const line = lineBetween(sample.from, sample.to);
    const glyph = sample.progress < 0.22 || sample.progress > 0.82
      ? "·"
      : sample.from.x === sample.to.x ? "│" : "─";
    return line.map((point) => ({ point, glyph }));
  }
  if (sample.kind === "melee" && sample.from !== undefined && sample.to !== undefined) {
    if (sample.progress < 0.26) {
      return lineBetween(sample.from, sample.to).map((point) => ({ point, glyph: "╳" }));
    }
    return translateRing(sample.to, sample.progress * 2.25, sample.progress);
  }
  if (sample.kind === "move" && sample.actor === "enemy") {
    return [{ point: sample.anchor, glyph: "·" }];
  }

  let radius: number;
  switch (sample.kind) {
    case "move":
      radius = sample.progress * 3;
      break;
    case "pulse":
      radius = sample.progress * Math.max(3, (sample.radius ?? 2) * 2.5);
      break;
    case "pickup":
      radius = (1 - sample.progress) * 3;
      break;
    case "damage":
      radius = (1 - sample.progress) * 5;
      break;
    case "death":
      radius = sample.progress * 4.5;
      break;
    case "win":
      radius = sample.progress * Math.min(24, Math.max(game.width, game.height * CELL_ASPECT_RATIO));
      break;
    default:
      radius = sample.progress * 2;
      break;
  }
  const points = translateRing(sample.anchor, radius, sample.progress);
  if (sample.kind !== "death") return points;
  return points.filter(({ point }) => hashCell(0x51b07, point.x, point.y) % 3 !== 0);
}

function translateRing(
  center: Readonly<Point>,
  radius: number,
  progress: number,
): readonly { point: Point; glyph: string }[] {
  return sampleEchoRing(radius).map((ring) => ({
    point: { x: center.x + ring.dx, y: center.y + ring.dy },
    glyph: progress > 0.76 ? "·" : ring.glyph,
  }));
}

function buildPanels(
  game: RoguelikeGame,
  timeline: EchoTimeline,
  layout: PresentationLayout,
  diagnostics: PresentationDiagnostics,
): readonly PresentationPanel[] {
  const turn = `T+${String(game.turn).padStart(4, "0")}`;
  const title = "SB//07  HYDROPHONE ARRAY";
  const visibleTurn = clip(turn, layout.topline.width);
  const topline: PresentationPanel = {
    id: "topline",
    rect: layout.topline,
    texts: [
      panelText("topline.title", layout.topline.column, layout.topline.row, clip(title, layout.topline.width), "bone", true),
      panelText(
        "topline.turn",
        Math.max(layout.topline.column, layout.topline.column + layout.topline.width - visibleTurn.length),
        layout.topline.row,
        visibleTurn,
        "silt",
      ),
    ],
    rules: [],
  };

  const availableTraceLines = Math.min(2, layout.trace.height);
  const sourceTraceLines = timeline.trace.length > 0 ? timeline.trace : ["quiet water"];
  const traceLines = availableTraceLines > 0
    ? sourceTraceLines.slice(-availableTraceLines)
    : [];
  const traceTexts = traceLines.map((text, index) => panelText(
    `trace.line.${index}`,
    layout.trace.column,
    layout.trace.row + index,
    clip(text, layout.trace.width),
    index === traceLines.length - 1 ? "bone" : "silt",
    false,
    index !== traceLines.length - 1,
  ));
  const tracePanel: PresentationPanel = {
    id: "trace",
    rect: layout.trace,
    texts: traceTexts,
    rules: layout.mode === "compact" &&
      layout.trace.height > 0 &&
      layout.trace.row > layout.field.row + layout.field.height
      ? [{
          id: "trace.rule",
          column: layout.trace.column,
          row: layout.trace.row - 1,
          length: layout.trace.width,
          orientation: "horizontal",
          token: "silt",
        }]
      : [],
  };

  const commandText = layout.mode === "wide"
    ? "WASD tune bearing   SPACE emit   · hold"
    : "WASD bearing  SPACE emit  · hold";
  const commandPanel: PresentationPanel = {
    id: "command",
    rect: layout.command,
    texts: layout.command.height > 0
      ? [panelText(
          "command.help",
          layout.command.column,
          layout.command.row,
          clip(commandText, layout.command.width),
          game.phase === "playing" ? "silt" : "bruise",
          game.phase !== "playing",
        )]
      : [],
    rules: [],
  };

  if (layout.mode === "compact" || layout.receiver === null) {
    const telemetry = `H ${compactValue(game.player.hp, game.player.maxHp)}  E ${compactValue(game.player.energy, game.player.maxEnergy)}  C ${String(game.enemies.length).padStart(2, "0")}`;
    const receiverHeight = layout.viewport.height >= 3 ? 1 : 0;
    const receiverRow = Math.min(1, layout.viewport.height);
    const receiverPanel: PresentationPanel = {
      id: "receiver",
      rect: rect(0, receiverRow, layout.viewport.width, receiverHeight),
      texts: receiverHeight > 0
        ? [panelText("receiver.compact", 0, receiverRow, clip(telemetry, layout.viewport.width), game.player.hp <= 2 ? "flare" : "verdigris", true)]
        : [],
      rules: [],
    };
    return [topline, receiverPanel, tracePanel, commandPanel];
  }

  const receiver = layout.receiver;
  const contentWidth = Math.max(1, receiver.width - 1);
  const counts = enemyCounts(game);
  const hostLink = hostLinkText(diagnostics);
  const carrier = game.phase === "won"
    ? "LOCK / TRUE"
    : game.isExplored(game.exit.x, game.exit.y)
      ? `RANGE ${manhattan(game.player, game.exit)}`
      : "SEARCHING";
  const lines: PanelText[] = [
    panelText("receiver.heading", receiver.column, receiver.row, clip("RETURN CARRIER", contentWidth), "bruise", true),
    panelText("receiver.carrier", receiver.column, receiver.row + 1, clip(carrier, contentWidth), game.phase === "won" ? "bone" : "silt", game.phase === "won"),
    panelText("receiver.hull.label", receiver.column, receiver.row + 3, "HULL", "silt"),
    panelText("receiver.hull.value", receiver.column, receiver.row + 4, meter(game.player.hp, game.player.maxHp, Math.min(8, contentWidth)), game.player.hp <= 2 ? "flare" : "verdigris", true),
    panelText("receiver.energy.label", receiver.column, receiver.row + 6, "CHARGE", "silt"),
    panelText("receiver.energy.value", receiver.column, receiver.row + 7, meter(game.player.energy, game.player.maxEnergy, Math.min(8, contentWidth)), "bruise", true),
    panelText("receiver.contacts", receiver.column, receiver.row + 9, clip(`CONTACTS ${String(game.enemies.length).padStart(2, "0")}`, contentWidth), "bone", true),
    panelText("receiver.crawler", receiver.column, receiver.row + 10, clip(`╳ drift / ${twoDigits(counts.crawler)}`, contentWidth), "flare"),
    panelText("receiver.brute", receiver.column, receiver.row + 11, clip(`▣ mass  / ${twoDigits(counts.brute)}`, contentWidth), "flare"),
    panelText("receiver.watcher", receiver.column, receiver.row + 12, clip(`⊹ gaze  / ${twoDigits(counts.watcher)}`, contentWidth), "flare"),
    panelText(
      "receiver.host-link",
      receiver.column,
      Math.min(receiver.row + 14, layout.trace.row - 1),
      clip(hostLink, contentWidth),
      "verdigris",
      true,
    ),
  ].filter((text) => text.row < receiver.row + receiver.height);
  const receiverPanel: PresentationPanel = {
    id: "receiver",
    rect: receiver,
    texts: lines,
    rules: [{
      id: "receiver.divider",
      column: receiver.column - 1,
      row: receiver.row,
      length: receiver.height,
      orientation: "vertical",
      token: "silt",
    }],
  };
  return [topline, receiverPanel, tracePanel, commandPanel];
}

function selectEffectSignal(
  samples: readonly SampledEchoCue[],
  projection: MapProjection,
  fallback: Readonly<{ column: number; row: number }>,
): PresentationEffectSignal {
  let selected: SampledEchoCue | undefined;
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
    return { kind: "idle", anchor: fallback, token: "verdigris", startedAt: null, durationMs: 0, progress: 1 };
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

function projectMap(game: RoguelikeGame, field: CellRect): MapProjection {
  const width = Math.min(game.width, field.width);
  const height = Math.min(game.height, field.height);
  const worldX = clamp(game.player.x - Math.floor(width / 2), 0, Math.max(0, game.width - width));
  const worldY = clamp(game.player.y - Math.floor(height / 2), 0, Math.max(0, game.height - height));
  return {
    worldX,
    worldY,
    width,
    height,
    column: field.column + Math.floor((field.width - width) / 2),
    row: field.row + Math.floor((field.height - height) / 2),
  };
}

function worldToScreen(
  projection: MapProjection,
  world: Readonly<Point>,
): { column: number; row: number } | undefined {
  const x = world.x - projection.worldX;
  const y = world.y - projection.worldY;
  if (x < 0 || y < 0 || x >= projection.width || y >= projection.height) return undefined;
  return { column: projection.column + x, row: projection.row + y };
}

function pushWorldCell(
  output: PresentationCell[],
  projection: MapProjection,
  id: string,
  world: Readonly<Point>,
  glyph: string,
  token: PresentationToken,
  emphasis = false,
): void {
  const screen = worldToScreen(projection, world);
  if (screen === undefined) return;
  output.push(makeCell(id, screen.column, screen.row, glyph, token, "actor", world, emphasis));
}

function makeCell(
  id: string,
  column: number,
  row: number,
  glyph: string,
  token: PresentationToken,
  layer: PresentationLayer,
  world: Readonly<Point>,
  emphasis = false,
  dim = false,
): PresentationCell {
  return { id, column, row, glyph, token, layer, world: { x: world.x, y: world.y }, emphasis, dim };
}

function cue(
  id: string,
  kind: EchoEffectKind,
  startsAt: number,
  anchor: Readonly<Point>,
  extra: Omit<Partial<EchoCue>, "id" | "kind" | "startsAt" | "durationMs" | "anchor"> = {},
): EchoCue {
  return {
    id,
    kind,
    startsAt,
    durationMs: ECHO_DURATIONS[kind],
    anchor: { x: anchor.x, y: anchor.y },
    ...extra,
  };
}

function effectToken(kind: EchoEffectKind): PresentationToken {
  switch (kind) {
    case "move":
      return "verdigris";
    case "pulse":
    case "win":
      return "bruise";
    case "pickup":
      return "bone";
    default:
      return "flare";
  }
}

function ringGlyph(dx: number, dy: number): string {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy * CELL_ASPECT_RATIO);
  if (horizontal > vertical * 1.7) return "─";
  if (vertical > horizontal * 1.7) return "│";
  return dx * dy >= 0 ? "╲" : "╱";
}

function lineBetween(from: Readonly<Point>, to: Readonly<Point>): Point[] {
  const points: Point[] = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const stepX = from.x < to.x ? 1 : -1;
  const stepY = from.y < to.y ? 1 : -1;
  let error = dx - dy;
  while (true) {
    points.push({ x, y });
    if (x === to.x && y === to.y) break;
    const doubled = error * 2;
    if (doubled > -dy) {
      error -= dy;
      x += stepX;
    }
    if (doubled < dx) {
      error += dx;
      y += stepY;
    }
  }
  return points;
}

function panelText(
  id: string,
  column: number,
  row: number,
  text: string,
  token: PresentationToken,
  emphasis = false,
  dim = false,
): PanelText {
  return { id, column, row, text, token, emphasis, dim };
}

function enemyCounts(game: RoguelikeGame): Record<EnemyKind, number> {
  const result: Record<EnemyKind, number> = { crawler: 0, brute: 0, watcher: 0 };
  for (const enemy of game.enemies) result[enemy.kind] += 1;
  return result;
}

function meter(value: number, maximum: number, width: number): string {
  if (width <= 0) return "";
  const filled = maximum <= 0 ? 0 : clamp(Math.ceil((value / maximum) * width), 0, width);
  return `${"●".repeat(filled)}${"○".repeat(width - filled)}`;
}

function compactValue(value: number, maximum: number): string {
  return `${String(value).padStart(2, "0")}/${String(maximum).padStart(2, "0")}`;
}

function hostLinkText(diagnostics: PresentationDiagnostics): string {
  const values: string[] = [];
  if (diagnostics.liveNodes !== undefined) values.push(`N${diagnostics.liveNodes}`);
  if (diagnostics.operations !== undefined) values.push(`O${diagnostics.operations}`);
  if (diagnostics.frameGeneration !== undefined) values.push(`G${diagnostics.frameGeneration}`);
  return `HOST LINK ${values.length > 0 ? values.join(" ") : "—"}`;
}

function itemLabel(item: ItemKind): string {
  return item === "medkit" ? "repair" : item === "battery" ? "charge" : "relic";
}

function bearing(from: Readonly<Point>, to: Readonly<Point>): string {
  if (to.x > from.x) return "east";
  if (to.x < from.x) return "west";
  if (to.y > from.y) return "south";
  return "north";
}

function aspectDistance(left: Readonly<Point>, right: Readonly<Point>): number {
  const dx = left.x - right.x;
  const dy = (left.y - right.y) * CELL_ASPECT_RATIO;
  return Math.sqrt(dx * dx + dy * dy);
}

function manhattan(left: Readonly<Point>, right: Readonly<Point>): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function cellCoordinate(cell: Readonly<{ column: number; row: number }>): string {
  return `${cell.column},${cell.row}`;
}

function compareCells(left: PresentationCell, right: PresentationCell): number {
  return left.row - right.row || left.column - right.column;
}

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  return [...value].slice(0, width).join("");
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function rect(column: number, row: number, width: number, height: number): CellRect {
  return { column, row, width, height };
}

function dimension(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff) {
    throw new RangeError(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function finiteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashCell(seed: number, x: number, y: number): number {
  let hash = seed ^ Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0x7f4a, 0xc2b2ae35);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}
