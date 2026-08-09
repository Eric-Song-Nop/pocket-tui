import { loadNativeBinding, type NativeBinding, type NativeTuiSession } from "./native.js";
import { PtxPacketEncoder, type BoxPacketOptions } from "./protocol.js";

export type FlushMode = "accepted" | "painted" | "terminal";
export type TuiAppState = "created" | "active" | "closed";

export interface CreateTuiOptions {
  /** Alternate-screen is the only MVP surface. */
  surface?: "alternate";
  /** Override used by embedders and protocol smoke tests. */
  nativeBinding?: NativeBinding;
  /** Explicit `.node` artifact path; normally resolved automatically. */
  nativePath?: string;
}

type Command =
  | { kind: "createBox"; handle: bigint; options: BoxPacketOptions }
  | { kind: "createText"; handle: bigint; text: string }
  | { kind: "appendChild"; parent: bigint; child: bigint }
  | { kind: "setRoot"; handle: bigint }
  | { kind: "setText"; handle: bigint; text: string }
  | { kind: "appendText"; handle: bigint; text: string }
  | { kind: "removeNode"; handle: bigint };

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

export class TuiApp {
  readonly options: Readonly<CreateTuiOptions>;
  #state: TuiAppState = "created";
  #nextHandle = 1n;
  #sequence = 1n;
  #commands: Command[] = [];
  #native?: NativeTuiSession;
  #root?: SceneHandle;
  #commitScheduled = false;
  #asyncError?: unknown;

  constructor(options: CreateTuiOptions = {}) {
    if (options.surface !== undefined && options.surface !== "alternate") {
      throw new RangeError("The PocketTUI MVP currently supports only surface: 'alternate'");
    }
    this.options = Object.freeze({ ...options, surface: "alternate" });
  }

  get state(): TuiAppState {
    return this.#state;
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
    if (this.#root === undefined) throw new Error("Mount a root Box or Text before start()");
    const binding = this.options.nativeBinding ?? loadNativeBinding(this.options.nativePath);
    this.#native = new binding.NativeTui();
    this.#commitPending();
    this.#native.start();
    this.#state = "active";
  }

  async flush(_mode: FlushMode = "terminal"): Promise<void> {
    this._assertOpen();
    this.#throwAsyncError();
    this.#commitScheduled = false;
    this.#commitPending();
    this.#native?.flush();
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#commitScheduled = false;
    try {
      this.#commitPending();
      this.#native?.flush();
    } finally {
      this.#native?.close();
      this.#state = "closed";
      this.#commands.length = 0;
    }
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
    if (this.#state === "active" && !this.#commitScheduled) {
      this.#commitScheduled = true;
      queueMicrotask(() => {
        this.#commitScheduled = false;
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
    for (const command of commands) encodeCommand(encoder, command);
    const packet = encoder.finish();
    const accepted = BigInt(this.#native.submit(packet));
    if (accepted !== this.#sequence) {
      throw new Error(`Native PTX receipt mismatch: expected ${this.#sequence}, received ${accepted}`);
    }
    this.#commands = [];
    this.#sequence += 1n;
  }

  #throwAsyncError(): void {
    if (this.#asyncError === undefined) return;
    const error = this.#asyncError;
    this.#asyncError = undefined;
    throw error;
  }
}

export function createTui(options: CreateTuiOptions = {}): TuiApp {
  return new TuiApp(options);
}

function encodeCommand(encoder: PtxPacketEncoder, command: Command): void {
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
  }
}
