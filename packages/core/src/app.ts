import {
  NATIVE_PROTOCOL_FEATURE_CANVAS_ROWS,
  loadNativeBinding,
  type NativeBinding,
  type NativeInputEvent,
  type NativeMemoryStats,
  type NativeTuiSession,
  type NativeViewportSize,
} from "./native.js";
import {
  PtxPacketEncoder,
  canvasFrameRecordByteLength,
  canvasRowsRecordByteLength,
  type BoxPacketOptions,
  type CanvasFrame,
  type CanvasRowRun,
  type CanvasRowsPatch,
  type CursorPacketOptions,
  type EffectBusChannel,
  type EffectBusPacketOptions,
  type EffectBusProfile,
} from "./protocol.js";

export type FlushMode = "accepted" | "painted" | "terminal";
export type TuiAppState = "created" | "active" | "closed";
export type TuiInputEvent = NativeInputEvent;
export type TuiMemoryStats = Readonly<NativeMemoryStats>;
export type TuiViewportSize = Readonly<NativeViewportSize>;

export interface CreateTuiOptions {
  /** Alternate-screen is the only MVP surface. */
  surface?: "alternate";
  /** Optional terminal-specific post-processing state channel. */
  effectBus?: EffectBusProfile;
  /** Override used by embedders and protocol smoke tests. */
  nativeBinding?: NativeBinding;
  /** Explicit `.node` artifact path; normally resolved automatically. */
  nativePath?: string;
}

export interface EffectBusFrame {
  readonly enabled?: boolean;
  /** Restart the shader event clock even if every channel is unchanged. */
  readonly trigger?: boolean;
  readonly channels?: readonly [EffectBusChannel, EffectBusChannel, EffectBusChannel];
}

export interface CanvasPresentOptions {
  /** Canvas-local rows fully replaced by this frame. Omitted rows must be unchanged. */
  readonly dirtyRows?: ReadonlySet<number> | readonly number[];
}

interface CanvasRevisionState {
  confirmedRevision: bigint;
  queuedRevision: bigint;
  confirmedWidth: number;
  confirmedHeight: number;
  queuedWidth: number;
  queuedHeight: number;
  confirmedFrame: boolean;
  queuedFrame: boolean;
}

interface CanvasFrameCommand {
  readonly kind: "setCanvasFrame";
  readonly handle: bigint;
  readonly frame: CanvasFrame;
  readonly patch?: CanvasRowsPatch;
  readonly baseRevision: bigint;
  readonly revision: bigint;
  readonly state: CanvasRevisionState;
}

type Command =
  | { kind: "createBox"; handle: bigint; options: BoxPacketOptions }
  | { kind: "createText"; handle: bigint; text: string }
  | { kind: "appendChild"; parent: bigint; child: bigint }
  | { kind: "setRoot"; handle: bigint }
  | { kind: "setText"; handle: bigint; text: string }
  | { kind: "appendText"; handle: bigint; text: string }
  | { kind: "removeNode"; handle: bigint }
  | { kind: "createTranscript"; handle: bigint }
  | { kind: "openBlock"; transcript: bigint; block: bigint }
  | { kind: "appendBlockText"; block: bigint; text: string }
  | { kind: "sealBlock"; block: bigint }
  | { kind: "createVirtualTranscript"; handle: bigint; transcript: bigint }
  | { kind: "createCanvas"; handle: bigint }
  | CanvasFrameCommand
  | { kind: "setCursor"; options: CursorPacketOptions }
  | { kind: "setEffectBus"; options: EffectBusPacketOptions };

export abstract class SceneHandle {
  readonly id: bigint;
  readonly #app: TuiApp;
  #removed = false;

  protected constructor(app: TuiApp, id: bigint) {
    this.#app = app;
    this.id = id;
  }

  remove(): void {
    this._assertLive();
    this.#removed = true;
    this.#app._remove(this.id);
  }

  /** @internal */
  _owner(): TuiApp {
    return this.#app;
  }

  /** @internal */
  _assertLive(): void {
    if (this.#removed) throw new Error(`Scene handle ${this.id} has been removed`);
    this.#app._assertOpen();
  }
}

export class BoxHandle extends SceneHandle {
  /** @internal */
  constructor(app: TuiApp, id: bigint) {
    super(app, id);
  }

