import {
  __consumeFrameRequest,
  __hasFrameWork,
  __setFrameWake,
  BTN,
  mount,
  type MountOptions,
} from "#pocketjs-runtime";
import type {
  CanvasFrame,
  CursorPacketOptions,
  EffectBusFrame,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import {
  createPocketTuiHost,
  type PocketTuiHostDiagnostics,
  type PocketTuiHostOptions,
  PocketTuiHost,
} from "./host.js";
import {
  dispatchTextInteraction,
  focusedInteractionMapping,
  releaseInteractionCursor,
  syncInteractionCursor,
} from "./interaction.js";

export const POCKET_BUTTON = BTN;

export type PocketInputMapping = number | readonly number[];
export type PocketInputMapper = (event: TuiInputEvent) => PocketInputMapping | undefined;
export type PocketInputHandler = (event: TuiInputEvent, session: PocketTuiSession) => boolean | void;
export type PocketTuiFramePolicy = "fixed" | "adaptive";

export interface PocketTuiSessionOptions extends PocketTuiHostOptions {
  /** Reuse a separately constructed host, primarily for custom surfaces. */
  host?: PocketTuiHost;
  /** Pocket's ordinary style/pak options; this package always supplies ops. */
  pocket?: Omit<MountOptions, "ops">;
  /** Virtual host frames per second while run() is active. Default: 30. */
  fps?: number;
  /**
   * `fixed` preserves the traditional constant-rate pump. `adaptive` sleeps
   * until input, retained mutations, explicit frame requests, or a continuous
   * frame lease requires work. Default: `fixed`.
   */
  framePolicy?: PocketTuiFramePolicy;
  /**
   * Safety poll used by adaptive sessions when a custom surface cannot signal
   * input/resize readiness. It is ignored when the surface has a readiness
   * source. Default: 1000 ms.
   */
  idlePollMs?: number;
  /**
   * Policy for pending directional button pulses. `latest` coalesces stale
   * terminal autorepeat; `queue` preserves discrete turn-based commands.
   * Default: `latest`.
   */
  directionPulsePolicy?: "latest" | "queue";
  /** Override the terminal-event to Pocket button-pulse mapping. */
  mapInput?: PocketInputMapper;
  /** Runs before mapInput; return true to consume an event. */
  onInput?: PocketInputHandler;
}

export interface PocketTuiStepResult {
  readonly events: readonly TuiInputEvent[];
  readonly buttons: number;
  readonly frame: CanvasFrame;
}

export interface PocketTuiSessionDiagnostics extends PocketTuiHostDiagnostics {
  readonly framePolicy: PocketTuiFramePolicy;
  readonly steppedFrames: number;
  readonly idleWaits: number;
  readonly wakeSignals: number;
}

export class PocketTuiSession {
  readonly host: PocketTuiHost;
  readonly closed: Promise<void>;
  readonly #disposePocket: () => void;
  readonly #fps: number;
  readonly #framePolicy: PocketTuiFramePolicy;
  readonly #idlePollMs: number;
  readonly #directionPulsePolicy: "latest" | "queue";
  readonly #mapInput: PocketInputMapper;
  readonly #usesDefaultInputMap: boolean;
  readonly #onInput?: PocketInputHandler;
  readonly #releaseLease: () => void;
  readonly #releaseHostWake: () => void;
  readonly #releaseInputWake: () => void;
  readonly #buttonPulses: number[] = [];
  readonly #pendingInputEvents: TuiInputEvent[] = [];
  #pendingInputTextBytes = 0;
  #releasePending = false;
  #inputDrainActive = false;
  #inputDrainRequested = false;
  #inputDrainFailure?: unknown;
  #inputDrainFailureFatal = false;
  #wakeSequence = 0;
  #wakeWaiter?: () => void;
  #steppedFrames = 0;
  #idleWaits = 0;
  #wakeSignals = 0;
  #resolveClosed!: () => void;
  #closeRequested = false;
  #isClosed = false;
  #stepPromise?: Promise<PocketTuiStepResult>;
  #closePromise?: Promise<void>;
  #running = false;

  /** @internal Constructed by mountPocketTui after Pocket has mounted. */
  constructor(
    host: PocketTuiHost,
    disposePocket: () => void,
    options: PocketTuiSessionOptions,
    releaseLease: () => void,
  ) {
    this.host = host;
    this.#disposePocket = disposePocket;
    this.#fps = validateFps(options.fps ?? 30);
    this.#framePolicy = validateFramePolicy(options.framePolicy ?? "fixed");
    this.#idlePollMs = validateIdlePollMs(options.idlePollMs ?? DEFAULT_IDLE_POLL_MS);
    this.#directionPulsePolicy = validateDirectionPulsePolicy(
      options.directionPulsePolicy ?? "latest",
    );
    this.#mapInput = options.mapInput ?? defaultPocketInputMap;
    this.#usesDefaultInputMap = options.mapInput === undefined;
    this.#onInput = options.onInput;
    this.#releaseLease = releaseLease;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
    const wake = (): void => this.#wake();
    this.#releaseHostWake = this.host.onWorkNeeded(wake);
    this.#releaseInputWake = this.host.onInputReady(() => {
      // The native watcher is one-shot, and pollInput both advances the Escape
      // parser and rearms it. Drain immediately even while the Pocket cadence
      // gate is closed; completed events remain queued until the next legal
      // virtual frame.
      if (this.#drainInput()) this.#wake();
    });
    __setFrameWake(wake);
  }

  get diagnostics(): PocketTuiSessionDiagnostics {
    return Object.freeze({
      ...this.host.diagnostics,
      framePolicy: this.#framePolicy,
      steppedFrames: this.#steppedFrames,
      idleWaits: this.#idleWaits,
      wakeSignals: this.#wakeSignals,
    });
  }

  get closeRequested(): boolean {
    return this.#closeRequested;
  }

  viewportSize(): TuiViewportSize {
    return this.host.viewportSize();
  }

  setCursor(options: CursorPacketOptions): void {
    this.host.setCursor(options);
  }

  setEffectBus(frame: EffectBusFrame): void {
    this.host.setEffectBus(frame);
  }

  clearEffectBus(): void {
    this.host.clearEffectBus();
  }

  requestClose(): void {
    this.#closeRequested = true;
    this.#wake();
  }

  step(): Promise<PocketTuiStepResult> {
    if (this.#running) {
      return Promise.reject(new Error("PocketTUI: session.step() cannot run while run() is active"));
    }
    if (this.#isClosed) return Promise.reject(new Error("PocketTUI: session is closed"));
    return this.#scheduleStep(true);
  }

  async #performStep(): Promise<PocketTuiStepResult> {
    // The step was admitted before #scheduleStep published #stepPromise. Close
    // may be requested before this deferred microtask runs, but it must wait
    // for (rather than invalidate) the already accepted operation.
    if (this.#closeRequested) {
      const frame = this.host.frame;
      return { events: [], buttons: 0, frame };
    }

    this.#drainInput();
    this.#throwInputDrainFailure();
    const events = this.#pendingInputEvents.splice(0);
    this.#pendingInputTextBytes = 0;
    for (const event of events) {
      if (event.kind === "resize") this.host.resize(event.columns, event.rows);
      if (this.#onInput?.(event, this) === true) continue;
      if (dispatchTextInteraction(event)) continue;
      const mapping =
        (this.#usesDefaultInputMap ? focusedInteractionMapping(event) : undefined) ??
        this.#mapInput(event);
      if (mapping === undefined) continue;
      const mappedButtons = typeof mapping === "number" ? [mapping] : mapping;
      if (mappedButtons.length > MAX_QUEUED_BUTTON_PULSES) {
        throw new RangeError(
          `PocketTUI: input mapper may return at most ${MAX_QUEUED_BUTTON_PULSES} button masks`,
        );
      }
      for (const mapped of mappedButtons) {
        if (!Number.isInteger(mapped) || mapped < 0 || mapped > 0xffff_ffff) {
          throw new RangeError("PocketTUI: input mapper must return unsigned 32-bit button masks");
        }
        if (mapped === 0) continue;
        // Terminal input is edge-based rather than key-up/key-down based. Every
        // pulse is followed by one release frame so Pocket's edge detector sees
        // repeated keys as repeated presses.
        this.#enqueueButtonPulse(mapped >>> 0);
      }
    }

    let buttons = 0;
    if (this.#releasePending) {
      this.#releasePending = false;
    } else {
      buttons = this.#buttonPulses.shift() ?? 0;
      this.#releasePending = buttons !== 0;
    }
    const frameHandler = (globalThis as { frame?: (buttons: number, analog?: number) => void }).frame;
    if (typeof frameHandler !== "function") {
      throw new Error("PocketTUI: PocketJS frame handler is not installed");
    }
    // Consume before advancing Pocket so a request issued by this frame is
    // retained for the next adaptive tick rather than being lost.
    __consumeFrameRequest();
    frameHandler(buttons, 0x8080);
    this.#steppedFrames += 1;
    const frame = this.host.render();
    syncInteractionCursor(this.host);
    if (this.host.surfacePending) await this.host.flush("terminal");
    return { events, buttons, frame };
  }

  async #scheduleStep(closeAfterStep: boolean): Promise<PocketTuiStepResult> {
    if (this.#stepPromise !== undefined) {
      throw new Error("PocketTUI: a session step is already in progress");
    }
    // Defer execution by one microtask so #stepPromise is published before a
    // synchronous input/frame callback can call close(). Close then waits for
    // this safe point instead of disposing Pocket underneath the active step.
    const activeStep = Promise.resolve().then(() => this.#performStep());
    this.#stepPromise = activeStep;
    let result: PocketTuiStepResult | undefined;
    let stepFailure: unknown;
    try {
      result = await activeStep;
    } catch (error) {
      stepFailure = error;
    } finally {
      if (this.#stepPromise === activeStep) this.#stepPromise = undefined;
    }
    if (closeAfterStep && this.#closeRequested) {
      try {
        await this.close();
      } catch (closeFailure) {
        if (stepFailure === undefined) throw closeFailure;
        throw new AggregateError(
          [stepFailure, closeFailure],
          "PocketTUI: session step failed and terminal cleanup also failed",
          { cause: stepFailure },
        );
      }
    }
    if (stepFailure !== undefined) throw stepFailure;
    if (result === undefined) throw new Error("PocketTUI: session step completed without a result");
    return result;
  }

  #enqueueButtonPulse(buttons: number): void {
    if (
      this.#directionPulsePolicy === "latest" &&
      (buttons & DIRECTION_BUTTONS) !== 0
    ) {
      // Terminal autorepeat has no key-up signal. Only the freshest pending
      // direction is useful; replaying an old path after the user releases a
      // key makes controls feel sticky.
      for (let index = this.#buttonPulses.length - 1; index >= 0; index -= 1) {
        if (((this.#buttonPulses[index] ?? 0) & DIRECTION_BUTTONS) !== 0) {
          this.#buttonPulses.splice(index, 1);
        }
      }
    }
    if (this.#buttonPulses.length >= MAX_QUEUED_BUTTON_PULSES) {
      this.#buttonPulses.shift();
    }
    this.#buttonPulses.push(buttons);
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (this.#running) throw new Error("PocketTUI: session run loop is already active");
    if (this.#stepPromise !== undefined) {
      throw new Error("PocketTUI: session.run() cannot start while session.step() is in progress");
    }
    if (this.#isClosed) return;
    this.#running = true;
    let runFailure: unknown;
    try {
      if (this.#framePolicy === "adaptive") await this.#runAdaptive(signal);
      else await this.#runFixed(signal);
    } catch (error) {
      runFailure = error;
    }
    this.#running = false;
    try {
      await this.close();
    } catch (closeFailure) {
      if (runFailure === undefined) throw closeFailure;
      throw new AggregateError(
        [runFailure, closeFailure],
        "PocketTUI: session run failed and terminal cleanup also failed",
        { cause: runFailure },
      );
    }
    if (runFailure !== undefined) throw runFailure;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#isClosed) return Promise.resolve();
    this.#isClosed = true;
    this.#closeRequested = true;
    this.#wake();
    const activeStep = this.#stepPromise;
    this.#closePromise = (async () => {
      if (activeStep !== undefined) {
        try {
          await activeStep;
        } catch {
          // The step caller retains the original error. Teardown must still
          // run and reports only its own failure from close().
        }
      }
      await this.#finishClose();
    })();
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    let failure: unknown;
    try {
      __setFrameWake(undefined);
    } catch (error) {
      failure = error;
    }
    try {
      this.#releaseInputWake();
    } catch (error) {
      failure ??= error;
    }
    try {
      this.#releaseHostWake();
    } catch (error) {
      failure ??= error;
    }
    this.#pendingInputEvents.length = 0;
    this.#pendingInputTextBytes = 0;
    this.#inputDrainFailure = undefined;
    this.#inputDrainFailureFatal = false;
    this.#buttonPulses.length = 0;
    this.#releasePending = false;
    try {
      this.#disposePocket();
    } catch (error) {
      failure ??= error;
    }
    try {
      releaseInteractionCursor(this.host);
    } catch (error) {
      failure ??= error;
    }
    try {
      this.host.render(true);
      await this.host.flush("terminal");
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.host.close();
    } catch (error) {
      failure ??= error;
    } finally {
      this.#releaseLease();
      this.#resolveClosed();
    }
    if (failure !== undefined) throw failure;
  }

  async #runFixed(signal?: AbortSignal): Promise<void> {
    const interval = 1_000 / this.#fps;
    let deadline = monotonicNow();
    while (!this.#closeRequested && !signal?.aborted) {
      await this.#scheduleStep(false);
      if (this.#closeRequested || signal?.aborted) break;
      deadline += interval;
      const now = monotonicNow();
      if (deadline <= now) {
        // A slow step already consumed the wall-clock budget for this slot.
        // Rebase to now instead of rounding up to another full interval (which
        // would halve a 60fps loop when a step takes just over 16.7ms). The
        // serialized next step may begin immediately, but never catches up with
        // multiple virtual frames for one elapsed interval.
        deadline = now;
      }
      await this.#waitUntil(deadline, signal);
    }
  }

  async #runAdaptive(signal?: AbortSignal): Promise<void> {
    const interval = 1_000 / this.#fps;
    let nextAllowed = monotonicNow();
    let first = true;
    while (!this.#closeRequested && !signal?.aborted) {
      if (!first) {
        const observedWake = this.#wakeSequence;
        if (!this.#hasScheduledFrameWork()) {
          this.#idleWaits += 1;
          await this.#waitForWake(
            observedWake,
            this.host.inputReadySupported ? undefined : this.#idlePollMs,
            signal,
          );
        }
        this.#throwInputDrainFailure();
        if (this.#closeRequested || signal?.aborted) break;
        await this.#waitUntil(nextAllowed, signal);
        if (this.#closeRequested || signal?.aborted) break;
      }

      const started = monotonicNow();
      await this.#scheduleStep(false);
      first = false;
      nextAllowed = started + interval;
    }
  }

  #hasScheduledFrameWork(): boolean {
    return (
      __hasFrameWork() ||
      this.#pendingInputEvents.length > 0 ||
      this.#inputDrainFailure !== undefined ||
      this.#releasePending ||
      this.#buttonPulses.length > 0 ||
      this.host.renderPending ||
      this.host.surfacePending
    );
  }

  async #waitUntil(deadline: number, signal?: AbortSignal): Promise<void> {
    while (!this.#closeRequested && !signal?.aborted) {
      this.#throwInputDrainFailure();
      const remaining = deadline - monotonicNow();
      if (remaining <= 0) return;
      const observedWake = this.#wakeSequence;
      await this.#waitForWake(observedWake, remaining, signal);
      this.#throwInputDrainFailure();
    }
  }

  /**
   * Drain and rearm the synchronous surface input source without advancing a
   * Pocket frame. Reentrant readiness edges are coalesced into the same drain
   * flight, preserving event order without overlapping pollInput calls.
   */
  #drainInput(): boolean {
    if (this.#isClosed || this.#closeRequested || this.#inputDrainFailure !== undefined) {
      return false;
    }
    if (this.#inputDrainActive) {
      this.#inputDrainRequested = true;
      return false;
    }

    const initialEventCount = this.#pendingInputEvents.length;
    this.#inputDrainActive = true;
    try {
      do {
        this.#inputDrainRequested = false;
        try {
          this.#cacheInputEvents(this.host.pollInput());
        } catch (error) {
          this.#inputDrainFailure = error;
          this.#inputDrainFailureFatal = error instanceof InputBacklogOverflowError;
          break;
        }
      } while (
        this.#inputDrainRequested &&
        !this.#isClosed &&
        !this.#closeRequested
      );
    } finally {
      this.#inputDrainActive = false;
    }

    return (
      this.#pendingInputEvents.length > initialEventCount ||
      this.#inputDrainFailure !== undefined
    );
  }

  #cacheInputEvents(events: readonly TuiInputEvent[]): void {
    let eventCount = this.#pendingInputEvents.length;
    let textBytes = this.#pendingInputTextBytes;
    let previous = this.#pendingInputEvents.at(-1);

    // Validate the complete drain batch before mutating the retained queue.
    // Overflow is explicit: silently dropping an ordered key or paste chunk
    // would be observably worse than stopping the session at a safe boundary.
    for (const event of events) {
      if (event.kind !== "resize" || previous?.kind !== "resize") eventCount += 1;
      textBytes += inputEventTextBytes(event);
      if (
        eventCount > MAX_QUEUED_INPUT_EVENTS ||
        textBytes > MAX_QUEUED_INPUT_TEXT_BYTES
      ) {
        throw new InputBacklogOverflowError(
          `PocketTUI: pending input exceeds ${MAX_QUEUED_INPUT_EVENTS} events or ` +
            `${MAX_QUEUED_INPUT_TEXT_BYTES} UTF-8 text bytes`,
        );
      }
      previous = event;
    }

    for (const event of events) {
      const lastIndex = this.#pendingInputEvents.length - 1;
      if (event.kind === "resize" && this.#pendingInputEvents[lastIndex]?.kind === "resize") {
        this.#pendingInputEvents[lastIndex] = event;
      } else {
        this.#pendingInputEvents.push(event);
      }
    }
    this.#pendingInputTextBytes = textBytes;
  }

  #throwInputDrainFailure(): void {
    if (this.#inputDrainFailure === undefined) return;
    const failure = this.#inputDrainFailure;
    if (!this.#inputDrainFailureFatal) this.#inputDrainFailure = undefined;
    throw failure;
  }

  async #waitForWake(
    observedWake: number,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      this.#closeRequested ||
      signal?.aborted ||
      this.#wakeSequence !== observedWake ||
      (timeoutMs !== undefined && timeoutMs <= 0)
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.#wakeWaiter === finish) this.#wakeWaiter = undefined;
        resolve();
      };
      const timer = timeoutMs === undefined ? undefined : setTimeout(finish, timeoutMs);
      this.#wakeWaiter = finish;
      signal?.addEventListener("abort", finish, { once: true });
      // Close the race between the initial check and waiter publication.
      if (this.#wakeSequence !== observedWake || this.#closeRequested || signal?.aborted) finish();
    });
  }

  #wake(): void {
    this.#wakeSequence += 1;
    this.#wakeSignals += 1;
    this.#wakeWaiter?.();
  }
}

