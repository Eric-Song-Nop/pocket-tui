/** Version-one pointer-free PocketTUI transaction protocol. */

export const PTX_MAGIC = "PTX1";
export const PTX_MAJOR_VERSION = 1;
export const PTX_HEADER_BYTES = 24;
export const PTX_OPERATION_HEADER_BYTES = 8;
export const PTX_MAX_PACKET_BYTES = 8 * 1024 * 1024;

export const enum PtxOpcode {
  CreateBox = 1,
  CreateText = 2,
  AppendChild = 3,
  SetRoot = 4,
  SetText = 5,
  AppendText = 6,
  RemoveNode = 7,
  CreateTranscript = 8,
  OpenBlock = 9,
  AppendBlockText = 10,
  SealBlock = 11,
  CreateVirtualTranscript = 12,
  CreateCanvas = 13,
  SetCanvasFrame = 14,
  SetCursor = 15,
  SetEffectBus = 16,
  SetCanvasRows = 17,
}

export type BoxDirection = "column" | "row";

export interface BoxPacketOptions {
  direction?: BoxDirection;
  border?: boolean;
  padding?: number;
}

export type TuiColor =
  | { readonly kind: "default" }
  | { readonly kind: "indexed"; readonly index: number }
  | { readonly kind: "rgb"; readonly red: number; readonly green: number; readonly blue: number };

export interface TuiStyle {
  readonly foreground?: TuiColor;
  readonly background?: TuiColor;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly blink?: boolean;
  readonly reverse?: boolean;
  readonly hidden?: boolean;
  readonly strikethrough?: boolean;
}

export interface CanvasRun {
  readonly row: number;
  readonly column: number;
  readonly text: string;
  readonly style?: TuiStyle;
}

export interface CanvasFrame {
  readonly width: number;
  readonly height: number;
  readonly runs: readonly CanvasRun[];
}

/** One run inside a row replacement; the containing row owns its coordinate. */
export interface CanvasRowRun {
  readonly column: number;
  readonly text: string;
  readonly style?: TuiStyle;
}

/** Complete replacement for one canvas-local row. An empty run list clears it. */
export interface CanvasRowReplacement {
  readonly row: number;
  readonly runs: readonly CanvasRowRun[];
}

/** Sparse row replacement against an exact retained Canvas revision. */
export interface CanvasRowsPatch {
  readonly baseRevision: bigint;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly CanvasRowReplacement[];
}

export type CursorShape = "block" | "underline" | "bar";

export interface CursorPacketOptions {
  readonly row: number;
  readonly column: number;
  readonly visible?: boolean;
  /** Steady terminal cursor shape. Defaults to `block`. */
  readonly shape?: CursorShape;
  readonly color?: TuiColor;
}

export type EffectBusProfile = "ghostty-palette-v1";
export type EffectBusChannel = readonly [red: number, green: number, blue: number];

/** Three opaque 24-bit channels transported through a negotiated terminal effect profile. */
export interface EffectBusPacketOptions {
  readonly profile: EffectBusProfile;
  readonly enabled?: boolean;
  /** Restart the profile's event clock even when the channels did not change. */
  readonly trigger?: boolean;
  readonly channels?: readonly [EffectBusChannel, EffectBusChannel, EffectBusChannel];
}

export type DecodedPtxOperation =
  | { opcode: PtxOpcode.CreateBox; handle: bigint; options: Required<BoxPacketOptions> }
  | { opcode: PtxOpcode.CreateText; handle: bigint; text: string }
  | { opcode: PtxOpcode.AppendChild; parent: bigint; child: bigint }
  | { opcode: PtxOpcode.SetRoot; handle: bigint }
  | { opcode: PtxOpcode.SetText; handle: bigint; text: string }
  | { opcode: PtxOpcode.AppendText; handle: bigint; text: string }
  | { opcode: PtxOpcode.RemoveNode; handle: bigint }
  | { opcode: PtxOpcode.CreateTranscript; handle: bigint }
  | { opcode: PtxOpcode.OpenBlock; transcript: bigint; block: bigint }
  | { opcode: PtxOpcode.AppendBlockText; handle: bigint; text: string }
  | { opcode: PtxOpcode.SealBlock; handle: bigint }
  | { opcode: PtxOpcode.CreateVirtualTranscript; handle: bigint; transcript: bigint }
  | { opcode: PtxOpcode.CreateCanvas; handle: bigint }
  | { opcode: PtxOpcode.SetCanvasFrame; handle: bigint; frame: CanvasFrame }
  | { opcode: PtxOpcode.SetCanvasRows; handle: bigint; patch: CanvasRowsPatch }
  | { opcode: PtxOpcode.SetCursor; options: Required<CursorPacketOptions> }
  | { opcode: PtxOpcode.SetEffectBus; options: Required<EffectBusPacketOptions> };