  append(...children: SceneHandle[]): this {
    this._assertLive();
    for (const child of children) {
      child._assertLive();
      if (child._owner() !== this._owner()) {
        throw new TypeError("Cannot append a scene handle owned by another TuiApp");
      }
      this._owner()._appendChild(this.id, child.id);
    }
    return this;
  }

  text(text = ""): TextHandle {
    const child = this._owner().text(text);
    this.append(child);
    return child;
  }

  box(options: BoxPacketOptions = {}): BoxHandle {
    const child = this._owner().box(options);
    this.append(child);
    return child;
  }

  virtualTranscript(transcript: TranscriptHandle): VirtualTranscriptHandle {
    const child = this._owner().virtualTranscript(transcript);
    this.append(child);
    return child;
  }

  canvas(): CanvasHandle {
    const child = this._owner().canvas();
    this.append(child);
    return child;
  }
}

export class TextHandle extends SceneHandle {
  /** @internal */
  constructor(app: TuiApp, id: bigint) {
    super(app, id);
  }

  setText(text: string): this {
    this._assertLive();
    this._owner()._setText(this.id, text);
    return this;
  }

  appendText(text: string): this {
    this._assertLive();
    this._owner()._appendText(this.id, text);
    return this;
  }
}

export class VirtualTranscriptHandle extends SceneHandle {
  readonly transcript: TranscriptHandle;

  /** @internal */
  constructor(app: TuiApp, id: bigint, transcript: TranscriptHandle) {
    super(app, id);
    this.transcript = transcript;
  }
}

/** A retained, styled cell surface intended for games, charts, and custom widgets. */
export class CanvasHandle extends SceneHandle {
  readonly #revision: CanvasRevisionState = {
    confirmedRevision: 0n,
    queuedRevision: 0n,
    confirmedWidth: 1,
    confirmedHeight: 1,
    queuedWidth: 1,
    queuedHeight: 1,
    confirmedFrame: false,
    queuedFrame: false,
  };

  /** @internal */
  constructor(app: TuiApp, id: bigint) {
    super(app, id);
  }

  present(frame: CanvasFrame, options: CanvasPresentOptions = {}): this {
    this._assertLive();
    this._owner()._setCanvasFrame(this.id, frame, options, this.#revision);
    return this;
  }
}

export class TranscriptHandle {
  readonly id: bigint;
  readonly #app: TuiApp;

  /** @internal */
  constructor(app: TuiApp, id: bigint) {
    this.#app = app;
    this.id = id;
  }

  openBlock(): TranscriptBlockHandle {
    this.#app._assertOpen();
    return this.#app._openBlock(this);
  }

  /** @internal */
  _owner(): TuiApp {
    return this.#app;
  }
}

export class TranscriptBlockHandle {
  readonly id: bigint;
  readonly transcript: TranscriptHandle;
  #sealed = false;

  /** @internal */
  constructor(id: bigint, transcript: TranscriptHandle) {
    this.id = id;
    this.transcript = transcript;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  appendText(text: string): this {
    this.#assertOpen();
    this.transcript._owner()._appendBlockText(this.id, text);
    return this;
  }

  seal(): void {
    this.#assertOpen();
    this.transcript._owner()._sealBlock(this.id);
    this.#sealed = true;
  }

  #assertOpen(): void {
    this.transcript._owner()._assertOpen();
    if (this.#sealed) throw new Error(`Transcript block ${this.id} is sealed`);
  }
}

export class TuiApp {
  readonly options: Readonly<CreateTuiOptions>;
  #state: TuiAppState = "created";
  #nextHandle = 1n;
  #sequence = 1n;
  #commands: Command[] = [];
  #native?: NativeTuiSession;
  #protocolFeatures = 0;
  #root?: SceneHandle;
  #nextCommitToken = 1;
  #scheduledCommitToken?: number;
  readonly #inputReadyListeners = new Set<() => void>();
  #inputReadyInstalled = false;
  #inputReadyGeneration = 0;
  #asyncError?: unknown;

  constructor(options: CreateTuiOptions = {}) {
    if (options.surface !== undefined && options.surface !== "alternate") {
      throw new RangeError("The PocketTUI MVP currently supports only surface: 'alternate'");
    }
    if (options.effectBus !== undefined && options.effectBus !== "ghostty-palette-v1") {
      throw new RangeError(`Unsupported effect bus profile: ${String(options.effectBus)}`);
    }
    this.options = Object.freeze({ ...options, surface: "alternate" });
  }