export async function mountPocketTui(
  code: () => unknown,
  options: PocketTuiSessionOptions = {},
): Promise<PocketTuiSession> {
  if (typeof code !== "function") throw new TypeError("mountPocketTui() requires a render function");
  if (options.host !== undefined && (options.surface !== undefined || options.tui !== undefined)) {
    throw new TypeError("PocketTUI: host cannot be combined with surface or tui options");
  }
  const fps = validateFps(options.fps ?? 30);
  validateFramePolicy(options.framePolicy ?? "fixed");
  validateIdlePollMs(options.idlePollMs ?? DEFAULT_IDLE_POLL_MS);
  validateDirectionPulsePolicy(options.directionPulsePolicy ?? "latest");
  const releaseLease = acquirePocketRuntimeLease();
  let host: PocketTuiHost | undefined;
  let disposePocket: (() => void) | undefined;
  try {
    host = options.host ?? createPocketTuiHost(options);
    disposePocket = mountWithSimulationRate(code, { ...options.pocket, ops: host.ops }, fps);
    host.render();
    syncInteractionCursor(host);
    await host.start();
    await host.flush("terminal");
    return new PocketTuiSession(host, disposePocket, { ...options, fps }, releaseLease);
  } catch (error) {
    try {
      disposePocket?.();
    } catch {
      // Preserve the causal mount/start error.
    }
    try {
      await host?.close();
    } catch {
      // Preserve the causal mount/start error.
    }
    releaseLease();
    throw error;
  }
}