export interface DecodedPtxPacket {
  major: number;
  flags: number;
  sequence: bigint;
  operations: DecodedPtxOperation[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ZERO_EFFECT_CHANNELS = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
] as const satisfies readonly [EffectBusChannel, EffectBusChannel, EffectBusChannel];

interface PreparedCanvasFrame {
  readonly payloadBytes: number;
  readonly runs: readonly { readonly run: CanvasRun; readonly text: Uint8Array }[];
}

interface PreparedCanvasRows {
  readonly payloadBytes: number;
  readonly rows: readonly {
    readonly row: number;
    readonly runs: readonly { readonly run: CanvasRowRun; readonly text: Uint8Array }[];
  }[];
}

/** Exact aligned PTX record size, excluding the shared packet header. */
export function canvasFrameRecordByteLength(frame: CanvasFrame): number {
  return align8(PTX_OPERATION_HEADER_BYTES + prepareCanvasFrame(frame).payloadBytes);
}

/** Exact aligned PTX record size, excluding the shared packet header. */
export function canvasRowsRecordByteLength(patch: CanvasRowsPatch): number {
  return align8(PTX_OPERATION_HEADER_BYTES + prepareCanvasRows(patch).payloadBytes);
}

function prepareCanvasFrame(frame: CanvasFrame): PreparedCanvasFrame {
  assertCanvasDimensions(frame.width, frame.height);
  if (!Number.isInteger(frame.runs.length) || frame.runs.length > 0xffff_ffff) {
    throw new RangeError("canvas run count exceeds u32");
  }
  const runs = frame.runs.map((run, index) => {
    assertU16(run.row, `canvas run ${index} row`);
    assertCanvasRun(run.column, run.text, run.style, frame.width, `canvas run ${index}`);
    if (run.row >= frame.height) {
      throw new RangeError(`canvas run ${index} starts outside the frame`);
    }
    return { run, text: encodeRunText(run.text, `canvas run ${index}`) };
  });
  const payloadBytes = runs.reduce((sum, value) => sum + 20 + value.text.byteLength, 16);
  assertCanvasPayloadBytes(payloadBytes, "canvas frame");
  return { payloadBytes, runs };
}

function prepareCanvasRows(patch: CanvasRowsPatch): PreparedCanvasRows {
  assertU64(patch.baseRevision, "canvas base revision");
  assertCanvasDimensions(patch.width, patch.height);
  if (
    !Number.isInteger(patch.rows.length) ||
    patch.rows.length === 0 ||
    patch.rows.length > 0xffff_ffff
  ) {
    throw new RangeError("canvas row replacement count must be between 1 and u32 max");
  }
  let previousRow = -1;
  const rows = patch.rows.map((replacement, rowIndex) => {
    assertU16(replacement.row, `canvas row replacement ${rowIndex} row`);
    if (replacement.row >= patch.height) {
      throw new RangeError(`canvas row replacement ${rowIndex} is outside the frame`);
    }
    if (replacement.row <= previousRow) {
      throw new RangeError("canvas row replacements must be strictly increasing and unique");
    }
    previousRow = replacement.row;
    if (!Number.isInteger(replacement.runs.length) || replacement.runs.length > 0xffff_ffff) {
      throw new RangeError(`canvas row replacement ${rowIndex} run count exceeds u32`);
    }
    const runs = replacement.runs.map((run, runIndex) => {
      const label = `canvas row replacement ${rowIndex} run ${runIndex}`;
      assertCanvasRun(run.column, run.text, run.style, patch.width, label);
      return { run, text: encodeRunText(run.text, label) };
    });
    return { row: replacement.row, runs };
  });
  const payloadBytes = rows.reduce(
    (sum, row) => row.runs.reduce((rowSum, value) => rowSum + 16 + value.text.byteLength, sum + 8),
    24,
  );
  assertCanvasPayloadBytes(payloadBytes, "canvas row patch");
  return { payloadBytes, rows };
}

function assertCanvasDimensions(width: number, height: number): void {
  assertU16(width, "canvas width");
  assertU16(height, "canvas height");
  if (width === 0 || height === 0) {
    throw new RangeError("canvas dimensions must be non-zero");
  }
}

function assertCanvasRun(
  column: number,
  text: string,
  style: TuiStyle | undefined,
  width: number,
  label: string,
): void {
  assertU16(column, `${label} column`);
  if (column >= width) throw new RangeError(`${label} starts outside the frame`);
  if (text.length === 0) throw new RangeError(`${label} is empty`);
  if (/\r|\n/u.test(text)) throw new RangeError(`${label} contains a line break`);
  encodeAttributes(style);
  encodeColor(style?.foreground);
  encodeColor(style?.background);
}

function encodeRunText(text: string, label: string): Uint8Array {
  const value = encoder.encode(text);
  if (value.byteLength > 0xffff_ffff) {
    throw new RangeError(`${label} text exceeds u32 length`);
  }
  return value;
}

function assertCanvasPayloadBytes(byteLength: number, label: string): void {
  if (!Number.isSafeInteger(byteLength) || byteLength > PTX_MAX_PACKET_BYTES) {
    throw new RangeError(`${label} exceeds the PTX packet limit`);
  }
}

/**
 * Builds one self-contained PTX1 packet. Handles and strings are values, never
 * pointers into JavaScript or native memory.
 */
export class PtxPacketEncoder {
  readonly #sequence: bigint;
  readonly #flags: number;
  readonly #records: Uint8Array[] = [];

