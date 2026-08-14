// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import type {
  CanvasFrame,
  CursorPacketOptions,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";
import {
  createPocketTuiHost,
  mountPocketTui,
  POCKET_BUTTON,
  type PocketTuiSession,
  type PocketTuiSurface,
} from "@pocket-tui/pocketjs";

import type { GameSnapshot } from "./engine.js";
import {
  RULE_SHIFT_FPS,
  RuleShift,
  ruleShiftRunStyle,
  type RuleShiftContext,
} from "./game-app.js";
import {
  GHOSTTY_DIRECTION_CODES,
  GHOSTTY_EFFECT_FLAGS,
  deriveGhosttyEffectSemantics,
  encodeGhosttyEffectChannels,
  ghosttyEffectKey,
  isImmediateQuit,
  ruleShiftInputMap,
} from "./main.js";
import type { PresentationScene, PresentationViewport } from "./presentation.js";

class DemoSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  readonly inputs: TuiInputEvent[] = [];
  size: TuiViewportSize = { columns: 108, rows: 38 };
  started = 0;
  flushed = 0;
  closed = 0;

  viewportSize(): TuiViewportSize {
    return this.size;
  }

  present(frame: CanvasFrame): void {
    this.frames.push(frame);
  }

  setCursor(_options: CursorPacketOptions): void {}

  pollInput(): TuiInputEvent[] {
    return this.inputs.splice(0);
  }

  start(): void {
    this.started += 1;
  }

  flush(): void {
    this.flushed += 1;
  }

  close(): void {
    this.closed += 1;
  }
}