export const createPocketTuiSession = mountPocketTui;

export const defaultPocketInputMap: PocketInputMapper = (event) => {
  if (event.kind === "key") {
    if (event.ctrl && event.key.toLowerCase() === "c") return BTN.SELECT;
    switch (event.key) {
      case "arrow-up":
        return BTN.UP;
      case "arrow-right":
        return BTN.RIGHT;
      case "arrow-down":
        return BTN.DOWN;
      case "arrow-left":
        return BTN.LEFT;
      case "enter":
        return BTN.START;
      case "escape":
        return BTN.SELECT;
      case "backspace":
        return BTN.SQUARE;
      default:
        return undefined;
    }
  }
  if (event.kind !== "text") return undefined;
  const buttons: number[] = [];
  for (const character of event.text) {
    let mapped: number | undefined;
    switch (character) {
      case "w":
      case "W":
      case "k":
      case "K":
        mapped = BTN.UP;
        break;
      case "d":
      case "D":
      case "l":
      case "L":
        mapped = BTN.RIGHT;
        break;
      case "s":
      case "S":
      case "j":
      case "J":
        mapped = BTN.DOWN;
        break;
      case "a":
      case "A":
      case "h":
      case "H":
        mapped = BTN.LEFT;
        break;
      case " ":
      case "p":
      case "P":
        mapped = BTN.CIRCLE;
        break;
      case ".":
        mapped = BTN.SQUARE;
        break;
      case "r":
      case "R":
        mapped = BTN.START;
        break;
      case "q":
      case "Q":
        mapped = BTN.SELECT;
        break;
      default:
        break;
    }
    if (mapped === undefined) continue;
    if (buttons.length === MAX_QUEUED_BUTTON_PULSES) buttons.shift();
    buttons.push(mapped);
  }
  return buttons.length > 0 ? buttons : undefined;
};