  constructor(sequence: bigint, flags = 0) {
    if (sequence <= 0n || sequence > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError("PTX sequence must be a non-zero u64");
    }
    assertU16(flags, "flags");
    this.#sequence = sequence;
    this.#flags = flags;
  }

  createBox(handle: bigint, options: BoxPacketOptions = {}): this {
    assertHandle(handle);
    const payload = new Uint8Array(16);
    const view = dataView(payload);
    view.setBigUint64(0, handle, true);
    payload[8] = options.direction === "row" ? 1 : 0;
    payload[9] = options.border ? 1 : 0;
    const padding = options.padding ?? 0;
    assertU16(padding, "padding");
    view.setUint16(10, padding, true);
    return this.#record(PtxOpcode.CreateBox, payload);
  }

  createText(handle: bigint, text: string): this {
    return this.#textRecord(PtxOpcode.CreateText, handle, text);
  }

  appendChild(parent: bigint, child: bigint): this {
    assertHandle(parent);
    assertHandle(child);
    const payload = new Uint8Array(16);
    const view = dataView(payload);
    view.setBigUint64(0, parent, true);
    view.setBigUint64(8, child, true);
    return this.#record(PtxOpcode.AppendChild, payload);
  }

  setRoot(handle: bigint): this {
    return this.#handleRecord(PtxOpcode.SetRoot, handle);
  }

  setText(handle: bigint, text: string): this {
    return this.#textRecord(PtxOpcode.SetText, handle, text);
  }

  appendText(handle: bigint, text: string): this {
    return this.#textRecord(PtxOpcode.AppendText, handle, text);
  }

  removeNode(handle: bigint): this {
    return this.#handleRecord(PtxOpcode.RemoveNode, handle);
  }

  createTranscript(handle: bigint): this {
    return this.#handleRecord(PtxOpcode.CreateTranscript, handle);
  }

  openBlock(transcript: bigint, block: bigint): this {
    return this.#twoHandleRecord(PtxOpcode.OpenBlock, transcript, block);
  }

  appendBlockText(block: bigint, text: string): this {
    return this.#textRecord(PtxOpcode.AppendBlockText, block, text);
  }

  sealBlock(block: bigint): this {
    return this.#handleRecord(PtxOpcode.SealBlock, block);
  }

  createVirtualTranscript(handle: bigint, transcript: bigint): this {
    return this.#twoHandleRecord(PtxOpcode.CreateVirtualTranscript, handle, transcript);
  }

  createCanvas(handle: bigint): this {
    return this.#handleRecord(PtxOpcode.CreateCanvas, handle);
  }

  setCanvasFrame(handle: bigint, frame: CanvasFrame): this {
    assertHandle(handle);
    const prepared = prepareCanvasFrame(frame);

    const payload = new Uint8Array(prepared.payloadBytes);
    const view = dataView(payload);
    view.setBigUint64(0, handle, true);
    view.setUint16(8, frame.width, true);
    view.setUint16(10, frame.height, true);
    view.setUint32(12, prepared.runs.length, true);
    let offset = 16;
    for (const { run, text } of prepared.runs) {
      view.setUint16(offset, run.row, true);
      view.setUint16(offset + 2, run.column, true);
      view.setUint16(offset + 4, encodeAttributes(run.style), true);
      view.setUint32(offset + 8, encodeColor(run.style?.foreground), true);
      view.setUint32(offset + 12, encodeColor(run.style?.background), true);
      view.setUint32(offset + 16, text.byteLength, true);
      payload.set(text, offset + 20);
      offset += 20 + text.byteLength;
    }
    return this.#record(PtxOpcode.SetCanvasFrame, payload);
  }

