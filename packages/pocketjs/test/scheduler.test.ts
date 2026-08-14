// @ts-nocheck -- Bun supplies the bun:test module at test runtime.
import { describe, expect, test } from "bun:test";
import { createRoot as createClientRoot } from "solid-js/dist/solid.js";
import { __hasFrameWork } from "#pocketjs-runtime";
import type {
  CanvasFrame,
  CursorPacketOptions,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import {
  after,
  createElement,
  createSignal,
  createSpriteAnimation,
  createTextNode,
  effect,
  insertNode,
  mountPocketTui,
  onButtonPress,
  onDemandFrame,
  onFrame,
  POCKET_BUTTON,
  pushButtonHandlerBlock,
  replaceText,
  requestFrame,
  type PocketTuiSurface,
} from "../src/index.js";

class FakeSurface implements PocketTuiSurface {
  readonly frames: CanvasFrame[] = [];
  readonly inputs: TuiInputEvent[] = [];
  readonly cursors: CursorPacketOptions[] = [];
  readonly #readyListeners = new Set<() => void>();
  started = 0;
  flushed = 0;
  closed = 0;
  polls = 0;
  pollDepth = 0;
  maxPollDepth = 0;
  flushGate?: Promise<void>;
  flushDelayMs = 0;
  pollHook?: () => void;
  pollFailure?: Error;
  closeFailure?: Error;

  constructor(public size: TuiViewportSize = { columns: 24, rows: 8 }) {}

  viewportSize(): TuiViewportSize {
    return this.size;
  }

  present(frame: CanvasFrame): void {
    this.frames.push(frame);
  }

  setCursor(cursor: CursorPacketOptions): void {
    this.cursors.push(cursor);
  }

  pollInput(): TuiInputEvent[] {
    this.polls += 1;
    this.pollDepth += 1;
    this.maxPollDepth = Math.max(this.maxPollDepth, this.pollDepth);
    try {
      if (this.pollFailure !== undefined) throw this.pollFailure;
      const hook = this.pollHook;
      this.pollHook = undefined;
      hook?.();
      return this.inputs.splice(0);
    } finally {
      this.pollDepth -= 1;
    }
  }

  onInputReady(callback: () => void): () => void {
    this.#readyListeners.add(callback);
    return () => this.#readyListeners.delete(callback);
  }

  emitInput(...events: TuiInputEvent[]): void {
    this.inputs.push(...events);
    this.emitReady();
  }

  emitReady(): void {
    for (const listener of [...this.#readyListeners]) listener();
  }

  start(): void {
    this.started += 1;
  }

  async flush(): Promise<void> {
    this.flushed += 1;
    if (this.flushDelayMs > 0) await delay(this.flushDelayMs);
    await this.flushGate;
  }

  close(): void {
    this.closed += 1;
    this.#readyListeners.clear();
    if (this.closeFailure !== undefined) throw this.closeFailure;
  }
}

class EscapeCadenceSurface extends FakeSurface {
  raw = "";
  escapeSince?: number;

  emitBytes(bytes: string): void {
    this.raw += bytes;
    this.emitReady();
  }

  override pollInput(): TuiInputEvent[] {
    this.polls += 1;
    const now = performance.now();
    const events: TuiInputEvent[] = [];
    if (this.escapeSince !== undefined && now - this.escapeSince >= 25) {
      events.push(key("escape"));
      this.escapeSince = undefined;
    }

    while (this.raw.length > 0) {
      if (this.escapeSince !== undefined) {
        if (this.raw.startsWith("[A") && now - this.escapeSince < 25) {
          this.raw = this.raw.slice(2);
          this.escapeSince = undefined;
          events.push(key("arrow-up"));
          continue;
        }
        events.push(key("escape"));
        this.escapeSince = undefined;
        continue;
      }
      if (this.raw.startsWith("\u001b")) {
        this.raw = this.raw.slice(1);
        if (this.raw.startsWith("[A")) {
          this.raw = this.raw.slice(2);
          events.push(key("arrow-up"));
        } else {
          this.escapeSince = now;
        }
        continue;
      }
      events.push({ kind: "text", text: this.raw });
      this.raw = "";
    }
    return events;
  }
}

describe("PocketJS scheduler", () => {
  test("adaptive sessions render an initial tick and then sleep while static", async () => {
    const surface = new FakeSurface();
    const session = await mountPocketTui(() => createElement("view"), {
      surface,
      fps: 60,
      framePolicy: "adaptive",
      idlePollMs: 1_000,
    });
    const running = session.run();

    try {
      await waitFor(() => session.diagnostics.skippedFrames >= 1);
      const ticks = session.diagnostics.skippedFrames;
      const flushes = surface.flushed;
      await delay(70);
      expect(session.diagnostics.skippedFrames).toBe(ticks);
      expect(surface.flushed).toBe(flushes);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("surface readiness wakes adaptive input for separate press and release frames", async () => {
    const surface = new FakeSurface();
    const buttons: number[] = [];
    const session = await mountPocketTui(
      () => {
        onDemandFrame((nextButtons) => {
          buttons.push(nextButtons);
          return nextButtons !== 0;
        });
        return createElement("view");
      },
      {
        surface,
        fps: 60,
        framePolicy: "adaptive",
        idlePollMs: 1_000,
      },
    );
    const running = session.run();

    try {
      await waitFor(() => buttons.length === 1);
      expect(buttons).toEqual([0]);
      surface.emitInput(key("arrow-up"));
      await waitFor(() => buttons.includes(POCKET_BUTTON.UP) && buttons.at(-1) === 0);
      expect(buttons.slice(-2)).toEqual([POCKET_BUTTON.UP, 0]);

      const settledFrames = buttons.length;
      await delay(70);
      expect(buttons).toHaveLength(settledFrames);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("drains ESC readiness immediately without advancing the 30fps Pocket cadence", async () => {
    const surface = new EscapeCadenceSurface();
    const input: TuiInputEvent[] = [];
    const frameTimes: number[] = [];
    const session = await mountPocketTui(
      () => {
        onFrame(() => {
          frameTimes.push(performance.now());
        });
        return createElement("view");
      },
      {
        surface,
        fps: 30,
        framePolicy: "adaptive",
        onInput: (event) => {
          input.push(event);
        },
      },
    );
    const running = session.run();

    try {
      await waitFor(() => frameTimes.length === 1);
      const initialFrames = session.diagnostics.steppedFrames;
      const initialPolls = surface.polls;

      surface.emitBytes("\u001b");
      expect(surface.polls).toBe(initialPolls + 1);
      expect(session.diagnostics.steppedFrames).toBe(initialFrames);
      expect(input).toEqual([]);

      await delay(10);
      const continuationPolls = surface.polls;
      surface.emitBytes("[A");
      expect(surface.polls).toBe(continuationPolls + 1);
      expect(session.diagnostics.steppedFrames).toBe(initialFrames);
      expect(input).toEqual([]);

      await waitFor(() => input.length === 1);
      expect(input).toEqual([key("arrow-up")]);
      expect(frameTimes[1] - frameTimes[0]).toBeGreaterThanOrEqual(24);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("coalesces a reentrant readiness edge into one input drain flight", async () => {
    const surface = new FakeSurface();
    const input: TuiInputEvent[] = [];
    const session = await mountPocketTui(() => createElement("view"), {
      surface,
      onInput: (event) => {
        input.push(event);
      },
    });

    try {
      surface.inputs.push(key("arrow-left"));
      surface.pollHook = () => surface.emitReady();
      surface.emitReady();
      expect(surface.maxPollDepth).toBe(1);
      expect(input).toEqual([]);

      const result = await session.step();
      expect(result.events).toEqual([key("arrow-left")]);
      expect(input).toEqual([key("arrow-left")]);
    } finally {
      await session.close();
    }
  });

  test("bounds cached input events and coalesces adjacent resize snapshots", async () => {
    const surface = new FakeSurface();
    const session = await mountPocketTui(() => createElement("view"), {
      surface,
      onInput: () => true,
    });

    try {
      const keys = Array.from({ length: 4_095 }, () => key("x"));
      surface.emitInput(...keys);
      surface.emitInput({ kind: "resize", columns: 40, rows: 12 });
      surface.emitInput({ kind: "resize", columns: 50, rows: 14 });

      const result = await session.step();
      expect(result.events).toHaveLength(4_096);
      expect(result.events.at(-1)).toEqual({ kind: "resize", columns: 50, rows: 14 });
      expect(session.viewportSize()).toEqual({ columns: 50, rows: 14 });
    } finally {
      await session.close();
    }
  });

  test("latches single-batch and multi-edge input backlog overflow", async () => {
    const eventSurface = new FakeSurface();
    const eventSession = await mountPocketTui(() => createElement("view"), {
      surface: eventSurface,
      onInput: () => true,
    });
    try {
      eventSurface.emitInput(...Array.from({ length: 4_097 }, () => key("x")));
      const pollsAtOverflow = eventSurface.polls;
      eventSurface.emitReady();
      expect(eventSurface.polls).toBe(pollsAtOverflow);
      await expect(eventSession.step()).rejects.toThrow(/4096 events.*2097152 UTF-8 text bytes/);
      await expect(eventSession.step()).rejects.toThrow(/4096 events.*2097152 UTF-8 text bytes/);
      expect(eventSurface.polls).toBe(pollsAtOverflow);
    } finally {
      await eventSession.close();
    }

    const textSurface = new FakeSurface();
    const textSession = await mountPocketTui(() => createElement("view"), {
      surface: textSurface,
      onInput: () => true,
    });
    try {
      textSurface.emitInput({ kind: "text", text: "a".repeat(1024 * 1024) });
      textSurface.emitInput({ kind: "paste-chunk", text: "界".repeat(349_525) + "a" });
      // The first two edges total exactly 2 MiB of UTF-8 payload.
      textSurface.emitInput({ kind: "text", text: "x" });
      const pollsAtOverflow = textSurface.polls;
      textSurface.emitReady();
      expect(textSurface.polls).toBe(pollsAtOverflow);
      await expect(textSession.step()).rejects.toThrow(/UTF-8 text bytes/);
    } finally {
      await textSession.close();
    }
  });

  test("latches input that arrives after pollInput while a flush is in flight", async () => {
    const surface = new FakeSurface();
    let presses = 0;
    const session = await mountPocketTui(
      () => {
        onButtonPress(POCKET_BUTTON.UP, () => {
          presses += 1;
        });
        return createElement("view");
      },
      {
        surface,
        fps: 60,
        framePolicy: "adaptive",
        idlePollMs: 1_000,
      },
    );
    let releaseFlush = (): void => {};
    surface.flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    session.setCursor({ row: 0, column: 0, visible: false });
    const flushesBeforeRun = surface.flushed;
    const running = session.run();

    try {
      await waitFor(() => surface.polls >= 1 && surface.flushed > flushesBeforeRun);
      const started = performance.now();
      surface.emitInput(key("arrow-up"));
      surface.flushGate = undefined;
      releaseFlush();
      await waitFor(() => presses === 1, 300);
      expect(performance.now() - started).toBeLessThan(250);
    } finally {
      surface.flushGate = undefined;
      releaseFlush();
      session.requestClose();
      await running;
    }
  });

  test("public onFrame holds a continuous adaptive cadence lease", async () => {
    const surface = new FakeSurface();
    let ticks = 0;
    const session = await mountPocketTui(
      () => {
        onFrame(() => {
          ticks += 1;
        });
        return createElement("view");
      },
      {
        surface,
        fps: 60,
        framePolicy: "adaptive",
        idlePollMs: 1_000,
      },
    );
    const running = session.run();

    try {
      await waitFor(() => ticks >= 4, 500);
      const before = ticks;
      await delay(45);
      expect(ticks).toBeGreaterThan(before);
      expect(ticks).toBeLessThan(30);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("client lifecycle cleanup deactivates frame and demand callbacks", async () => {
    const surface = new FakeSurface();
    let continuousTicks = 0;
    let demandTicks = 0;
    let disposeNested = (): void => {};
    const session = await mountPocketTui(
      () => {
        createClientRoot((dispose) => {
          disposeNested = dispose;
          onFrame(() => {
            continuousTicks += 1;
          });
          onDemandFrame(() => {
            demandTicks += 1;
            return true;
          });
        });
        return createElement("view");
      },
      { surface, fps: 60 },
    );

    try {
      await session.step();
      expect([continuousTicks, demandTicks]).toEqual([1, 1]);
      disposeNested();
      await session.step();
      expect([continuousTicks, demandTicks]).toEqual([1, 1]);
    } finally {
      await session.close();
    }
  });

  test("keeps identical frame callback registrations independently disposable", async () => {
    const surface = new FakeSurface();
    let ticks = 0;
    let disposeFirst = (): void => {};
    let disposeSecond = (): void => {};
    const callback = (): void => {
      ticks += 1;
    };
    const session = await mountPocketTui(
      () => {
        createClientRoot((dispose) => {
          disposeFirst = dispose;
          onFrame(callback);
        });
        createClientRoot((dispose) => {
          disposeSecond = dispose;
          onFrame(callback);
        });
        return createElement("view");
      },
      { surface },
    );

    try {
      await session.step();
      expect(ticks).toBe(2);
      disposeFirst();
      await session.step();
      expect(ticks).toBe(3);
      disposeSecond();
      await session.step();
      expect(ticks).toBe(3);
    } finally {
      await session.close();
    }
  });

  test("client lifecycle cleanup deactivates button press callbacks", async () => {
    const surface = new FakeSurface();
    let presses = 0;
    let disposeNested = (): void => {};
    const session = await mountPocketTui(
      () => {
        createClientRoot((dispose) => {
          disposeNested = dispose;
          onButtonPress(POCKET_BUTTON.UP, () => {
            presses += 1;
          });
        });
        return createElement("view");
      },
      { surface },
    );

    try {
      surface.emitInput(key("arrow-up"));
      await session.step();
      expect(presses).toBe(1);
      await session.step();

      disposeNested();
      surface.emitInput(key("arrow-up"));
      await session.step();
      expect(presses).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("stale session disposers cannot release a later session's lease or button block", async () => {
    const firstSurface = new FakeSurface();
    let cancelFirstTimer = (): void => {};
    let unblockFirst = (): void => {};
    const first = await mountPocketTui(
      () => {
        cancelFirstTimer = after(10_000, () => {});
        unblockFirst = pushButtonHandlerBlock();
        return createElement("view");
      },
      { surface: firstSurface },
    );
    await first.close();

    const secondSurface = new FakeSurface();
    let presses = 0;
    let unblockSecond = (): void => {};
    const second = await mountPocketTui(
      () => {
        onFrame(() => {});
        unblockSecond = pushButtonHandlerBlock();
        onButtonPress(POCKET_BUTTON.UP, () => {
          presses += 1;
        });
        return createElement("view");
      },
      { surface: secondSurface },
    );

    try {
      expect(__hasFrameWork()).toBe(true);
      cancelFirstTimer();
      unblockFirst();
      expect(__hasFrameWork()).toBe(true);

      secondSurface.emitInput(key("arrow-up"));
      await second.step();
      expect(presses).toBe(0);
      unblockSecond();
      await second.step();
      secondSurface.emitInput(key("arrow-up"));
      await second.step();
      expect(presses).toBe(1);
    } finally {
      cancelFirstTimer();
      unblockFirst();
      unblockSecond();
      await second.close();
    }
  });

  test("sprite animation updates retained text through the facade client runtime", async () => {
    const surface = new FakeSurface();
    const session = await mountPocketTui(
      () => {
        const root = createElement("view");
        const text = createTextNode("");
        const sprite = createSpriteAnimation(["A", "B"]);
        insertNode(root, text);
        effect(() => replaceText(text, sprite()));
        return root;
      },
      { surface, fps: 60 },
    );

    try {
      expect(frameText(session.host.frame)).toContain("A");
      await session.step();
      expect(frameText(session.host.frame)).toContain("B");
      await session.step();
      expect(frameText(session.host.frame)).toContain("A");
    } finally {
      await session.close();
    }
  });

  test("onDemandFrame can stop itself and requestFrame wakes exactly one later tick", async () => {
    const surface = new FakeSurface();
    let ticks = 0;
    const session = await mountPocketTui(
      () => {
        onDemandFrame(() => {
          ticks += 1;
          return false;
        });
        return createElement("view");
      },
      {
        surface,
        fps: 60,
        framePolicy: "adaptive",
        idlePollMs: 1_000,
      },
    );
    const running = session.run();

    try {
      await waitFor(() => ticks === 1);
      await delay(60);
      expect(ticks).toBe(1);

      requestFrame();
      await waitFor(() => ticks === 2);
      await delay(60);
      expect(ticks).toBe(2);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("virtual after timers hold adaptive cadence only through their deadline", async () => {
    const surface = new FakeSurface();
    let fired = 0;
    const session = await mountPocketTui(
      () => {
        after(3 / 60, () => {
          fired += 1;
        });
        return createElement("view");
      },
      {
        surface,
        fps: 60,
        framePolicy: "adaptive",
        idlePollMs: 1_000,
      },
    );
    const running = session.run();

    try {
      await waitFor(() => fired === 1);
      const settledFrames = session.diagnostics.steppedFrames;
      await delay(60);
      expect(session.diagnostics.steppedFrames).toBe(settledFrames);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("reactive retained mutations wake an idle adaptive session", async () => {
    const surface = new FakeSurface();
    let setLabel: (value: string) => void = () => {};
    const session = await mountPocketTui(
      () => {
        const [label, updateLabel] = createSignal("idle");
        setLabel = updateLabel;
        const root = createElement("view");
        const text = createTextNode("");
        insertNode(root, text);
        effect(() => replaceText(text, label()));
        return root;
      },
      {
        surface,
        fps: 60,
        framePolicy: "adaptive",
        idlePollMs: 1_000,
      },
    );
    const running = session.run();

    try {
      await waitFor(() => session.diagnostics.skippedFrames >= 1);
      const rendered = session.diagnostics.renderedFrames;
      setLabel("awake");
      await waitFor(() => session.diagnostics.renderedFrames > rendered);
      expect(frameText(session.host.frame)).toContain("awake");

      const settledFrames = session.diagnostics.renderedFrames;
      await delay(60);
      expect(session.diagnostics.renderedFrames).toBe(settledFrames);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("requestClose and AbortSignal interrupt an idle adaptive wait promptly", async () => {
    const closeSurface = new FakeSurface();
    const closeSession = await mountPocketTui(() => createElement("view"), {
      surface: closeSurface,
      framePolicy: "adaptive",
      idlePollMs: 1_000,
    });
    const closeRun = closeSession.run();
    try {
      await waitFor(() => closeSession.diagnostics.skippedFrames >= 1);
      closeSession.requestClose();
      await within(closeRun, 500);
      expect(closeSurface.closed).toBe(1);
    } finally {
      closeSession.requestClose();
      await closeRun;
    }

    const abortSurface = new FakeSurface();
    const abortSession = await mountPocketTui(() => createElement("view"), {
      surface: abortSurface,
      framePolicy: "adaptive",
      idlePollMs: 1_000,
    });
    const controller = new AbortController();
    const abortRun = abortSession.run(controller.signal);
    try {
      await waitFor(() => abortSession.diagnostics.skippedFrames >= 1);
      controller.abort();
      await within(abortRun, 500);
      expect(abortSurface.closed).toBe(1);
    } finally {
      controller.abort();
      await abortRun;
    }
  });

  test("serializes close behind an in-flight step on an async custom surface", async () => {
    const surface = new FakeSurface();
    const session = await mountPocketTui(() => createElement("view"), { surface });
    let releaseFlush = (): void => {};
    surface.flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    session.setCursor({ row: 0, column: 0, visible: false });
    const flushesBeforeStep = surface.flushed;
    const stepping = session.step();

    try {
      await waitFor(() => surface.flushed > flushesBeforeStep);
      const closing = session.close();
      await delay(15);
      expect(surface.closed).toBe(0);

      surface.flushGate = undefined;
      releaseFlush();
      await Promise.all([stepping, closing]);
      await session.closed;
      expect(surface.closed).toBe(1);
    } finally {
      surface.flushGate = undefined;
      releaseFlush();
      await session.close();
    }
  });

  test("rejects run during a manual step without closing or poisoning the session", async () => {
    const surface = new FakeSurface();
    const session = await mountPocketTui(() => createElement("view"), { surface });
    let releaseFlush = (): void => {};
    surface.flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    session.setCursor({ row: 0, column: 0, visible: false });
    const flushesBeforeStep = surface.flushed;
    const stepping = session.step();

    try {
      await waitFor(() => surface.flushed > flushesBeforeStep);
      await expect(session.run()).rejects.toThrow(/run\(\).*step\(\).*in progress/);
      expect(surface.closed).toBe(0);

      surface.flushGate = undefined;
      releaseFlush();
      await stepping;
      await session.step();
      expect(surface.closed).toBe(0);
    } finally {
      surface.flushGate = undefined;
      releaseFlush();
      await session.close();
    }
  });

  test("lets an accepted step or run reach its close safe point in the same tick", async () => {
    const stepSurface = new FakeSurface();
    const stepSession = await mountPocketTui(() => createElement("view"), {
      surface: stepSurface,
    });
    const stepping = stepSession.step();
    const stepClosing = stepSession.close();
    const stepResult = await stepping;
    await stepClosing;
    expect(stepResult.events).toEqual([]);
    expect(stepSurface.closed).toBe(1);
    await expect(stepSession.step()).rejects.toThrow("session is closed");

    const runSurface = new FakeSurface();
    const runSession = await mountPocketTui(() => createElement("view"), {
      surface: runSurface,
    });
    const running = runSession.run();
    const runClosing = runSession.close();
    await Promise.all([running, runClosing]);
    expect(runSurface.closed).toBe(1);
  });

  test("propagates an idle readiness poll failure and still closes the session", async () => {
    const surface = new FakeSurface();
    const session = await mountPocketTui(() => createElement("view"), {
      surface,
      framePolicy: "adaptive",
    });
    const running = session.run();

    await waitFor(() => session.diagnostics.steppedFrames === 1);
    surface.pollFailure = new Error("readiness poll failed");
    expect(() => surface.emitReady()).not.toThrow();
    await expect(within(running, 300)).rejects.toThrow("readiness poll failed");
    expect(surface.closed).toBe(1);
  });

  test("preserves both a run failure and a cleanup failure", async () => {
    const surface = new FakeSurface();
    const session = await mountPocketTui(() => createElement("view"), { surface });
    surface.pollFailure = new Error("poll failed");
    surface.closeFailure = new Error("close failed");

    const failure = await session.run().then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error) => error.message)).toEqual(["poll failed", "close failed"]);
    expect(failure.cause?.message).toBe("poll failed");
    await session.closed;
  });

  test("fixed policy keeps advancing at its configured cadence", async () => {
    const surface = new FakeSurface();
    let ticks = 0;
    const session = await mountPocketTui(
      () => {
        onDemandFrame(() => {
          ticks += 1;
          return false;
        });
        return createElement("view");
      },
      { surface, fps: 60, framePolicy: "fixed" },
    );
    const running = session.run();

    try {
      await waitFor(() => ticks >= 4, 500);
      const before = ticks;
      await delay(45);
      expect(ticks).toBeGreaterThan(before);
      expect(ticks).toBeLessThan(30);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("rebases a 60fps fixed cadence after a slightly over-budget flush", async () => {
    const surface = new FakeSurface();
    const frameTimes: number[] = [];
    const session = await mountPocketTui(
      () => {
        const [tick, setTick] = createSignal(0);
        const root = createElement("view");
        const text = createTextNode("");
        insertNode(root, text);
        effect(() => replaceText(text, String(tick())));
        onFrame(() => {
          frameTimes.push(performance.now());
          setTick((value) => value + 1);
        });
        return root;
      },
      { surface, fps: 60, framePolicy: "fixed" },
    );
    surface.flushDelayMs = 18;
    const running = session.run();

    try {
      await waitFor(() => frameTimes.length >= 6, 750);
      const sampled = frameTimes.slice(0, 6);
      const averageInterval = (sampled.at(-1) - sampled[0]) / (sampled.length - 1);
      expect(averageInterval).toBeLessThan(28);
      expect(averageInterval).toBeGreaterThanOrEqual(15);
    } finally {
      session.requestClose();
      await running;
    }
  });

  test("validates scheduler policy and idle polling bounds before mounting", async () => {
    await expect(
      mountPocketTui(() => createElement("view"), {
        surface: new FakeSurface(),
        framePolicy: "burst",
      }),
    ).rejects.toThrow(/framePolicy/);
    await expect(
      mountPocketTui(() => createElement("view"), {
        surface: new FakeSurface(),
        framePolicy: "adaptive",
        idlePollMs: 15,
      }),
    ).rejects.toThrow(/idlePollMs/);
    await expect(
      mountPocketTui(() => createElement("view"), {
        surface: new FakeSurface(),
        framePolicy: "adaptive",
        idlePollMs: 60_001,
      }),
    ).rejects.toThrow(/idlePollMs/);
    await expect(
      mountPocketTui(() => createElement("view"), {
        surface: new FakeSurface(),
        framePolicy: "adaptive",
        idlePollMs: Number.NaN,
      }),
    ).rejects.toThrow(/idlePollMs/);
  });
});

function key(keyName: string): TuiInputEvent {
  return { kind: "key", key: keyName, ctrl: false, alt: false, shift: false };
}

function frameText(frame: CanvasFrame): string {
  return frame.runs.map((run) => run.text).join("");
}

async function waitFor(condition: () => boolean, timeoutMs = 350): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for scheduler condition");
    await delay(2);
  }
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`scheduler operation exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
