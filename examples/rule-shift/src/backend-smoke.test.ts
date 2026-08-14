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
  type RuleShiftContext,
} from "./game-app.js";
import { isImmediateQuit, ruleShiftInputMap } from "./main.js";
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

      // Resize changes the layout projection, not the engine or level state.
      surface.size = { columns: 72, rows: 24 };
      surface.inputs.push({ kind: "resize", columns: 72, rows: 24 });
      await stepMany(session, 3);
      expect(latestScene?.layout.mode).toBe("compact");
      expect(latestSnapshot?.levelId).toBe("bloom");
      expect(host.frame.width).toBe(72);
      expect(host.frame.height).toBe(24);
      expect(host.diagnostics.liveNodes).toBe(liveNodes);
      expect(textNodeId(host.snapshot(), "RULE//SHIFT  MOVABLE TYPE PROOF")).toBe(mastheadNode);
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
});

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
