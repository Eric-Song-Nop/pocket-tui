// @ts-nocheck -- Bun supplies the test-only module at runtime.
import { describe, expect, test } from "bun:test";

import { CellBuffer } from "./canvas.js";
import { createTui } from "./app.js";
import { PtxOpcode, PtxPacketEncoder, decodePtx } from "./protocol.js";

describe("canvas PTX records", () => {
  test("styled runs and shader cursor state round-trip", () => {
    const packet = new PtxPacketEncoder(7n)
      .createCanvas(41n)
      .setCanvasFrame(41n, {
        width: 8,
        height: 2,
        runs: [
          {
            row: 1,
            column: 2,
            text: "@✦",
            style: {
              foreground: { kind: "indexed", index: 13 },
              background: { kind: "rgb", red: 2, green: 4, blue: 8 },
              bold: true,
            },
          },
        ],
      })
      .setCursor({
        row: 5,
        column: 9,
        visible: true,
        shape: "underline",
        color: { kind: "rgb", red: 241, green: 76, blue: 76 },
      })
      .finish();

    const decoded = decodePtx(packet);
    expect(decoded.sequence).toBe(7n);
    expect(decoded.operations.map((operation) => operation.opcode)).toEqual([
      PtxOpcode.CreateCanvas,
      PtxOpcode.SetCanvasFrame,
      PtxOpcode.SetCursor,
    ]);
    expect(decoded.operations[1]).toMatchObject({
      handle: 41n,
      frame: {
        width: 8,
        height: 2,
        runs: [{ row: 1, column: 2, text: "@✦", style: { bold: true } }],
      },
    });
    expect(decoded.operations[2]).toMatchObject({
      options: { row: 5, column: 9, visible: true, shape: "underline" },
    });
  });

  test("cursor reserved padding is rejected consistently with native", () => {
    const packet = new PtxPacketEncoder(1n)
      .setCursor({ row: 1, column: 2, visible: true })
      .finish();
    packet[38] = 1;

    expect(() => decodePtx(packet)).toThrow("non-zero SetCursor padding");
  });

  test("CellBuffer compacts adjacent cells with equal style", () => {
    const cyan = { foreground: { kind: "indexed", index: 14 }, bold: true } as const;
    const buffer = new CellBuffer(5, 1);
    buffer.text(0, 0, "@@", cyan).text(2, 0, "!..");

    expect(buffer.frame().runs).toEqual([
      { row: 0, column: 0, text: "@@", style: cyan },
      { row: 0, column: 2, text: "!..", style: undefined },
    ]);
  });

  test("CellBuffer omits untouched blanks and rejects wide glyph ambiguity", () => {
    const buffer = new CellBuffer(3, 2);
    expect(buffer.frame().runs).toEqual([]);
    expect(() => buffer.set(0, 0, "界")).toThrow("exactly one terminal column");
    expect(() => buffer.set(0, 0, "\u200b")).toThrow("exactly one terminal column");
    expect(() => new CellBuffer(2_000, 2_000)).toThrow("1,000,000 cells");
  });

  test("effect bus is a fixed 16-byte record with three byte channels", () => {
    const packet = new PtxPacketEncoder(9n)
      .setEffectBus({
        profile: "ghostty-palette-v1",
        trigger: true,
        channels: [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8, 255],
        ],
      })
      .finish();

    expect(packet.byteLength).toBe(48);
    expect(decodePtx(packet).operations).toEqual([
      {
        opcode: PtxOpcode.SetEffectBus,
        options: {
          profile: "ghostty-palette-v1",
          enabled: true,
          trigger: true,
          channels: [
            [1, 2, 3],
            [4, 5, 6],
            [7, 8, 255],
          ],
        },
      },
    ]);

    expect(() =>
      new PtxPacketEncoder(1n).setEffectBus({
        profile: "ghostty-palette-v1",
        channels: [[0, 0, 0], [0, 0, 0]] as never,
      }),
    ).toThrow("exactly three channels");
  });

  test("effect bus rejects unknown flags and reserved bytes", () => {
    const flags = new PtxPacketEncoder(1n)
      .setEffectBus({ profile: "ghostty-palette-v1" })
      .finish();
    flags[33] = 0x80;
    expect(() => decodePtx(flags)).toThrow("unknown required effect bus flag");

    const padding = new PtxPacketEncoder(1n)
      .setEffectBus({ profile: "ghostty-palette-v1" })
      .finish();
    padding[45] = 1;
    expect(() => decodePtx(padding)).toThrow("non-zero SetEffectBus padding");
  });

  test("TuiApp owns effect publication and keeps the profile explicit", async () => {
    const submitted: Uint8Array[] = [];
    class CapturingNative {
      submit(packet: Uint8Array): string {
        submitted.push(packet.slice());
        return decodePtx(packet).sequence.toString();
      }
      start(): void {}
      flush(): void {}
      close(): void {}
      pollInput(): never[] {
        return [];
      }
      memoryStats(): Record<string, number> {
        return {};
      }
    }
    const nativeBinding = {
      NativeTui: CapturingNative,
      nativeVersion: () => "test",
    } as never;
    const app = createTui({ effectBus: "ghostty-palette-v1", nativeBinding });
    app.mount(app.text("echo"));
    app.setEffectBus({
      trigger: true,
      channels: [
        [3, 40, 0],
        [200, 90, 255],
        [128, 128, 70],
      ],
    });
    await app.start();

    const operations = submitted.flatMap((packet) => decodePtx(packet).operations);
    expect(operations.at(-1)).toMatchObject({
      opcode: PtxOpcode.SetEffectBus,
      options: { profile: "ghostty-palette-v1", trigger: true },
    });
    await app.close();

    const plain = createTui({ nativeBinding });
    expect(() => plain.setEffectBus({ trigger: true })).toThrow("effectBus");
  });

  test("explicit flush invalidates its queued microtask without suppressing later mutations", async () => {
    const submitted: Uint8Array[] = [];
    let flushes = 0;
    class CapturingNative {
      submit(packet: Uint8Array): string {
        submitted.push(packet.slice());
        return decodePtx(packet).sequence.toString();
      }
      start(): void {}
      flush(): void {
        flushes += 1;
      }
      close(): void {}
      pollInput(): never[] {
        return [];
      }
      memoryStats(): Record<string, number> {
        return {};
      }
    }
    const app = createTui({
      nativeBinding: { NativeTui: CapturingNative, nativeVersion: () => "test" } as never,
    });
    const text = app.text("zero");
    app.mount(text);
    await app.start();

    text.setText("one");
    const explicitFlush = app.flush();
    text.setText("two");
    await explicitFlush;
    await Promise.resolve();

    expect(flushes).toBe(2);
    expect(
      submitted.flatMap((packet) => decodePtx(packet).operations).filter((operation) =>
        operation.opcode === PtxOpcode.SetText,
      ),
    ).toHaveLength(2);
    await app.close();
  });

  test("automatic flush errors remain observable and close still finalizes the app", async () => {
    let failNextFlush = true;
    let closes = 0;
    class FailingNative {
      submit(packet: Uint8Array): string {
        return decodePtx(packet).sequence.toString();
      }
      start(): void {}
      flush(): void {
        if (failNextFlush) {
          failNextFlush = false;
          throw new Error("automatic flush failed");
        }
      }
      close(): void {
        closes += 1;
      }
      pollInput(): never[] {
        return [];
      }
      memoryStats(): Record<string, number> {
        return {};
      }
    }
    const app = createTui({
      nativeBinding: { NativeTui: FailingNative, nativeVersion: () => "test" } as never,
    });
    const text = app.text("zero");
    app.mount(text);
    await app.start();

    text.setText("one");
    await Promise.resolve();
    expect(() => app.pollInput()).toThrow("automatic flush failed");
    expect(app.pollInput()).toEqual([]);

    await app.close();
    expect(app.state).toBe("closed");
    expect(closes).toBe(1);
  });

  test("native close errors still finalize app state and discard queued commands", async () => {
    let flushes = 0;
    class FailingCloseNative {
      submit(packet: Uint8Array): string {
        return decodePtx(packet).sequence.toString();
      }
      start(): void {}
      flush(): void {
        flushes += 1;
      }
      close(): void {
        throw new Error("native close failed");
      }
      pollInput(): never[] {
        return [];
      }
      memoryStats(): Record<string, number> {
        return {};
      }
    }
    const app = createTui({
      nativeBinding: { NativeTui: FailingCloseNative, nativeVersion: () => "test" } as never,
    });
    const text = app.text("zero");
    app.mount(text);
    await app.start();
    text.setText("queued");

    await expect(app.close()).rejects.toThrow("native close failed");
    expect(app.state).toBe("closed");
    expect(flushes).toBe(1);
    await Promise.resolve();
    expect(flushes).toBe(1);
    await app.close();
  });

  test("coalesces native readiness behind disposable app listeners", async () => {
    let ready: (() => void) | undefined;
    let installs = 0;
    let clears = 0;
    let closes = 0;
    class ReadyNative {
      submit(packet: Uint8Array): string {
        return decodePtx(packet).sequence.toString();
      }
      start(): void {}
      flush(): void {}
      close(): void {
        closes += 1;
      }
      pollInput(): never[] {
        return [];
      }
      onInputReady(callback: () => void): void {
        installs += 1;
        ready = callback;
      }
      clearInputReady(): void {
        clears += 1;
        ready = undefined;
      }
      memoryStats(): Record<string, number> {
        return {};
      }
    }

    const app = createTui({
      nativeBinding: { NativeTui: ReadyNative, nativeVersion: () => "test" } as never,
    });
    app.mount(app.text("ready"));
    let first = 0;
    let second = 0;
    const releaseFirst = app.onInputReady(() => {
      first += 1;
    });
    const releaseSecond = app.onInputReady(() => {
      second += 1;
    });
    expect(installs).toBe(0);

    await app.start();
    expect(installs).toBe(1);
    ready?.();
    expect([first, second]).toEqual([1, 1]);

    releaseFirst();
    ready?.();
    expect([first, second]).toEqual([1, 2]);
    expect(clears).toBe(0);

    const staleReady = ready;
    releaseSecond();
    expect(clears).toBe(1);
    const releaseThrowing = app.onInputReady(() => {
      throw new Error("readiness listener failed");
    });
    expect(installs).toBe(2);
    const currentReady = ready;
    staleReady?.();
    expect(app.pollInput()).toEqual([]);
    currentReady?.();
    expect(() => app.pollInput()).toThrow("readiness listener failed");
    expect(app.pollInput()).toEqual([]);
    releaseThrowing();

    await app.close();
    expect(clears).toBe(2);
    expect(closes).toBe(1);
  });
});