describe("RULE//SHIFT PocketJS backend integration", () => {
  test("explicitly clears a pooled slot background when the next run has none", () => {
    const run = {
      key: "pooled-slot",
      text: "RULE",
      column: 4,
      row: 3,
      token: "paper" as const,
      background: "brass" as const,
      emphasis: false,
      dim: false,
      zIndex: 2,
    };

    expect(ruleShiftRunStyle(run).bgColor).not.toBe(0);
    const cleared = ruleShiftRunStyle({ ...run, background: undefined });
    expect(Object.hasOwn(cleared, "bgColor")).toBe(true);
    expect(cleared.bgColor).toBe(0);
  });

  test("mounts, updates, resizes, and tears down the retained application", async () => {
    const surface = new DemoSurface();
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    let viewport: PresentationViewport = surface.size;
    let session: PocketTuiSession | undefined;
    let latestScene: PresentationScene | undefined;
    let latestSnapshot: GameSnapshot | undefined;
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
        latestScene = scene;
        latestSnapshot = snapshot;
      },
      requestClose: () => session?.requestClose(),
    };

    try {
      session = await mountPocketTui(() => RuleShift({ context }), {
        host,
        fps: RULE_SHIFT_FPS,
        directionPulsePolicy: "queue",
        mapInput: ruleShiftInputMap,
        onInput: (event) => {
          if (event.kind !== "resize") return;
          viewport = { columns: event.columns, rows: event.rows };
          return true;
        },
      });
      await Promise.resolve();
      await session.step();

      expect(surface.started).toBe(1);
      expect(latestSnapshot?.levelId).toBe("kindle");
      expect(latestScene?.layout.mode).toBe("wide");
      expect(host.diagnostics.liveNodes).toBeGreaterThan(100);
      expect(host.diagnostics.liveNodes).toBeLessThan(1_000);
      expect(frameText(host.frame)).toContain("RULE//SHIFT");
      expect(frameText(host.frame)).toContain("01 / KINDLE");
      expect(frameText(host.frame)).toContain("POCKETJS HOST");
      expect(frameText(host.frame)).not.toContain("HOST DROP");

      const liveNodes = host.diagnostics.liveNodes;
      const mastheadNode = textNodeId(host.snapshot(), "RULE//SHIFT  MOVABLE TYPE PROOF");
      const layoutBaseline = host.diagnostics;
      const retainedLayoutNodes = host.snapshot().filter((node) => node.rect !== undefined).length;
      expect(mastheadNode).toBeDefined();

      // A terminal may deliver repeated movement in one text record. Queue
      // policy preserves all four discrete turns, including Pocket's release
      // frame between equal button edges, without remounting retained nodes.
      surface.inputs.push({ kind: "text", text: "aaaa" });
      const batchedButtons: number[] = [];
      for (let frame = 0; frame < 8; frame += 1) {
        batchedButtons.push((await session.step()).buttons);
      }
      expect(batchedButtons).toEqual([
        POCKET_BUTTON.LEFT,
        0,
        POCKET_BUTTON.LEFT,
        0,
        POCKET_BUTTON.LEFT,
        0,
        POCKET_BUTTON.LEFT,
        0,
      ]);
      await stepMany(session, 3);
      expect(latestSnapshot?.turn).toBe(4);
      expect(host.diagnostics.liveNodes).toBe(liveNodes);
      expect(textNodeId(host.snapshot(), "RULE//SHIFT  MOVABLE TYPE PROOF")).toBe(mastheadNode);

      // A mixed direction packet is the regression case for the component's
      // animation lock. The session emits every edge in order and RuleShift's
      // bounded FIFO must retain all four turns until their print cues unlock.
      surface.inputs.push({ kind: "text", text: "wasd" });
      const mixedButtons: number[] = [];
      for (let frame = 0; frame < 8; frame += 1) {
        mixedButtons.push((await session.step()).buttons);
      }
      expect(mixedButtons).toEqual([
        POCKET_BUTTON.UP,
        0,
        POCKET_BUTTON.LEFT,
        0,
        POCKET_BUTTON.DOWN,
        0,
        POCKET_BUTTON.RIGHT,
        0,
      ]);
      await stepMany(session, 12);
      expect(latestSnapshot?.turn).toBe(8);
      expect(host.diagnostics.liveNodes).toBe(liveNodes);
      expect(textNodeId(host.snapshot(), "RULE//SHIFT  MOVABLE TYPE PROOF")).toBe(mastheadNode);

      // N is a real Pocket button edge. Walk the complete campaign at the
      // wide reference size: every board must fit the same bounded pools and
      // update the mounted Solid snapshot without remounting retained nodes.
      for (const [levelId, title] of [
        ["breakwater", "02 / BREAKWATER"],
        ["freight", "03 / FREIGHT"],
        ["twin-current", "04 / TWIN CURRENT"],
        ["bloom", "05 / BLOOM"],
      ] as const) {
        surface.inputs.push({ kind: "text", text: "n" });
        await stepMany(session, 4);
        expect(latestSnapshot?.levelId).toBe(levelId);
        expect(frameText(host.frame)).toContain(title);
        expect(frameText(host.frame)).not.toContain("HOST DROP");
        expect(host.diagnostics.liveNodes).toBe(liveNodes);
        expect(textNodeId(host.snapshot(), "RULE//SHIFT  MOVABLE TYPE PROOF")).toBe(mastheadNode);
      }

      const activeLayout = host.diagnostics;
      const localizedFrames =
        activeLayout.localizedLayoutFrames - layoutBaseline.localizedLayoutFrames;
      const localizedNodes = activeLayout.layoutNodes - layoutBaseline.layoutNodes;
      expect(activeLayout.fullLayoutFrames).toBe(layoutBaseline.fullLayoutFrames);
      expect(localizedFrames).toBeGreaterThan(0);
      expect(localizedNodes / (localizedFrames * retainedLayoutNodes)).toBeLessThan(0.25);

      // Resize changes the layout projection, not the engine or level state.
      const fullLayoutsBeforeResize = host.diagnostics.fullLayoutFrames;
      surface.size = { columns: 72, rows: 24 };
      surface.inputs.push({ kind: "resize", columns: 72, rows: 24 });
      await stepMany(session, 3);
      expect(latestScene?.layout.mode).toBe("compact");
      expect(latestSnapshot?.levelId).toBe("bloom");
      expect(host.frame.width).toBe(72);
      expect(host.frame.height).toBe(24);
      expect(host.diagnostics.liveNodes).toBe(liveNodes);
      expect(textNodeId(host.snapshot(), "RULE//SHIFT  MOVABLE TYPE PROOF")).toBe(mastheadNode);
      expect(host.diagnostics.fullLayoutFrames).toBe(fullLayoutsBeforeResize + 1);
    } finally {
      await session?.close();
    }

    expect(surface.closed).toBe(1);
  });

  test("maps the complete control vocabulary with bounded batches and immediate quit", () => {
    expect(ruleShiftInputMap({ kind: "text", text: "wazrnp" })).toEqual([
      POCKET_BUTTON.UP,
      POCKET_BUTTON.LEFT,
      POCKET_BUTTON.SQUARE,
      POCKET_BUTTON.START,
      POCKET_BUTTON.RTRIGGER,
      POCKET_BUTTON.LTRIGGER,
    ]);
    expect(ruleShiftInputMap({ kind: "text", text: "wwwwwwwwwwz" })).toEqual([
      POCKET_BUTTON.UP,
      POCKET_BUTTON.UP,
      POCKET_BUTTON.UP,
      POCKET_BUTTON.UP,
      POCKET_BUTTON.UP,
      POCKET_BUTTON.UP,
      POCKET_BUTTON.UP,
      POCKET_BUTTON.SQUARE,
    ]);
    expect(ruleShiftInputMap({ kind: "key", key: "escape" })).toBe(POCKET_BUTTON.SELECT);
    expect(isImmediateQuit({ kind: "text", text: "ddddq" })).toBe(true);
    expect(isImmediateQuit({ kind: "key", key: "c", ctrl: true })).toBe(true);
  });

  test("encodes direction, phase, anchor, rules, campaign state, and undo on the typed Ghostty bus", () => {
    const snapshot = effectSnapshot({
      levelId: "freight",
      levelIndex: 2,
      levelCount: 5,
      turn: 6,
      historyDepth: 3,
      phase: "won",
      ruleCount: 4,
    });
    const scene = effectScene({
      kind: "blocked",
      progress: 0.25,
      anchor: { column: 18, row: 13 },
      cursor: { column: 20, row: 10 },
      direction: "down",
      transition: "undo",
      trace: "carriage returned / proof restored",
    });
    const previous = {
      cursor: { column: 20, row: 10 },
    };
    const semantics = deriveGhosttyEffectSemantics(scene.effectSignal, scene, previous);

    expect(semantics).toEqual({
      direction: "down",
      undo: true,
      stageChange: false,
      restart: false,
      initialLoad: false,
    });
    expect(encodeGhosttyEffectChannels(scene.effectSignal, scene, snapshot, semantics, true)).toEqual([
      [
        3,
        203,
        GHOSTTY_EFFECT_FLAGS.won | GHOSTTY_EFFECT_FLAGS.undo | GHOSTTY_EFFECT_FLAGS.yDown,
      ],
      [64, 150, 24],
      [126, 131, GHOSTTY_DIRECTION_CODES.down * 32 + 16],
    ]);
    expect(encodeGhosttyEffectChannels(scene.effectSignal, scene, snapshot, semantics, false)[0]?.[2])
      .toBe(GHOSTTY_EFFECT_FLAGS.won | GHOSTTY_EFFECT_FLAGS.undo);

    const hiddenScene = effectScene({
      kind: "blocked",
      progress: 0.25,
      anchor: { column: 7, row: 5 },
      cursor: { column: 39, row: 23 },
      cursorVisible: false,
      direction: "left",
      trace: "cropped anchor",
    });
    const hiddenChannels = encodeGhosttyEffectChannels(
      hiddenScene.effectSignal,
      hiddenScene,
      snapshot,
      deriveGhosttyEffectSemantics(hiddenScene.effectSignal, hiddenScene),
      true,
    );
    expect(hiddenChannels[0]?.[2] & GHOSTTY_EFFECT_FLAGS.absoluteAnchor)
      .toBe(GHOSTTY_EFFECT_FLAGS.absoluteAnchor);
    expect(hiddenChannels[2]?.slice(0, 2)).toEqual([7, 5]);

    const staleTrace = effectScene({
      kind: "calibrate",
      progress: 0.1,
      anchor: { column: 20, row: 10 },
      cursor: { column: 20, row: 10 },
      trace: "carriage returned / proof restored",
    });
    expect(deriveGhosttyEffectSemantics(staleTrace.effectSignal, staleTrace, previous))
      .toMatchObject({ undo: false, restart: false, stageChange: false, initialLoad: false });

    const loadScene = effectScene({
      kind: "calibrate",
      progress: 0,
      anchor: { column: 42, row: 17 },
      cursor: { column: 42, row: 17 },
      transition: "stage-change",
      trace: "forme seated / pins aligned",
    });
    expect(deriveGhosttyEffectSemantics(loadScene.effectSignal, loadScene, previous))
      .toMatchObject({ stageChange: true, initialLoad: false, direction: "none" });
    expect(deriveGhosttyEffectSemantics(
      { ...loadScene.effectSignal, transition: "initial-load" },
      loadScene,
    ))
      .toMatchObject({ stageChange: false, initialLoad: true, direction: "none" });
    expect(ghosttyEffectKey(loadScene.effectSignal)).not.toBe(ghosttyEffectKey({
      ...loadScene.effectSignal,
      transition: "restart",
    }));
  });

  test("renders movement and rule transformation as multi-frame portable particles", async () => {
    const movement = await recordAnimation("freight", "d", 7);
    const beforePlayer = movement.before.cells.find((cell) => cell.id === "entity-freight-player");
    const afterPlayer = movement.after.cells.find((cell) => cell.id === "entity-freight-player");
    expect(beforePlayer).toBeDefined();
    expect(afterPlayer).toBeDefined();
    expect({ column: afterPlayer?.column, row: afterPlayer?.row }).not.toEqual({
      column: beforePlayer?.column,
      row: beforePlayer?.row,
    });

    // These are frames returned by the real PocketJS host, not direct
    // present() samples. Movement must read as motion without Ghostty shaders.
    expect(hasAnimatedTriple(movement.frames)).toBe(true);
    expect(distinct(movement.frames.flatMap((frame) => frame.effects.positions))).toBeGreaterThan(1);
    expect(distinct(movement.frames.flatMap((frame) => frame.effects.glyphs))).toBeGreaterThan(1);
    expect(distinct(movement.frames.flatMap((frame) => frame.effects.colors))).toBeGreaterThan(1);
    expect(distinct(movement.frames.map((frame) => frame.effects.runCount))).toBeGreaterThan(1);
    const movementPeak = Math.max(...movement.frames.map((frame) => frame.effects.cellCount));
    expect(movementPeak).toBeGreaterThanOrEqual(2);
    expect(movement.retainedStable).toBe(true);

    // `a` queues behind `w`; once it executes, the first turn's larger
    // transform/calibration particle set must still be present instead of
    // being replaced by the second move timeline.
    const transformation = await recordAnimation("bloom", "wa", 22);
    expect(transformation.snapshot.turn).toBe(2);
    expect(transformation.snapshot.entities.find((entity) => entity.id === "bloom-player"))
      .toMatchObject({ kind: "object", noun: "BLOOM" });
    expect(transformation.frames.some((frame) =>
      frame.turn >= 2 &&
      (frame.effectKind === "transform" || frame.effectKind === "calibrate") &&
      frame.effects.cellCount > 0
    )).toBe(true);
    expect(Math.max(...transformation.frames.map((frame) => frame.effects.cellCount)))
      .toBeGreaterThan(movementPeak);
    expect(Math.max(...transformation.frames.map((frame) => frame.effects.runCount)))
      .toBeGreaterThan(1);
    expect(distinct(transformation.frames.map((frame) => frame.effects.signature)))
      .toBeGreaterThan(4);
    expect(transformation.retainedStable).toBe(true);
  });
});

