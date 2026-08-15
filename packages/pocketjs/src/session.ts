import { BTN, mount, type MountOptions } from "#pocketjs-runtime";
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

export interface PocketTuiSessionOptions extends PocketTuiHostOptions {
  /** Reuse a separately constructed host, primarily for custom surfaces. */
  host?: PocketTuiHost;
  /** Pocket's ordinary style/pak options; this package always supplies ops. */
  pocket?: Omit<MountOptions, "ops">;
  /** Virtual host frames per second while run() is active. Default: 30. */
  fps?: number;
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

export class PocketTuiSession {
  readonly host: PocketTuiHost;
  readonly closed: Promise<void>;
  readonly #disposePocket: () => void;
  readonly #fps: number;
  readonly #directionPulsePolicy: "latest" | "queue";
  readonly #mapInput: PocketInputMapper;
  readonly #usesDefaultInputMap: boolean;
  readonly #onInput?: PocketInputHandler;
  readonly #releaseLease: () => void;
  readonly #buttonPulses: number[] = [];
  #releasePending = false;
  #resolveClosed!: () => void;
  #closeRequested = false;
  #isClosed = false;
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
  }

  get diagnostics(): PocketTuiHostDiagnostics {
    return this.host.diagnostics;
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
  }

  async step(): Promise<PocketTuiStepResult> {
    if (this.#isClosed) throw new Error("PocketTUI: session is closed");
    if (this.#closeRequested) {
      const frame = this.host.frame;
      await this.close();
      return { events: [], buttons: 0, frame };
    }

    const events = this.host.pollInput();
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
    frameHandler(buttons, 0x8080);
    const frame = this.host.render();
    syncInteractionCursor(this.host);
    await this.host.flush("terminal");
    if (this.#closeRequested) await this.close();
    return { events, buttons, frame };
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
    if (this.#isClosed) return;
    this.#running = true;
    const interval = 1_000 / this.#fps;
    try {
      while (!this.#closeRequested && !signal?.aborted) {
        const started = Date.now();
        await this.step();
        if (this.#closeRequested) break;
        await delay(Math.max(0, interval - (Date.now() - started)));
      }
    } finally {
      this.#running = false;
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#closeRequested = true;
    let failure: unknown;
    try {
      this.#disposePocket();
      releaseInteractionCursor(this.host);
      this.host.render(true);
      await this.host.flush("terminal");
    } catch (error) {
      failure = error;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const DIRECTION_BUTTONS = BTN.UP | BTN.RIGHT | BTN.DOWN | BTN.LEFT;
const MAX_QUEUED_BUTTON_PULSES = 8;
const VALID_SIMULATION_HZ: readonly number[] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
let activePocketRuntimeLease: symbol | undefined;
