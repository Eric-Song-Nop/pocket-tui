// @ts-nocheck -- Bun supplies this test-only module at runtime.
import { describe, expect, test } from "bun:test";

import { createRuleGame, type GameEvent } from "./engine.js";
import { timelineForResult } from "./game-app.js";
import {
  PRINT_DURATIONS,
  RULE_SHIFT_TOKENS,
  computePresentationLayout,
  present,
  samplePrintTimeline,
  schedulePrintTimeline,
  type PrintTimeline,
} from "./presentation.js";

const EMPTY_TIMELINE: PrintTimeline = {
  startedAt: 0,
  durationMs: 0,
  cues: [],
  trace: [],
};

describe("movable-type presentation system", () => {
  test("uses the deliberate six-ink palette with ANSI fallbacks", () => {
    expect(Object.keys(RULE_SHIFT_TOKENS)).toEqual([
      "ink",
      "lead",
      "paper",
      "vermilion",
      "cyan",
      "brass",
    ]);
    expect(RULE_SHIFT_TOKENS.ink).toEqual({
      rgb: { red: 0x13, green: 0x16, blue: 0x1d },
      ansi: 0,
    });
    expect(RULE_SHIFT_TOKENS.paper.ansi).toBe(15);
    expect(RULE_SHIFT_TOKENS.brass.rgb).toEqual({ red: 0xe8, green: 0xb8, blue: 0x4f });
  });

  test("keeps the whole board while opening a proof rail only on wide terminals", () => {
    const game = createRuleGame();
    const snapshot = game.snapshot();
    const compact = present(snapshot, EMPTY_TIMELINE, { columns: 72, rows: 22 }, 0);
    const wide = present(snapshot, EMPTY_TIMELINE, { columns: 110, rows: 30 }, 0);

    expect(compact.layout.mode).toBe("compact");
    expect(compact.layout.proof).toBeNull();
    expect(wide.layout.mode).toBe("wide");
    expect(wide.layout.proof).not.toBeNull();
    expect(wide.projection.width).toBe(snapshot.width);
    expect(compact.projection.width).toBe(snapshot.width);
    expect(wide.projection.rowPitch).toBe(3);
    expect(wide.projection.faceHeight).toBe(3);
    expect(compact.projection.rowPitch).toBeGreaterThan(1);
    expect(wide.layout.board.column + wide.layout.board.width).toBeLessThan(
      wide.layout.proof!.column,
    );
  });

  test("renders words and objects as unmistakable multi-row type blocks", () => {
    const scene = present(
      createRuleGame().snapshot(),
      EMPTY_TIMELINE,
      { columns: 108, rows: 38 },
      0,
    );
    expect(scene.projection).toMatchObject({ pitch: 6, faceWidth: 5, rowPitch: 3, faceHeight: 3 });

    const word = entityTile(scene, "kindle-mote");
    expect(word.map((cell) => cell.row)).toEqual([
      word[0]!.row,
      word[0]!.row + 1,
      word[0]!.row + 2,
    ]);
    expect(word.map((cell) => cell.text)).toEqual(["╭───╮", "MOTE ", "╰───╯"]);
    expect(word.every((cell) => cell.background === "paper")).toBe(true);

    const mote = entityTile(scene, "kindle-player");
    expect(mote.map((cell) => cell.text)).toEqual(["· ╵ ·", "· ✦ ·", "· ╷ ·"]);
    expect(new Set(mote.map((cell) => cell.row)).size).toBe(3);
    expect(mote.every((cell) => cell.text.trim() !== "")).toBe(true);
  });

  test("uses a complete word or an explicit sort mark, never a misleading truncation", () => {
    for (const [level, forbidden] of [
      ["freight", "CRAT"],
      ["bloom", "BLOO"],
    ] as const) {
      const snapshot = createRuleGame(undefined, level).snapshot();
      const wide = present(snapshot, EMPTY_TIMELINE, { columns: 108, rows: 38 }, 0);
      const compact = present(snapshot, EMPTY_TIMELINE, { columns: 62, rows: 24 }, 0);
      for (const scene of [wide, compact]) {
        const textFaces = scene.cells
          .filter((cell) => cell.id.startsWith("entity-") && cell.background !== undefined)
          .map((cell) => cell.text.trim());
        expect(textFaces).not.toContain(forbidden);
      }
      const wideFaces = wide.cells.map((cell) => cell.text.trim());
      expect(wideFaces).toContain(level === "freight" ? "CRATE" : "BLOOM");
    }
  });

  test("protects the complete rule board before spending compact rows on trace copy", () => {
    const snapshot = createRuleGame(undefined, "twin-current").snapshot();
    const activeTextIds = new Set(snapshot.rules.clauses.flatMap((clause) => clause.textEntityIds));
    for (const rows of [12, 14]) {
      const scene = present(snapshot, EMPTY_TIMELINE, { columns: 80, rows }, 0);
      expect(scene.layout.mode).toBe("compact");
      expect(scene.projection.worldY).toBe(0);
      expect(scene.projection.height).toBe(snapshot.height);
      const visibleIds = new Set(scene.cells.map((cell) => cell.id.replace(/^entity-/, "")));
      for (const id of activeTextIds) expect(visibleIds.has(id)).toBe(true);
    }
  });

  test("never emits an off-screen primitive in tiny compact viewports", () => {
    const snapshot = createRuleGame().snapshot();
    for (const columns of [1, 2, 4, 9, 24]) {
      for (let rows = 1; rows <= 9; rows += 1) {
        const scene = present(snapshot, EMPTY_TIMELINE, { columns, rows }, 0);
        expect(scene.layout.mode).toBe("compact");
        for (const candidate of [
          scene.layout.viewport,
          scene.layout.masthead,
          scene.layout.telemetry,
          scene.layout.board,
          scene.layout.trace,
          scene.layout.command,
          ...scene.panels.map((panel) => panel.rect),
        ]) {
          expect(candidate.column).toBeGreaterThanOrEqual(0);
          expect(candidate.row).toBeGreaterThanOrEqual(0);
          expect(candidate.width).toBeGreaterThanOrEqual(0);
          expect(candidate.height).toBeGreaterThanOrEqual(0);
          expect(candidate.column + candidate.width).toBeLessThanOrEqual(columns);
          expect(candidate.row + candidate.height).toBeLessThanOrEqual(rows);
        }
        for (const cell of scene.cells) {
          expect(cell.column).toBeGreaterThanOrEqual(0);
          expect(cell.column + [...cell.text].length).toBeLessThanOrEqual(columns);
          expect(cell.row).toBeGreaterThanOrEqual(0);
          expect(cell.row).toBeLessThan(rows);
        }
        for (const panel of scene.panels) {
          for (const text of panel.texts) {
            expect(text.column).toBeGreaterThanOrEqual(0);
            expect(text.column + [...text.text].length).toBeLessThanOrEqual(columns);
            expect(text.row).toBeGreaterThanOrEqual(0);
            expect(text.row).toBeLessThan(rows);
          }
          for (const rule of panel.rules) {
            if (rule.orientation === "horizontal") {
              expect(rule.column + rule.length).toBeLessThanOrEqual(columns);
              expect(rule.row).toBeLessThan(rows);
            } else {
              expect(rule.column).toBeLessThan(columns);
              expect(rule.row + rule.length).toBeLessThanOrEqual(rows);
            }
          }
        }
        expect(scene.cursor.column).toBeGreaterThanOrEqual(0);
        expect(scene.cursor.column).toBeLessThan(columns);
        expect(scene.cursor.row).toBeGreaterThanOrEqual(0);
        expect(scene.cursor.row).toBeLessThan(rows);
      }
    }
  });
});

