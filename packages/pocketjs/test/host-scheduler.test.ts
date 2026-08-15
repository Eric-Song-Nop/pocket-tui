// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import type {
  CanvasFrame,
  CursorPacketOptions,
  FlushMode,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import { createPocketTuiHost, type PocketTuiSurface } from "../src/index.js";
import { NODE } from "../src/spec.js";

class SchedulerSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  readonly cursors: CursorPacketOptions[] = [];
  flushed = 0;
  closed = 0;
  failFlush = false;
  flushGate?: Promise<void>;
  inputReady?: () => void;
  readinessDisposals = 0;

  viewportSize(): TuiViewportSize {
    return { columns: 20, rows: 6 };
  }

  present(frame: CanvasFrame): void {
    this.frames.push(frame);
  }

  setCursor(options: CursorPacketOptions): void {
    this.cursors.push(options);
  }

  pollInput(): TuiInputEvent[] {
    return [];
  }

  onInputReady(callback: () => void): () => void {
    this.inputReady = callback;
    return () => {
      this.readinessDisposals += 1;
      if (this.inputReady === callback) this.inputReady = undefined;
    };
  }

  start(): void {}

  async flush(_mode?: FlushMode): Promise<void> {
    this.flushed += 1;
    await this.flushGate;
    if (this.failFlush) throw new Error("flush failed");
  }

  close(): void {
    this.closed += 1;
  }
}

describe("PocketTuiHost scheduler signals", () => {
  test("wakes immediately for existing work and coalesces retained and surface mutations", async () => {
    const surface = new SchedulerSurface();
    const host = createPocketTuiHost({ surface });
    let wakes = 0;
    const dispose = host.onWorkNeeded(() => {
      wakes += 1;
    });

    expect(host.renderPending).toBe(true);
    expect(host.surfacePending).toBe(false);
    expect(wakes).toBe(1);

    const first = host.ops.createNode(NODE.text);
    host.ops.setText(first, "one");
    host.ops.setText(first, "two");
    expect(wakes).toBe(1);

    host.render();
    expect(host.renderPending).toBe(false);
    expect(host.surfacePending).toBe(true);
    expect(wakes).toBe(2);
    await host.flush();
    expect(host.surfacePending).toBe(false);

    host.ops.setText(first, "three");
    host.ops.setText(first, "four");
    expect(wakes).toBe(3);

    host.render();
    await host.flush();
    host.setCursor({ visible: true, x: 1, y: 1 });
    host.setCursor({ visible: true, x: 2, y: 1 });
    expect(host.surfacePending).toBe(true);
    expect(wakes).toBe(5);

    dispose();
    await host.flush();
    host.ops.setText(first, "five");
    expect(wakes).toBe(5);
    await host.close();
  });

  test("retains pending surface work after a failed flush and still flushes when clean", async () => {
    const surface = new SchedulerSurface();
    const host = createPocketTuiHost({ surface });
    host.render();
    expect(host.surfacePending).toBe(true);

    surface.failFlush = true;
    await expect(host.flush()).rejects.toThrow("flush failed");
    expect(host.surfacePending).toBe(true);

    surface.failFlush = false;
    await host.flush();
    expect(host.surfacePending).toBe(false);
    const flushed = surface.flushed;
    await host.flush();
    expect(surface.flushed).toBe(flushed + 1);
    expect(host.surfacePending).toBe(false);

    host.setCursor({ visible: true, x: 1, y: 1 });
    let releaseFlush = (): void => {};
    surface.flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const inFlightFlush = host.flush();
    host.setCursor({ visible: true, x: 2, y: 1 });
    releaseFlush();
    await inFlightFlush;
    expect(host.surfacePending).toBe(true);
    surface.flushGate = undefined;
    await host.flush();
    expect(host.surfacePending).toBe(false);
    await host.close();
  });

  test("forwards input readiness and disposes subscriptions explicitly or on close", async () => {
    const surface = new SchedulerSurface();
    const host = createPocketTuiHost({ surface });
    let notifications = 0;
    const dispose = host.onInputReady(() => {
      notifications += 1;
    });

    surface.inputReady?.();
    expect(notifications).toBe(1);
    dispose();
    surface.inputReady?.();
    expect(notifications).toBe(1);
    expect(surface.readinessDisposals).toBe(1);

    host.onInputReady(() => {
      notifications += 1;
    });
    await host.close();
    expect(surface.readinessDisposals).toBe(2);
    expect(surface.inputReady).toBeUndefined();
    expect(surface.closed).toBe(1);
  });

  test("does not trust a readiness capability without a subscription source", async () => {
    const surface = new SchedulerSurface() as SchedulerSurface & {
      inputReadySupported?: () => boolean;
      onInputReady?: undefined;
    };
    surface.inputReadySupported = () => true;
    surface.onInputReady = undefined;
    const host = createPocketTuiHost({ surface });

    expect(host.inputReadySupported).toBe(false);
    await host.close();
  });
});