async function recordAnimation(startLevel: string, input: string, frameCount: number) {
  const surface = new DemoSurface();
  const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
  let session: PocketTuiSession | undefined;
  let latestScene: PresentationScene | undefined;
  let latestSnapshot: GameSnapshot | undefined;
  const context: RuleShiftContext = {
    viewport: () => surface.size,
    diagnostics: () => ({
      liveNodes: host.diagnostics.liveNodes,
      operations: host.diagnostics.mutations,
      frameGeneration: host.diagnostics.renderedFrames,
    }),
    present: (scene, snapshot) => {
      latestScene = scene;
      latestSnapshot = snapshot;
    },
    requestClose: () => session?.requestClose(),
  };

  session = await mountPocketTui(() => RuleShift({ context, startLevel }), {
    host,
    fps: RULE_SHIFT_FPS,
    directionPulsePolicy: "queue",
    mapInput: ruleShiftInputMap,
  });
  try {
    await Promise.resolve();
    await session.step();
    await stepMany(session, 24);
    if (latestScene === undefined || latestSnapshot === undefined) {
      throw new Error("RULE//SHIFT did not publish its initial retained scene");
    }
    expect(latestScene.effectSignal.kind).toBe("idle");
    const before = latestScene;
    const nodeIds = host.snapshot().map((node) => node.id).join(",");
    const liveNodes = host.diagnostics.liveNodes;
    let retainedStable = true;
    const frames = [];
    surface.inputs.push({ kind: "text", text: input });
    for (let index = 0; index < frameCount; index += 1) {
      const { frame } = await session.step();
      if (latestScene === undefined || latestSnapshot === undefined) break;
      frames.push({
        effects: portableEffectSample(frame, latestScene),
        effectKind: latestScene.effectSignal.kind,
        turn: latestSnapshot.turn,
      });
      retainedStable &&= host.diagnostics.liveNodes === liveNodes &&
        host.snapshot().map((node) => node.id).join(",") === nodeIds;
    }
    return {
      before,
      after: latestScene,
      snapshot: latestSnapshot,
      frames,
      retainedStable,
    };
  } finally {
    await session.close();
  }
}