describe("rule composition and stacked faces", () => {
  test("inverts every text face in an active sentence and keeps loose type subdued", () => {
    const game = createRuleGame();
    const before = present(game.snapshot(), EMPTY_TIMELINE, { columns: 110, rows: 30 }, 0);
    expect(entityCell(before, "kindle-goal")).toMatchObject({
      token: "brass",
      background: "lead",
    });
    expect(entityCell(before, "kindle-is-win")).toMatchObject({
      token: "brass",
      background: "lead",
    });
    expect(entityCell(before, "kindle-win")).toMatchObject({
      token: "cyan",
      background: "lead",
    });

    const result = game.move("up");
    expect(result.events.some((event) => event.type === "rules-changed")).toBe(true);
    const after = present(result.snapshot, schedulePrintTimeline(result.events, 1_000), { columns: 110, rows: 30 }, 1_120);
    expect(entityCell(after, "kindle-goal")).toMatchObject({ token: "ink", background: "paper" });
    expect(entityCell(after, "kindle-is-win")).toMatchObject({ token: "ink", background: "brass" });
    expect(entityCell(after, "kindle-win")).toMatchObject({ token: "ink", background: "paper" });
    expect(after.cells.some((cell) => cell.layer === "effect" && cell.token === "brass")).toBe(true);
  });

  test("gives overlapping YOU and WIN objects separate visible sub-slots", () => {
    const game = createRuleGame();
    game.move("up");
    for (let index = 0; index < 4; index += 1) game.move("left");
    game.move("down");
    const result = game.move("down");
    expect(result.phase).toBe("won");

    const scene = present(result.snapshot, EMPTY_TIMELINE, { columns: 110, rows: 30 }, 0);
    const stack = scene.cells.filter((cell) =>
      cell.id === "entity-kindle-player" || cell.id === "entity-kindle-target"
    );
    expect(stack).toHaveLength(2);
    expect(stack.every((cell) => cell.text.trim().length > 0)).toBe(true);
    expect(new Set(stack.map((cell) => cell.column)).size).toBe(2);
    expect(stack.map((cell) => cell.text).some((text) => text.includes("◆"))).toBe(true);
    expect(stack.map((cell) => cell.text).some((text) => text.includes("✦"))).toBe(true);
  });

  test("uses an explicit composite proof mark when one-column zoom cannot split a stack", () => {
    const game = createRuleGame();
    game.move("up");
    for (let index = 0; index < 4; index += 1) game.move("left");
    game.move("down");
    const result = game.move("down");
    const scene = present(result.snapshot, EMPTY_TIMELINE, { columns: 8, rows: 10 }, 0);
    const composite = scene.cells.find((cell) => cell.id.includes("kindle-player+kindle-target"));
    expect(composite).toMatchObject({ text: "◈", token: "brass", emphasis: true });
  });
});