  get state(): TuiAppState {
    return this.#state;
  }

  /** Whether the loaded native binding can signal terminal input readiness. */
  get inputReadySupported(): boolean {
    this._assertOpen();
    this.#throwAsyncError();
    return this.#ensureNative().onInputReady !== undefined;
  }

  box(options: BoxPacketOptions = {}): BoxHandle {
    this._assertOpen();
    const handle = this.#allocateHandle();
    this.#enqueue({ kind: "createBox", handle, options: { ...options } });
    return new BoxHandle(this, handle);
  }

  text(text = ""): TextHandle {
    this._assertOpen();
    const handle = this.#allocateHandle();
    this.#enqueue({ kind: "createText", handle, text });
    return new TextHandle(this, handle);
  }

  transcript(): TranscriptHandle {
    this._assertOpen();
    const handle = this.#allocateHandle();
    this.#enqueue({ kind: "createTranscript", handle });
    return new TranscriptHandle(this, handle);
  }

  virtualTranscript(transcript: TranscriptHandle): VirtualTranscriptHandle {
    this._assertOpen();
    if (transcript._owner() !== this) {
      throw new TypeError("Transcript handle is owned by another TuiApp");
    }
    const handle = this.#allocateHandle();
    this.#enqueue({ kind: "createVirtualTranscript", handle, transcript: transcript.id });
    return new VirtualTranscriptHandle(this, handle, transcript);
  }

  canvas(): CanvasHandle {
    this._assertOpen();
    const handle = this.#allocateHandle();
    this.#enqueue({ kind: "createCanvas", handle });
    return new CanvasHandle(this, handle);
  }

  /** Set the real terminal cursor used by IME and Ghostty shader integrations. */
  setCursor(options: CursorPacketOptions): void {
    this._assertOpen();
    this.#enqueue({
      kind: "setCursor",
      options: {
        ...options,
        color: options.color === undefined ? undefined : { ...options.color },
      },
    });
  }