  setCanvasRows(handle: bigint, patch: CanvasRowsPatch): this {
    assertHandle(handle);
    const prepared = prepareCanvasRows(patch);
    const payload = new Uint8Array(prepared.payloadBytes);
    const view = dataView(payload);
    view.setBigUint64(0, handle, true);
    view.setBigUint64(8, patch.baseRevision, true);
    view.setUint16(16, patch.width, true);
    view.setUint16(18, patch.height, true);
    view.setUint32(20, prepared.rows.length, true);
    let offset = 24;
    for (const row of prepared.rows) {
      view.setUint16(offset, row.row, true);
      view.setUint32(offset + 4, row.runs.length, true);
      offset += 8;
      for (const { run, text } of row.runs) {
        view.setUint16(offset, run.column, true);
        view.setUint16(offset + 2, encodeAttributes(run.style), true);
        view.setUint32(offset + 4, encodeColor(run.style?.foreground), true);
        view.setUint32(offset + 8, encodeColor(run.style?.background), true);
        view.setUint32(offset + 12, text.byteLength, true);
        payload.set(text, offset + 16);
        offset += 16 + text.byteLength;
      }
    }
    return this.#record(PtxOpcode.SetCanvasRows, payload);
  }

  setCursor(options: CursorPacketOptions): this {
    assertU16(options.row, "cursor row");
    assertU16(options.column, "cursor column");
    const payload = new Uint8Array(16);
    const view = dataView(payload);
    view.setUint16(0, options.row, true);
    view.setUint16(2, options.column, true);
    payload[4] = options.visible === false ? 0 : 1;
    switch (options.shape ?? "block") {
      case "block":
        payload[5] = 0;
        break;
      case "underline":
        payload[5] = 1;
        break;
      case "bar":
        payload[5] = 2;
        break;
      default:
        throw new RangeError(`Unsupported cursor shape: ${String(options.shape)}`);
    }
    view.setUint32(8, encodeColor(options.color), true);
    return this.#record(PtxOpcode.SetCursor, payload);
  }

  setEffectBus(options: EffectBusPacketOptions): this {
    if (options.profile !== "ghostty-palette-v1") {
      throw new RangeError(`Unsupported effect bus profile: ${String(options.profile)}`);
    }
    const channels = options.channels ?? ZERO_EFFECT_CHANNELS;
    if (channels.length !== 3) {
      throw new RangeError("effect bus must contain exactly three channels");
    }
    const payload = new Uint8Array(16);
    payload[0] = 1;
    payload[1] = (options.enabled === false ? 0 : 1) | (options.trigger ? 2 : 0);
    let offset = 4;
    for (const [channelIndex, channel] of channels.entries()) {
      if (channel.length !== 3) {
        throw new RangeError(`effect bus channel ${channelIndex} must contain three bytes`);
      }
      for (const [componentIndex, component] of channel.entries()) {
        assertByte(component, `effect bus channel ${channelIndex} component ${componentIndex}`);
        payload[offset] = component;
        offset += 1;
      }
    }
    return this.#record(PtxOpcode.SetEffectBus, payload);
  }

