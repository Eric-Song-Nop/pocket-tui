import {
  createTui,
  type CanvasFrame,
  type CreateTuiOptions,
  type CursorPacketOptions,
  type EffectBusFrame,
  type FlushMode,
  type TuiInputEvent,
  type TuiViewportSize,
} from "@pocket-tui/core";

export interface PocketTuiSurface {
  viewportSize(): TuiViewportSize;
  present(frame: CanvasFrame): void;
  setCursor(options: CursorPacketOptions): void;
  setEffectBus?(frame: EffectBusFrame): void;
  clearEffectBus?(): void;
  pollInput(): TuiInputEvent[];
  /** Notify the owner to drain/rearm input promptly, independent of frame cadence. */
  onInputReady?(callback: () => void): () => void;
  /** Distinguish a real readiness source from a compatibility no-op. */
  inputReadySupported?(): boolean;
  start(): void | Promise<void>;
  flush(mode?: FlushMode): void | Promise<void>;
  close(): void | Promise<void>;
}

export function createCoreSurface(options: CreateTuiOptions = {}): PocketTuiSurface {
  const app = createTui(options);
  // Keep this package independently type-checkable before @pocket-tui/core's
  // generated declarations have been rebuilt in a fresh checkout.
  const readinessApp = app as typeof app & {
    readonly inputReadySupported: boolean;
    onInputReady(callback: () => void): () => void;
  };
  const canvas = app.canvas();
  app.mount(canvas);
  return {
    viewportSize: () => app.viewportSize(),
    present: (frame) => {
      canvas.present(frame);
    },
    setCursor: (cursor) => {
      app.setCursor(cursor);
    },
    setEffectBus: (frame) => {
      app.setEffectBus(frame);
    },
    clearEffectBus: () => {
      app.clearEffectBus();
    },
    pollInput: () => app.pollInput(),
    onInputReady: (callback) => readinessApp.onInputReady(callback),
    inputReadySupported: () => readinessApp.inputReadySupported,
    start: () => app.start(),
    flush: (mode = "terminal") => app.flush(mode),
    close: () => app.close(),
  };
}
