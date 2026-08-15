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
  type PocketTuiSession,
  type PocketTuiSurface,
} from "@pocket-tui/pocketjs";

import { SignalBelow, type SignalBelowContext } from "./game-app.js";
import type { RoguelikeGame } from "./game.js";
import type { PresentationScene, PresentationViewport } from "./presentation.js";

class DemoSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  readonly inputs: TuiInputEvent[] = [];
  readonly size: TuiViewportSize = { columns: 100, rows: 36 };
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

describe("Signal Below PocketJS backend integration", () => {
  test("mounts and updates the complete retained game through PocketJS frames", async () => {
    const surface = new DemoSurface();
    const host = createPocketTuiHost({ surface, colorMode: "truecolor" });
    let session: PocketTuiSession | undefined;
    let latestScene: PresentationScene | undefined;
    let latestGame: RoguelikeGame | undefined;
    const viewport: PresentationViewport = surface.size;
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
      present: (scene, game) => {
        latestScene = scene;
        latestGame = game;
      },
      requestClose: () => session?.requestClose(),
    };

    try {
      session = await mountPocketTui(
        () => SignalBelow({ seed: "backend-smoke", context }),
        { host, fps: 30 },
      );
      // Let the component's post-mount HOST LINK refresh join a Pocket frame.
      await Promise.resolve();
      await session.step();

      expect(surface.started).toBe(1);
      expect(host.diagnostics.liveNodes).toBeGreaterThan(1_500);
      expect(latestScene?.layout.mode).toBe("wide");
      expect(frameText(host.frame)).toContain("HYDROPHONE ARRAY");
      expect(frameText(host.frame)).toContain("RETURN CARRIER");
      expect(frameText(host.frame)).toContain("HOST LINK");
      expect(frameText(host.frame)).toContain("◉");

      const liveNodes = host.diagnostics.liveNodes;
      const playerNode = textNodeId(host.snapshot(), "◉");
      const headingNode = textNodeId(host.snapshot(), "RETURN CARRIER");
      const mutations = host.diagnostics.mutations;
      const layoutBaseline = host.diagnostics;
      const retainedLayoutNodes = host.snapshot().filter((node) => node.rect !== undefined).length;

      // A terminal event becomes a Pocket button edge. The game reacts from
      // onButtonPress; Pocket delivers signal effects on the following frame,
      // then the backend rasterizes only the retained updates.
      surface.inputs.push({ kind: "text", text: "." });
      await session.step();
      await session.step();
      await session.step();

      expect(latestGame?.turn).toBe(1);
      expect(host.diagnostics.liveNodes).toBe(liveNodes);
      expect(textNodeId(host.snapshot(), "◉")).toBe(playerNode);
      expect(textNodeId(host.snapshot(), "RETURN CARRIER")).toBe(headingNode);
      expect(host.diagnostics.mutations).toBeGreaterThan(mutations);
      expect(host.diagnostics.fullLayoutFrames).toBe(layoutBaseline.fullLayoutFrames);
      const localizedFrames =
        host.diagnostics.localizedLayoutFrames - layoutBaseline.localizedLayoutFrames;
      const localizedNodes = host.diagnostics.layoutNodes - layoutBaseline.layoutNodes;
      expect(localizedFrames).toBeGreaterThan(0);
      expect(localizedNodes / (localizedFrames * retainedLayoutNodes)).toBeLessThan(0.25);
    } finally {
      await session?.close();
    }

    expect(surface.closed).toBe(1);
  });
});

function frameText(frame: CanvasFrame): string {
  return frame.runs.map((run) => run.text).join("\n");
}

function textNodeId(
  nodes: readonly { readonly id: number; readonly text: string }[],
  text: string,
): number | undefined {
  return nodes.find((node) => node.text === text)?.id;
}