  finish(): Uint8Array {
    const byteLength = PTX_HEADER_BYTES + this.#records.reduce((sum, record) => sum + record.byteLength, 0);
    if (byteLength > PTX_MAX_PACKET_BYTES) {
      throw new RangeError(`PTX packet exceeds ${PTX_MAX_PACKET_BYTES} bytes`);
    }

    const packet = new Uint8Array(byteLength);
    packet.set(encoder.encode(PTX_MAGIC), 0);
    const view = dataView(packet);
    view.setUint16(4, PTX_MAJOR_VERSION, true);
    view.setUint16(6, this.#flags, true);
    view.setUint32(8, byteLength, true);
    view.setUint32(12, this.#records.length, true);
    view.setBigUint64(16, this.#sequence, true);

    let offset = PTX_HEADER_BYTES;
    for (const record of this.#records) {
      packet.set(record, offset);
      offset += record.byteLength;
    }
    return packet;
  }

  #handleRecord(opcode: PtxOpcode, handle: bigint): this {
    assertHandle(handle);
    const payload = new Uint8Array(8);
    dataView(payload).setBigUint64(0, handle, true);
    return this.#record(opcode, payload);
  }

  #twoHandleRecord(opcode: PtxOpcode, first: bigint, second: bigint): this {
    assertHandle(first);
    assertHandle(second);
    const payload = new Uint8Array(16);
    const view = dataView(payload);
    view.setBigUint64(0, first, true);
    view.setBigUint64(8, second, true);
    return this.#record(opcode, payload);
  }

  #textRecord(opcode: PtxOpcode, handle: bigint, text: string): this {
    assertHandle(handle);
    const encoded = encoder.encode(text);
    if (encoded.byteLength > 0xffff_ffff) {
      throw new RangeError("PTX string exceeds u32 length");
    }
    const payload = new Uint8Array(16 + encoded.byteLength);
    const view = dataView(payload);
    view.setBigUint64(0, handle, true);
    view.setUint32(8, encoded.byteLength, true);
    payload.set(encoded, 16);
    return this.#record(opcode, payload);
  }

  #record(opcode: PtxOpcode, payload: Uint8Array): this {
    const byteLength = align8(PTX_OPERATION_HEADER_BYTES + payload.byteLength);
    const record = new Uint8Array(byteLength);
    const view = dataView(record);
    view.setUint16(0, opcode, true);
    view.setUint16(2, 0, true);
    view.setUint32(4, byteLength, true);
    record.set(payload, PTX_OPERATION_HEADER_BYTES);
    this.#records.push(record);
    return this;
  }
}

/** Decode helper used by diagnostics, adapters, and protocol smoke checks. */
export function decodePtx(packet: Uint8Array): DecodedPtxPacket {
  if (packet.byteLength < PTX_HEADER_BYTES) {
    throw new PtxDecodeError("packet is shorter than its header");
  }
  if (packet.byteLength > PTX_MAX_PACKET_BYTES) {
    throw new PtxDecodeError("packet exceeds the 8 MiB limit");
  }
  if (decoder.decode(packet.subarray(0, 4)) !== PTX_MAGIC) {
    throw new PtxDecodeError("invalid magic");
  }

  const view = dataView(packet);
  const major = view.getUint16(4, true);
  if (major !== PTX_MAJOR_VERSION) {
    throw new PtxDecodeError(`unsupported major version ${major}`);
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== packet.byteLength) {
    throw new PtxDecodeError(`length mismatch: ${declaredLength} != ${packet.byteLength}`);
  }

  const flags = view.getUint16(6, true);
  const operationCount = view.getUint32(12, true);
  const sequence = view.getBigUint64(16, true);
  const operations: DecodedPtxOperation[] = [];
  let offset = PTX_HEADER_BYTES;

  for (let index = 0; index < operationCount; index += 1) {
    ensureRange(packet, offset, PTX_OPERATION_HEADER_BYTES);
    const opcode = view.getUint16(offset, true) as PtxOpcode;
    const recordLength = view.getUint32(offset + 4, true);
    if (recordLength < PTX_OPERATION_HEADER_BYTES || recordLength % 8 !== 0) {
      throw new PtxDecodeError(`record ${index} is not 8-byte aligned`);
    }
    ensureRange(packet, offset, recordLength);
    const payloadOffset = offset + PTX_OPERATION_HEADER_BYTES;
    const payloadLength = recordLength - PTX_OPERATION_HEADER_BYTES;
    operations.push(decodeOperation(packet, view, opcode, payloadOffset, payloadLength));
    offset += recordLength;
  }
  if (offset !== packet.byteLength) {
    throw new PtxDecodeError("trailing bytes after final record");
  }

  return { major, flags, sequence, operations };
}

export class PtxDecodeError extends Error {
  constructor(message: string) {
    super(`Invalid PTX1 packet: ${message}`);
    this.name = "PtxDecodeError";
  }
}