  /** Publish three opaque channels to the configured terminal effect profile. */
  setEffectBus(frame: EffectBusFrame): void {
    this._assertOpen();
    const profile = this.options.effectBus;
    if (profile === undefined) {
      throw new Error("Create the TUI with effectBus: 'ghostty-palette-v1' before publishing effects");
    }
    this.#enqueue({
      kind: "setEffectBus",
      options: {
        profile,
        enabled: frame.enabled,
        trigger: frame.trigger,
        channels:
          frame.channels === undefined
            ? undefined
            : frame.channels.map((channel) => [...channel] as EffectBusChannel) as [
                EffectBusChannel,
                EffectBusChannel,
                EffectBusChannel,
              ],
      },
    });
  }

  /** Disable the configured effect bus and restore its reserved palette slots. */
  clearEffectBus(): void {
    this.setEffectBus({ enabled: false });
  }

  mount(root: SceneHandle): this {
    root._assertLive();
    if (root._owner() !== this) throw new TypeError("Root handle is owned by another TuiApp");
    this.#root = root;
    this.#enqueue({ kind: "setRoot", handle: root.id });
    return this;
  }

  setText(handle: TextHandle, text: string): void {
    handle.setText(text);
  }

  appendText(handle: TextHandle, text: string): void {
    handle.appendText(text);
  }

  async start(): Promise<void> {
    this._assertOpen();
    this.#throwAsyncError();
    if (this.#state === "active") return;
    if (this.#root === undefined) throw new Error("Mount a root Box, Text, or Canvas before start()");
    const native = this.#ensureNative();
    this.#commitPending();
    native.start();
    this.#state = "active";
    this.#installInputReady();
  }

  async flush(_mode: FlushMode = "terminal"): Promise<void> {
    this._assertOpen();
    this.#throwAsyncError();
    this.#scheduledCommitToken = undefined;
    this.#commitPending();
    this.#native?.flush();
  }

  /** Drain all terminal input currently available without blocking. */
  pollInput(): TuiInputEvent[] {
    this._assertOpen();
    this.#throwAsyncError();
    return this.#native?.pollInput() ?? [];
  }

  /**
   * Subscribe to a coalesced native stdin/resize readiness edge. Consumers
   * must still call pollInput(); the callback never owns or parses input.
   */
  onInputReady(callback: () => void): () => void {
    this._assertOpen();
    this.#throwAsyncError();
    if (typeof callback !== "function") {
      throw new TypeError("TuiApp.onInputReady() requires a callback");
    }
    // A distinct registration keeps two subscriptions of the same callback
    // independently disposable.
    const listener = (): void => callback();
    this.#inputReadyListeners.add(listener);
    this.#installInputReady();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#inputReadyListeners.delete(listener);
      if (this.#inputReadyListeners.size === 0) this.#clearInputReady();
    };
  }

  /** Read the current terminal viewport in character cells. */
  viewportSize(): TuiViewportSize {
    this._assertOpen();
    this.#throwAsyncError();
    const size = this.#ensureNative().viewportSize?.() ?? environmentViewportSize();
    return Object.freeze({ columns: size.columns, rows: size.rows });
  }

  /** Snapshot byte/count telemetry owned by the native runtime. */
  memoryStats(): TuiMemoryStats {
    this._assertOpen();
    this.#throwAsyncError();
    return Object.freeze(
      this.#native?.memoryStats() ?? {
        sceneNodes: 0,
        documents: 0,
        blocks: 0,
        openBlocks: 0,
        sealedBlocks: 0,
        documentTextBytes: 0,
        documentBudgetBytes: 0,
        estimatedDocumentRows: 0,
        estimatedNativeBytes: 0,
        terminalPendingBytes: 0,
      },
    );
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#scheduledCommitToken = undefined;
    this.#inputReadyListeners.clear();
    let failure: unknown;
    try {
      this.#clearInputReady();
      this.#commitPending();
      this.#native?.flush();
    } catch (error) {
      failure = error;
    }
    try {
      this.#native?.close();
    } catch (error) {
      failure = combineCleanupFailures(failure, error);
    } finally {
      this.#state = "closed";
      this.#commands.length = 0;
    }
    if (failure !== undefined) throw failure;
  }

  /** @internal */
  _appendChild(parent: bigint, child: bigint): void {
    this.#enqueue({ kind: "appendChild", parent, child });
  }

  /** @internal */
  _setText(handle: bigint, text: string): void {
    this.#enqueue({ kind: "setText", handle, text });
  }

  /** @internal */
  _appendText(handle: bigint, text: string): void {
    this.#enqueue({ kind: "appendText", handle, text });
  }

  /** @internal */
  _remove(handle: bigint): void {
    this.#enqueue({ kind: "removeNode", handle });
  }

  /** @internal */
  _openBlock(transcript: TranscriptHandle): TranscriptBlockHandle {
    if (transcript._owner() !== this) {
      throw new TypeError("Transcript handle is owned by another TuiApp");
    }
    const block = this.#allocateHandle();
    this.#enqueue({ kind: "openBlock", transcript: transcript.id, block });
    return new TranscriptBlockHandle(block, transcript);
  }

  /** @internal */
  _appendBlockText(block: bigint, text: string): void {
    this.#enqueue({ kind: "appendBlockText", block, text });
  }

  /** @internal */
  _sealBlock(block: bigint): void {
    this.#enqueue({ kind: "sealBlock", block });
  }

  /** @internal */
  _setCanvasFrame(
    handle: bigint,
    frame: CanvasFrame,
    options: CanvasPresentOptions,
    state: CanvasRevisionState,
  ): void {
    const dirtyRows = normalizeCanvasRows(options.dirtyRows, frame.height);
    if (
      dirtyRows?.length === 0 &&
      state.queuedFrame &&
      state.queuedWidth === frame.width &&
      state.queuedHeight === frame.height
    ) {
      return;
    }
    const retained = cloneCanvasFrame(frame);
    const fullRecordBytes = canvasFrameRecordByteLength(retained);
    const baseRevision = state.queuedRevision;
    const revision = nextCanvasRevision(baseRevision);
    let patch: CanvasRowsPatch | undefined;
    if (
      dirtyRows !== undefined &&
      dirtyRows.length > 0 &&
      dirtyRows.length < retained.height &&
      state.queuedFrame &&
      state.queuedWidth === retained.width &&
      state.queuedHeight === retained.height
    ) {
      const candidate = canvasRowsPatch(retained, dirtyRows, baseRevision);
      if (canvasRowsRecordByteLength(candidate) < fullRecordBytes) patch = candidate;
    }

    this.#enqueue({
      kind: "setCanvasFrame",
      handle,
      frame: retained,
      patch,
      baseRevision,
      revision,
      state,
    });
    state.queuedRevision = revision;
    state.queuedWidth = retained.width;
    state.queuedHeight = retained.height;
    state.queuedFrame = true;
  }

  /** @internal */
  _assertOpen(): void {
    if (this.#state === "closed") throw new Error("TuiApp is closed");
  }

  #allocateHandle(): bigint {
    const handle = this.#nextHandle;
    this.#nextHandle += 1n;
    return handle;
  }

  #enqueue(command: Command): void {
    this._assertOpen();
    this.#commands.push(command);
    if (this.#state === "active" && this.#scheduledCommitToken === undefined) {
      const commitToken = this.#nextCommitToken;
      this.#nextCommitToken += 1;
      this.#scheduledCommitToken = commitToken;
      queueMicrotask(() => {
        if (this.#scheduledCommitToken !== commitToken) return;
        this.#scheduledCommitToken = undefined;
        if (this.#state !== "active") return;
        try {
          this.#commitPending();
          this.#native?.flush();
        } catch (error) {
          this.#asyncError = error;
        }
      });
    }
  }

  #commitPending(): void {
    if (this.#commands.length === 0) return;
    if (this.#native === undefined) return;
    const commands = this.#commands;
    const encoder = new PtxPacketEncoder(this.#sequence);
    for (const command of commands) encodeCommand(encoder, command, this.#protocolFeatures);
    const packet = encoder.finish();
    const accepted = BigInt(this.#native.submit(packet));
    if (accepted !== this.#sequence) {
      throw new Error(`Native PTX receipt mismatch: expected ${this.#sequence}, received ${accepted}`);
    }
    for (const command of commands) {
      if (command.kind !== "setCanvasFrame") continue;
      command.state.confirmedRevision = command.revision;
      command.state.confirmedWidth = command.frame.width;
      command.state.confirmedHeight = command.frame.height;
      command.state.confirmedFrame = true;
    }
    this.#commands = [];
    this.#sequence += 1n;
  }

  #ensureNative(): NativeTuiSession {
    if (this.#native !== undefined) return this.#native;
    const binding = this.options.nativeBinding ?? loadNativeBinding(this.options.nativePath);
    const protocolFeatures = binding.protocolFeatures?.() ?? 0;
    if (
      !Number.isInteger(protocolFeatures) ||
      protocolFeatures < 0 ||
      protocolFeatures > 0xffff_ffff
    ) {
      throw new TypeError("PocketTUI native protocol features must be a u32 bitset");
    }
    const native = new binding.NativeTui();
    this.#protocolFeatures = protocolFeatures >>> 0;
    this.#native = native;
    return this.#native;
  }

  #installInputReady(): void {
    if (
      this.#state !== "active" ||
      this.#inputReadyInstalled ||
      this.#inputReadyListeners.size === 0
    ) {
      return;
    }
    const native = this.#native;
    if (native?.onInputReady === undefined) return;
    const generation = this.#inputReadyGeneration + 1;
    this.#inputReadyGeneration = generation;
    this.#inputReadyInstalled = true;
    try {
      native.onInputReady(() => {
        if (!this.#inputReadyInstalled || this.#inputReadyGeneration !== generation) return;
        for (const listener of [...this.#inputReadyListeners]) {
          try {
            listener();
          } catch (error) {
            this.#asyncError ??= error;
          }
        }
      });
    } catch (error) {
      if (this.#inputReadyGeneration === generation) {
        this.#inputReadyInstalled = false;
        this.#inputReadyGeneration += 1;
      }
      try {
        native.clearInputReady?.();
      } catch {
        // Preserve the causal registration error while invalidating any
        // partially installed native callback generation.
      }
      throw error;
    }
  }

  #clearInputReady(): void {
    if (!this.#inputReadyInstalled) return;
    this.#inputReadyInstalled = false;
    this.#inputReadyGeneration += 1;
    this.#native?.clearInputReady?.();
  }

  #throwAsyncError(): void {
    if (this.#asyncError === undefined) return;
    const error = this.#asyncError;
    this.#asyncError = undefined;
    throw error;
  }
}

function environmentViewportSize(): NativeViewportSize {
  const dimension = (name: "COLUMNS" | "LINES", fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 && value <= 0xffff ? value : fallback;
  };
  return { columns: dimension("COLUMNS", 80), rows: dimension("LINES", 24) };
}

function cloneCanvasFrame(frame: CanvasFrame): CanvasFrame {
  return {
    width: frame.width,
    height: frame.height,
    runs: frame.runs.map((run) => ({
      row: run.row,
      column: run.column,
      text: run.text,
      style:
        run.style === undefined
          ? undefined
          : {
              ...run.style,
              foreground:
                run.style.foreground === undefined ? undefined : { ...run.style.foreground },
              background:
                run.style.background === undefined ? undefined : { ...run.style.background },
            },
    })),
  };
}

function normalizeCanvasRows(
  rows: CanvasPresentOptions["dirtyRows"],
  height: number,
): readonly number[] | undefined {
  if (rows === undefined) return undefined;
  const normalized = new Set<number>();
  for (const row of rows) {
    if (!Number.isInteger(row) || row < 0 || row >= height) {
      throw new RangeError(`canvas dirty row ${String(row)} is outside the frame`);
    }
    normalized.add(row);
  }
  return [...normalized].sort((left, right) => left - right);
}

function canvasRowsPatch(
  frame: CanvasFrame,
  rows: readonly number[],
  baseRevision: bigint,
): CanvasRowsPatch {
  const runsByRow = new Map<number, CanvasRowRun[]>();
  for (const row of rows) runsByRow.set(row, []);
  for (const run of frame.runs) {
    const selected = runsByRow.get(run.row);
    if (selected === undefined) continue;
    selected.push({ column: run.column, text: run.text, style: run.style });
  }
  return {
    baseRevision,
    width: frame.width,
    height: frame.height,
    rows: rows.map((row) => ({ row, runs: runsByRow.get(row) ?? [] })),
  };
}

function nextCanvasRevision(revision: bigint): bigint {
  if (revision >= 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("canvas revision exceeds u64");
  }
  return revision + 1n;
}

function combineCleanupFailures(first: unknown, second: unknown): unknown {
  if (first === undefined) return second;
  return new AggregateError(
    [first, second],
    "TuiApp flush failed and native terminal cleanup also failed",
    { cause: first },
  );
}

export function createTui(options: CreateTuiOptions = {}): TuiApp {
  return new TuiApp(options);
}

function encodeCommand(encoder: PtxPacketEncoder, command: Command, protocolFeatures: number): void {
  switch (command.kind) {
    case "createBox":
      encoder.createBox(command.handle, command.options);
      break;
    case "createText":
      encoder.createText(command.handle, command.text);
      break;
    case "appendChild":
      encoder.appendChild(command.parent, command.child);
      break;
    case "setRoot":
      encoder.setRoot(command.handle);
      break;
    case "setText":
      encoder.setText(command.handle, command.text);
      break;
    case "appendText":
      encoder.appendText(command.handle, command.text);
      break;
    case "removeNode":
      encoder.removeNode(command.handle);
      break;
    case "createTranscript":
      encoder.createTranscript(command.handle);
      break;
    case "openBlock":
      encoder.openBlock(command.transcript, command.block);
      break;
    case "appendBlockText":
      encoder.appendBlockText(command.block, command.text);
      break;
    case "sealBlock":
      encoder.sealBlock(command.block);
      break;
    case "createVirtualTranscript":
      encoder.createVirtualTranscript(command.handle, command.transcript);
      break;
    case "createCanvas":
      encoder.createCanvas(command.handle);
      break;
    case "setCanvasFrame":
      if (
        command.patch !== undefined &&
        (protocolFeatures & NATIVE_PROTOCOL_FEATURE_CANVAS_ROWS) !== 0
      ) {
        encoder.setCanvasRows(command.handle, command.patch);
      } else {
        encoder.setCanvasFrame(command.handle, command.frame);
      }
      break;
    case "setCursor":
      encoder.setCursor(command.options);
      break;
    case "setEffectBus":
      encoder.setEffectBus(command.options);
      break;
  }
}