function portableEffectSample(frame: CanvasFrame, scene: PresentationScene) {
  const raster = new Map<string, { glyph: string; color: string; run: number }>();
  frame.runs.forEach((run, runIndex) => {
    [...run.text].forEach((glyph, offset) => raster.set(`${run.row}:${run.column + offset}`, {
      glyph,
      color: JSON.stringify(run.style?.foreground ?? null),
      run: runIndex,
    }));
  });
  const visible = new Map<string, { position: string; glyph: string; color: string; run: number }>();
  for (const cell of scene.cells) {
    if (cell.layer !== "effect") continue;
    for (const [offset, expectedGlyph] of [...cell.text].entries()) {
      const position = `${cell.row}:${cell.column + offset}`;
      const rendered = raster.get(position);
      if (rendered?.glyph === expectedGlyph) visible.set(position, { position, ...rendered });
    }
  }
  const cells = [...visible.values()].sort((left, right) => left.position.localeCompare(right.position));
  return {
    signature: cells.map((cell) => `${cell.position}:${cell.glyph}:${cell.color}`).join("|"),
    cellCount: cells.length,
    runCount: distinct(cells.map((cell) => cell.run)),
    positions: cells.map((cell) => cell.position),
    glyphs: cells.map((cell) => cell.glyph),
    colors: cells.map((cell) => cell.color),
  };
}