function decodeOperation(
  packet: Uint8Array,
  view: DataView,
  opcode: PtxOpcode,
  payloadOffset: number,
  payloadLength: number,
): DecodedPtxOperation {
  const handle = (): bigint => {
    ensurePayload(payloadLength, 8);
    return view.getBigUint64(payloadOffset, true);
  };
  switch (opcode) {
    case PtxOpcode.CreateBox: {
      ensurePayload(payloadLength, 16);
      const directionByte = packet[payloadOffset + 8];
      const borderByte = packet[payloadOffset + 9];
      if (directionByte !== 0 && directionByte !== 1) throw new PtxDecodeError("invalid box direction");
      if (borderByte !== 0 && borderByte !== 1) throw new PtxDecodeError("invalid border flag");
      return {
        opcode,
        handle: handle(),
        options: {
          direction: directionByte === 1 ? "row" : "column",
          border: borderByte === 1,
          padding: view.getUint16(payloadOffset + 10, true),
        },
      };
    }
    case PtxOpcode.CreateText:
    case PtxOpcode.SetText:
    case PtxOpcode.AppendText:
    case PtxOpcode.AppendBlockText: {
      ensurePayload(payloadLength, 16);
      const textLength = view.getUint32(payloadOffset + 8, true);
      ensurePayload(payloadLength, 16 + textLength);
      const text = decoder.decode(packet.subarray(payloadOffset + 16, payloadOffset + 16 + textLength));
      if (opcode === PtxOpcode.CreateText) return { opcode, handle: handle(), text };
      if (opcode === PtxOpcode.SetText) return { opcode, handle: handle(), text };
      if (opcode === PtxOpcode.AppendText) return { opcode, handle: handle(), text };
      return { opcode, handle: handle(), text };
    }
    case PtxOpcode.AppendChild:
      ensurePayload(payloadLength, 16);
      return {
        opcode,
        parent: view.getBigUint64(payloadOffset, true),
        child: view.getBigUint64(payloadOffset + 8, true),
      };
    case PtxOpcode.SetRoot:
      return { opcode, handle: handle() };
    case PtxOpcode.RemoveNode:
      return { opcode, handle: handle() };
    case PtxOpcode.CreateTranscript:
      return { opcode, handle: handle() };
    case PtxOpcode.OpenBlock:
      ensurePayload(payloadLength, 16);
      return {
        opcode,
        transcript: view.getBigUint64(payloadOffset, true),
        block: view.getBigUint64(payloadOffset + 8, true),
      };
    case PtxOpcode.SealBlock:
      return { opcode, handle: handle() };
    case PtxOpcode.CreateVirtualTranscript:
      ensurePayload(payloadLength, 16);
      return {
        opcode,
        handle: view.getBigUint64(payloadOffset, true),
        transcript: view.getBigUint64(payloadOffset + 8, true),
      };
    case PtxOpcode.CreateCanvas:
      return { opcode, handle: handle() };
    case PtxOpcode.SetCanvasFrame: {
      ensurePayload(payloadLength, 16);
      const canvasHandle = view.getBigUint64(payloadOffset, true);
      const width = view.getUint16(payloadOffset + 8, true);
      const height = view.getUint16(payloadOffset + 10, true);
      if (width === 0 || height === 0) {
        throw new PtxDecodeError("canvas dimensions must be non-zero");
      }
      const runCount = view.getUint32(payloadOffset + 12, true);
      const runs: CanvasRun[] = [];
      let cursor = payloadOffset + 16;
      const payloadEnd = payloadOffset + payloadLength;
      for (let index = 0; index < runCount; index += 1) {
        ensureRange(packet, cursor, 20);
        if (cursor + 20 > payloadEnd) throw new PtxDecodeError("canvas run header exceeds record bounds");
        const row = view.getUint16(cursor, true);
        const column = view.getUint16(cursor + 2, true);
        const attributes = view.getUint16(cursor + 4, true);
        if (packet[cursor + 6] !== 0 || packet[cursor + 7] !== 0) {
          throw new PtxDecodeError("non-zero canvas run padding");
        }
        const foreground = decodeColor(view.getUint32(cursor + 8, true));
        const background = decodeColor(view.getUint32(cursor + 12, true));
        const textLength = view.getUint32(cursor + 16, true);
        cursor += 20;
        if (cursor + textLength > payloadEnd) {
          throw new PtxDecodeError("canvas run text exceeds record bounds");
        }
        const text = decoder.decode(packet.subarray(cursor, cursor + textLength));
        cursor += textLength;
        if (row >= height || column >= width) {
          throw new PtxDecodeError("canvas run starts outside the frame");
        }
        if (text.length === 0 || /\r|\n/u.test(text)) {
          throw new PtxDecodeError("canvas run text is empty or multiline");
        }
        runs.push({ row, column, text, style: decodeStyle(attributes, foreground, background) });
      }
      if (packet.subarray(cursor, payloadEnd).some((byte) => byte !== 0)) {
        throw new PtxDecodeError("non-zero canvas frame padding");
      }
      return { opcode, handle: canvasHandle, frame: { width, height, runs } };
    }
    case PtxOpcode.SetCanvasRows: {
      ensurePayload(payloadLength, 24);
      const canvasHandle = view.getBigUint64(payloadOffset, true);
      const baseRevision = view.getBigUint64(payloadOffset + 8, true);
      const width = view.getUint16(payloadOffset + 16, true);
      const height = view.getUint16(payloadOffset + 18, true);
      if (width === 0 || height === 0) {
        throw new PtxDecodeError("canvas dimensions must be non-zero");
      }
      const rowCount = view.getUint32(payloadOffset + 20, true);
      if (rowCount === 0 || rowCount > height) {
        throw new PtxDecodeError("canvas row replacement count is zero or exceeds frame height");
      }
      const rows: CanvasRowReplacement[] = [];
      const payloadEnd = payloadOffset + payloadLength;
      let cursor = payloadOffset + 24;
      let previousRow = -1;
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (cursor + 8 > payloadEnd) {
          throw new PtxDecodeError("canvas row replacement header exceeds record bounds");
        }
        const row = view.getUint16(cursor, true);
        if (packet[cursor + 2] !== 0 || packet[cursor + 3] !== 0) {
          throw new PtxDecodeError("non-zero canvas row replacement padding");
        }
        if (row >= height) throw new PtxDecodeError("canvas row replacement is outside the frame");
        if (row <= previousRow) {
          throw new PtxDecodeError("canvas row replacements are not strictly increasing and unique");
        }
        previousRow = row;
        const runCount = view.getUint32(cursor + 4, true);
        cursor += 8;
        if (runCount > Math.floor((payloadEnd - cursor) / 16)) {
          throw new PtxDecodeError("impossible canvas row run count");
        }
        const runs: CanvasRowRun[] = [];
        for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
          if (cursor + 16 > payloadEnd) {
            throw new PtxDecodeError("canvas row run header exceeds record bounds");
          }
          const column = view.getUint16(cursor, true);
          const attributes = view.getUint16(cursor + 2, true);
          const foreground = decodeColor(view.getUint32(cursor + 4, true));
          const background = decodeColor(view.getUint32(cursor + 8, true));
          const textLength = view.getUint32(cursor + 12, true);
          cursor += 16;
          if (cursor + textLength > payloadEnd) {
            throw new PtxDecodeError("canvas row run text exceeds record bounds");
          }
          const text = decoder.decode(packet.subarray(cursor, cursor + textLength));
          cursor += textLength;
          if (column >= width) throw new PtxDecodeError("canvas row run starts outside the frame");
          if (text.length === 0 || /\r|\n/u.test(text)) {
            throw new PtxDecodeError("canvas row run text is empty or multiline");
          }
          runs.push({
            column,
            text,
            style: decodeStyle(attributes, foreground, background),
          });
        }
        rows.push({ row, runs });
      }
      if (packet.subarray(cursor, payloadEnd).some((byte) => byte !== 0)) {
        throw new PtxDecodeError("non-zero canvas row patch padding");
      }
      return {
        opcode,
        handle: canvasHandle,
        patch: { baseRevision, width, height, rows },
      };
    }
    case PtxOpcode.SetCursor: {
      ensurePayload(payloadLength, 16);
      const visibleByte = packet[payloadOffset + 4];
      if (visibleByte !== 0 && visibleByte !== 1) {
        throw new PtxDecodeError("invalid cursor visibility flag");
      }
      const shapeByte = packet[payloadOffset + 5];
      const shape = shapeByte === 0 ? "block" : shapeByte === 1 ? "underline" : shapeByte === 2 ? "bar" : undefined;
      if (shape === undefined) {
        throw new PtxDecodeError("invalid cursor shape");
      }
      if (
        packet.subarray(payloadOffset + 6, payloadOffset + 8).some((byte) => byte !== 0) ||
        packet.subarray(payloadOffset + 12, payloadOffset + payloadLength).some((byte) => byte !== 0)
      ) {
        throw new PtxDecodeError("non-zero SetCursor padding");
      }
      return {
        opcode,
        options: {
          row: view.getUint16(payloadOffset, true),
          column: view.getUint16(payloadOffset + 2, true),
          visible: visibleByte === 1,
          shape,
          color: decodeColor(view.getUint32(payloadOffset + 8, true)),
        },
      };
    }
    case PtxOpcode.SetEffectBus: {
      if (payloadLength !== 16) {
        throw new PtxDecodeError("SetEffectBus payload must be exactly 16 bytes");
      }
      if (packet[payloadOffset] !== 1) {
        throw new PtxDecodeError("unsupported effect bus profile");
      }
      const effectFlags = packet[payloadOffset + 1] ?? 0;
      if ((effectFlags & ~0x03) !== 0) {
        throw new PtxDecodeError("unknown required effect bus flag");
      }
      if (
        packet.subarray(payloadOffset + 2, payloadOffset + 4).some((byte) => byte !== 0) ||
        packet.subarray(payloadOffset + 13, payloadOffset + payloadLength).some((byte) => byte !== 0)
      ) {
        throw new PtxDecodeError("non-zero SetEffectBus padding");
      }
      const channel = (offset: number): EffectBusChannel => [
        packet[payloadOffset + offset] ?? 0,
        packet[payloadOffset + offset + 1] ?? 0,
        packet[payloadOffset + offset + 2] ?? 0,
      ];
      return {
        opcode,
        options: {
          profile: "ghostty-palette-v1",
          enabled: (effectFlags & 1) !== 0,
          trigger: (effectFlags & 2) !== 0,
          channels: [channel(4), channel(7), channel(10)],
        },
      };
    }
    default:
      throw new PtxDecodeError(`unknown required opcode ${opcode}`);
  }
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function align8(value: number): number {
  return (value + 7) & ~7;
}