function validateFps(value: number): number {
  if (!VALID_SIMULATION_HZ.includes(value)) {
    throw new RangeError(
      `PocketTUI: fps must be one of ${VALID_SIMULATION_HZ.join(", ")}`,
    );
  }
  return value;
}

function validateDirectionPulsePolicy(value: unknown): "latest" | "queue" {
  if (value !== "latest" && value !== "queue") {
    throw new RangeError("PocketTUI: directionPulsePolicy must be one of latest, queue");
  }
  return value;
}

function validateFramePolicy(value: unknown): PocketTuiFramePolicy {
  if (value !== "fixed" && value !== "adaptive") {
    throw new RangeError("PocketTUI: framePolicy must be one of fixed, adaptive");
  }
  return value;
}

function validateIdlePollMs(value: number): number {
  if (!Number.isFinite(value) || value < 16 || value > 60_000) {
    throw new RangeError("PocketTUI: idlePollMs must be between 16 and 60000 milliseconds");
  }
  return value;
}

function mountWithSimulationRate(
  code: () => unknown,
  options: MountOptions,
  fps: number,
): () => void {
  const policy = globalThis as typeof globalThis & { __simHz?: unknown };
  const hadPolicy = Object.prototype.hasOwnProperty.call(policy, "__simHz");
  const previousPolicy = policy.__simHz;
  policy.__simHz = fps;
  try {
    return mount(code, options);
  } finally {
    if (hadPolicy) policy.__simHz = previousPolicy;
    else delete policy.__simHz;
  }
}

function acquirePocketRuntimeLease(): () => void {
  if (activePocketRuntimeLease !== undefined) {
    throw new Error("PocketTUI: PocketJS 0.6 supports only one active session per process");
  }
  const lease = Symbol("PocketTUI PocketJS session");
  activePocketRuntimeLease = lease;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activePocketRuntimeLease === lease) activePocketRuntimeLease = undefined;
  };
}

function monotonicNow(): number {
  return performance.now();
}

function inputEventTextBytes(event: TuiInputEvent): number {
  return event.kind === "text" || event.kind === "paste-chunk"
    ? INPUT_TEXT_ENCODER.encode(event.text).byteLength
    : 0;
}

class InputBacklogOverflowError extends RangeError {}

const DIRECTION_BUTTONS = BTN.UP | BTN.RIGHT | BTN.DOWN | BTN.LEFT;
const MAX_QUEUED_BUTTON_PULSES = 8;
const MAX_QUEUED_INPUT_EVENTS = 4_096;
const MAX_QUEUED_INPUT_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_IDLE_POLL_MS = 1_000;
const VALID_SIMULATION_HZ: readonly number[] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
const INPUT_TEXT_ENCODER = new TextEncoder();
let activePocketRuntimeLease: symbol | undefined;