describe("print choreography and retained telemetry", () => {
  test("animates a portable move trail across consecutive 30fps frames", () => {
    const snapshot = createRuleGame().snapshot();
    const timeline = schedulePrintTimeline([{
      type: "move",
      entityId: "kindle-player",
      from: { x: 8, y: 3 },
      to: { x: 7, y: 3 },
    }], 0);
    const cue = timeline.cues[0]!;
    const frames = [0, 1_000 / 30, 2_000 / 30].map((now) =>
      effectCells(present(snapshot, timeline, { columns: 108, rows: 38 }, now), cue.id)
    );
    expect(frames.every((frame) => frame.length >= 4)).toBe(true);
    expect(new Set(frames.map(effectSignature)).size).toBe(3);
    expect(new Set(frames.flatMap((frame) => frame.map((cell) => `${cell.column},${cell.row}`))).size).toBeGreaterThan(2);
    expect(new Set(frames.flatMap((frame) => frame.map((cell) => cell.text))).size).toBeGreaterThan(2);
    expect(new Set(frames.flatMap((frame) => frame.map((cell) => cell.token))).size).toBeGreaterThan(1);
  });

  test("gives all six effects deterministic changing CanvasFrame particles", () => {
    const base = createRuleGame();
    const snapshot = base.snapshot();
    const changed = base.move("up");
    const ruleEvent = changed.events.find((event) => event.type === "rules-changed")!;
    const cases: readonly {
      readonly kind: string;
      readonly event: GameEvent;
      readonly snapshot: typeof snapshot;
      readonly token: string;
      readonly minimum: number;
    }[] = [
      {
        kind: "move",
        event: { type: "move", entityId: "kindle-player", from: { x: 8, y: 3 }, to: { x: 7, y: 3 } },
        snapshot,
        token: "cyan",
        minimum: 4,
      },
      {
        kind: "push",
        event: { type: "push", entityId: "kindle-win", from: { x: 8, y: 2 }, to: { x: 8, y: 1 } },
        snapshot,
        token: "brass",
        minimum: 6,
      },
      {
        kind: "blocked",
        event: {
          type: "blocked",
          entityIds: ["kindle-player"],
          from: [{ x: 8, y: 3 }],
          cell: { x: 9, y: 3 },
          direction: "right",
          reason: "stop",
        },
        snapshot,
        token: "vermilion",
        minimum: 3,
      },
      { kind: "calibrate", event: ruleEvent, snapshot: changed.snapshot, token: "brass", minimum: 6 },
      {
        kind: "transform",
        event: { type: "transform", entityId: "kindle-player", from: "MOTE", to: "BLOOM", at: { x: 8, y: 3 } },
        snapshot,
        token: "cyan",
        minimum: 6,
      },
      {
        kind: "win",
        event: { type: "win", entityIds: ["kindle-player", "kindle-target"], at: { x: 4, y: 4 }, turn: 7 },
        snapshot,
        token: "brass",
        minimum: 8,
      },
    ];

    const counts = new Map<string, number>();
    for (const candidate of cases) {
      const timeline = schedulePrintTimeline([candidate.event], 500);
      const cue = timeline.cues.find((entry) => entry.kind === candidate.kind)!;
      const frames = [0.12, 0.42, 0.74].map((progress) => effectCells(
        present(
          candidate.snapshot,
          timeline,
          { columns: 108, rows: 38 },
          cue.startsAt + cue.durationMs * progress,
        ),
        cue.id,
      ));
      expect(frames.every((frame) => frame.length >= candidate.minimum)).toBe(true);
      expect(frames.every((frame) => frame.some((cell) => cell.token === candidate.token))).toBe(true);
      expect(new Set(frames.map(effectSignature)).size).toBe(3);
      counts.set(candidate.kind, Math.max(...frames.map((frame) => frame.length)));
    }
    expect(counts.get("calibrate")!).toBeGreaterThan(counts.get("move")!);
    expect(counts.get("transform")!).toBeGreaterThan(counts.get("move")!);
    expect(counts.get("win")!).toBeGreaterThan(counts.get("move")!);
  });

  test("anchors blocked and calibration cues to actual engine cells", () => {
    const game = createRuleGame();
    const first = game.move("up");
    const blocked: GameEvent = {
      type: "blocked",
      entityIds: ["kindle-player"],
      from: [{ x: 8, y: 2 }],
      cell: { x: 9, y: 2 },
      direction: "right",
      reason: "stop",
    };
    const ruleChange = first.events.find((event) => event.type === "rules-changed");
    expect(ruleChange).toBeDefined();
    const timeline = schedulePrintTimeline([blocked, ruleChange!], 5_000);
    expect(timeline.cues.map((cue) => cue.kind)).toEqual(["blocked", "calibrate"]);
    expect(timeline.cues[0]?.anchor).toEqual({ x: 9, y: 2 });
    expect(timeline.cues[1]?.ruleRows).toEqual([1]);
    expect(timeline.cues[1]?.ruleCells).toEqual([
      { x: 6, y: 1 },
      { x: 7, y: 1 },
      { x: 8, y: 1 },
    ]);
    expect(timeline.cues[1]?.affectedNouns).toEqual(["GOAL"]);
    expect(timeline.cues[1]?.anchor).not.toEqual({ x: 0, y: 0 });
    expect(timeline.cues[1]?.durationMs).toBe(PRINT_DURATIONS.calibrate);
  });

  test("locks changed type cells in sequence and flashes every affected object", () => {
    const game = createRuleGame();
    const result = game.move("up");
    const timeline = schedulePrintTimeline(result.events, 1_000);
    const calibration = timeline.cues.find((cue) => cue.kind === "calibrate");
    expect(calibration).toBeDefined();

    const earlyNow = calibration!.startsAt + calibration!.durationMs * 0.2;
    const early = present(result.snapshot, timeline, { columns: 108, rows: 38 }, earlyNow);
    expect(early.cells.some((cell) => cell.id === `effect-${calibration!.id}-rule-0`)).toBe(true);
    expect(early.cells.some((cell) => cell.id === `effect-${calibration!.id}-rule-1`)).toBe(false);
    expect(early.cells.some((cell) => cell.id === `effect-${calibration!.id}-rule-2`)).toBe(false);
    expect(early.cells.some((cell) => cell.id === `effect-${calibration!.id}-object-kindle-target`)).toBe(true);
    expect(entityCell(early, "kindle-target")).toMatchObject({
      token: "ink",
      background: "brass",
      emphasis: true,
    });

    const lateNow = calibration!.startsAt + calibration!.durationMs * 0.65;
    const late = present(result.snapshot, timeline, { columns: 108, rows: 38 }, lateNow);
    expect(late.cells.filter((cell) => /^effect-.*-rule-\d+$/.test(cell.id))).toHaveLength(3);
  });

  test("calibrates removed-only rules and an undo-restored proof", () => {
    const game = createRuleGame(undefined, "breakwater");
    game.move("up");
    const broken = game.move("up");
    const brokenRule = broken.events.find((event) => event.type === "rules-changed");
    expect(brokenRule?.added).toEqual([]);
    expect(brokenRule?.removed.length).toBe(1);
    const lifted = schedulePrintTimeline(broken.events, 400);
    expect(lifted.cues.some((cue) => cue.kind === "calibrate")).toBe(true);
    expect(lifted.cues.find((cue) => cue.kind === "calibrate")?.affectedNouns).toEqual(["WALL"]);
    expect(lifted.trace.some((line) => line.includes("rule lifted"))).toBe(true);

    const restored = game.undo();
    const rewind = timelineForResult(restored, 800);
    expect(rewind.cues.map((cue) => cue.kind)).toEqual(["calibrate"]);
    expect(rewind.durationMs).toBeGreaterThanOrEqual(PRINT_DURATIONS.calibrate);
    expect(rewind.trace).toEqual(["carriage returned / proof restored"]);
    expect(rewind.cues[0]?.transition).toBe("undo");
  });

  test("samples transform and win cues deterministically within their bounds", () => {
    const events: GameEvent[] = [
      { type: "transform", entityId: "mote", from: "MOTE", to: "BLOOM", at: { x: 4, y: 3 } },
      { type: "win", entityIds: ["mote", "goal"], at: { x: 7, y: 3 }, turn: 9 },
    ];
    const timeline = schedulePrintTimeline(events, 200);
    expect(timeline.cues.map((cue) => cue.kind)).toEqual(["transform", "win"]);
    expect(samplePrintTimeline(timeline, 199)).toEqual([]);
    const active = samplePrintTimeline(timeline, 350);
    expect(active.map((cue) => cue.kind)).toEqual(["transform", "win"]);
    expect(active.every((cue) => cue.progress >= 0 && cue.progress < 1)).toBe(true);
    expect(samplePrintTimeline(timeline, 200 + timeline.durationMs)).toEqual([]);
    expect(schedulePrintTimeline(events, 200)).toEqual(timeline);
  });

  test("retains semantic direction when a higher-priority overlapping cue delays publication", () => {
    const snapshot = createRuleGame().snapshot();
    const timeline: PrintTimeline = {
      startedAt: 0,
      durationMs: 220,
      trace: [],
      cues: [
        {
          id: "earlier-push",
          kind: "push",
          startsAt: 0,
          durationMs: 180,
          anchor: { x: 2, y: 2 },
          from: { x: 1, y: 2 },
          to: { x: 2, y: 2 },
        },
        {
          id: "delayed-move",
          kind: "move",
          startsAt: 100,
          durationMs: 120,
          anchor: { x: 3, y: 2 },
          from: { x: 2, y: 2 },
          to: { x: 3, y: 2 },
        },
      ],
    };

    expect(present(snapshot, timeline, { columns: 108, rows: 38 }, 120).effectSignal)
      .toMatchObject({ kind: "push", direction: "right" });
    expect(present(snapshot, timeline, { columns: 108, rows: 38 }, 190).effectSignal)
      .toMatchObject({ kind: "move", direction: "right" });
  });

  test("binds lifecycle semantics to the selected cue instead of stale trace copy", () => {
    const snapshot = createRuleGame().snapshot();
    const timeline: PrintTimeline = {
      startedAt: 0,
      durationMs: 680,
      trace: ["carriage returned / proof restored", "new rule locked"],
      cues: [
        {
          id: "old-undo",
          kind: "calibrate",
          startsAt: 0,
          durationMs: 680,
          anchor: { x: 1, y: 1 },
          transition: "undo",
        },
        {
          id: "new-rule",
          kind: "calibrate",
          startsAt: 100,
          durationMs: 540,
          anchor: { x: 3, y: 2 },
        },
      ],
    };

    expect(present(snapshot, timeline, { columns: 108, rows: 38 }, 200).effectSignal)
      .toMatchObject({ kind: "calibrate", startedAt: 100, transition: undefined });
  });

  test("publishes transform before the remaining calibration tail on the effect bus", () => {
    const game = createRuleGame(undefined, "bloom");
    const result = game.move("up");
    const timeline = schedulePrintTimeline(result.events, 0);
    expect(present(result.snapshot, timeline, { columns: 108, rows: 38 }, 100).effectSignal.kind).toBe(
      "transform",
    );
    expect(present(result.snapshot, timeline, { columns: 108, rows: 38 }, 400).effectSignal.kind).toBe(
      "calibrate",
    );
  });

  test("keeps scene IDs and the visible PocketJS host proof deterministic", () => {
    const snapshot = createRuleGame().snapshot();
    const diagnostics = { liveNodes: 1_922, operations: 41, frameGeneration: 7n };
    const first = present(snapshot, EMPTY_TIMELINE, { columns: 110, rows: 30 }, 0, diagnostics);
    const second = present(snapshot, EMPTY_TIMELINE, { columns: 110, rows: 30 }, 0, diagnostics);
    expect(first).toEqual(second);
    const proof = first.panels.find((panel) => panel.id === "proof");
    expect(proof?.texts.find((text) => text.id === "proof.host")?.text).toBe(
      "HOST N1922 O41 F7",
    );
    expect(proof?.texts.some((text) => text.text.includes("MOTE IS YOU"))).toBe(true);
    expect(first.cursor.shape).toBe("underline");
  });
});

function entityCell(scene: ReturnType<typeof present>, entityId: string) {
  return scene.cells.find((cell) => cell.id === `entity-${entityId}`);
}

function entityTile(scene: ReturnType<typeof present>, entityId: string) {
  return scene.cells
    .filter((cell) => cell.id === `entity-${entityId}` || cell.id.startsWith(`entity-${entityId}:face-`))
    .sort((left, right) => left.row - right.row);
}

function effectCells(scene: ReturnType<typeof present>, cueId: string) {
  return scene.cells.filter((cell) => cell.layer === "effect" && cell.id.startsWith(`effect-${cueId}-`));
}

function effectSignature(cells: ReturnType<typeof effectCells>): string {
  return cells
    .map((cell) => `${cell.id}@${cell.column},${cell.row}:${cell.text}:${cell.token}`)
    .sort()
    .join("|");
}