function assertHandle(handle: bigint): void {
  if (handle <= 0n || handle > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("PTX handle must be a non-zero u64");
  }
}

function assertU64(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${name} must be a u64`);
  }
}

function assertU16(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be a u16`);
  }
}

function assertByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be a byte`);
  }
}

function encodeAttributes(style: TuiStyle | undefined): number {
  let attributes = 0;
  if (style?.bold) attributes |= 1 << 0;
  if (style?.dim) attributes |= 1 << 1;
  if (style?.italic) attributes |= 1 << 2;
  if (style?.underline) attributes |= 1 << 3;
  if (style?.blink) attributes |= 1 << 4;
  if (style?.reverse) attributes |= 1 << 5;
  if (style?.hidden) attributes |= 1 << 6;
  if (style?.strikethrough) attributes |= 1 << 7;
  return attributes;
}

function decodeStyle(attributes: number, foreground: TuiColor, background: TuiColor): TuiStyle {
  if (attributes & ~0xff) throw new PtxDecodeError("unknown required canvas style attribute");
  return {
    foreground,
    background,
    bold: (attributes & (1 << 0)) !== 0,
    dim: (attributes & (1 << 1)) !== 0,
    italic: (attributes & (1 << 2)) !== 0,
    underline: (attributes & (1 << 3)) !== 0,
    blink: (attributes & (1 << 4)) !== 0,
    reverse: (attributes & (1 << 5)) !== 0,
    hidden: (attributes & (1 << 6)) !== 0,
    strikethrough: (attributes & (1 << 7)) !== 0,
  };
}

function encodeColor(color: TuiColor | undefined): number {
  if (color === undefined || color.kind === "default") return 0;
  if (color.kind === "indexed") {
    if (!Number.isInteger(color.index) || color.index < 0 || color.index > 0xff) {
      throw new RangeError("indexed color must be between 0 and 255");
    }
    return (0x0100_0000 | color.index) >>> 0;
  }
  for (const [name, value] of [
    ["red", color.red],
    ["green", color.green],
    ["blue", color.blue],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`RGB ${name} component must be between 0 and 255`);
    }
  }
  return (0x0200_0000 | (color.red << 16) | (color.green << 8) | color.blue) >>> 0;
}

function decodeColor(packed: number): TuiColor {
  const kind = packed >>> 24;
  const value = packed & 0x00ff_ffff;
  if (kind === 0 && value === 0) return { kind: "default" };
  if (kind === 1 && value <= 0xff) return { kind: "indexed", index: value };
  if (kind === 2) {
    return {
      kind: "rgb",
      red: (value >>> 16) & 0xff,
      green: (value >>> 8) & 0xff,
      blue: value & 0xff,
    };
  }
  throw new PtxDecodeError("invalid packed color");
}

function ensureRange(packet: Uint8Array, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > packet.byteLength) {
    throw new PtxDecodeError("record exceeds packet bounds");
  }
}

function ensurePayload(actual: number, minimum: number): void {
  if (actual < minimum) throw new PtxDecodeError("operation payload is truncated");
}