function hasAnimatedTriple(samples: readonly { effects: { signature: string; cellCount: number } }[]): boolean {
  for (let index = 0; index + 2 < samples.length; index += 1) {
    const window = samples.slice(index, index + 3);
    if (window.every((sample) => sample.effects.cellCount > 0) &&
      distinct(window.map((sample) => sample.effects.signature)) === 3) return true;
  }
  return false;
}

function distinct(values: readonly unknown[]): number {
  return new Set(values).size;
}

async function stepMany(session: PocketTuiSession, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await session.step();
}

function frameText(frame: CanvasFrame): string {
  return frame.runs.map((run) => run.text).join("\n");
}

function textNodeId(
  nodes: readonly { readonly id: number; readonly text: string }[],
  text: string,
): number | undefined {
  return nodes.find((node) => node.text === text)?.id;
}

function effectSnapshot(options: {
  levelId: string;
  levelIndex: number;
  levelCount: number;
  turn: number;
  historyDepth: number;
  phase: "playing" | "won";
  ruleCount: number;
}): GameSnapshot {
  return {
    ...options,
    title: options.levelId,
    hint: "",
    width: 8,
    height: 8,
    entities: [],
    rules: {
      clauses: Array.from({ length: options.ruleCount }, (_, index) => ({ key: `rule-${index}` })),
      properties: [],
      transformations: [],
    },
  } as GameSnapshot;
}

function effectScene(options: {
  kind: PresentationScene["effectSignal"]["kind"];
  progress: number;
  anchor: { column: number; row: number };
  cursor: { column: number; row: number };
  cursorVisible?: boolean;
  direction?: "up" | "right" | "down" | "left";
  transition?: "initial-load" | "undo" | "restart" | "stage-change";
  trace: string;
}): PresentationScene {
  return {
    layout: { viewport: { column: 0, row: 0, width: 40, height: 24 } },
    cursor: {
      ...options.cursor,
      visible: options.cursorVisible ?? true,
      shape: "underline",
      token: "cyan",
    },
    effectSignal: {
      kind: options.kind,
      progress: options.progress,
      anchor: options.anchor,
      token: "cyan",
      startedAt: 100,
      durationMs: 240,
      direction: options.direction,
      transition: options.transition,
    },
    panels: [{
      id: "trace",
      rect: { column: 0, row: 0, width: 40, height: 1 },
      texts: [{
        id: "trace.0",
        column: 0,
        row: 0,
        text: options.trace,
        token: "lead",
      }],
      rules: [],
    }],
  } as PresentationScene;
}
