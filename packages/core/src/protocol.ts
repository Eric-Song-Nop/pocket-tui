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
}

export type BoxDirection = "column" | "row";

export interface BoxPacketOptions {
  direction?: BoxDirection;
  border?: boolean;
  padding?: number;
}

export type DecodedPtxOperation =
  | { opcode: PtxOpcode.CreateBox; handle: bigint; options: Required<BoxPacketOptions> }
  | { opcode: PtxOpcode.CreateText; handle: bigint; text: string }
  | { opcode: PtxOpcode.AppendChild; parent: bigint; child: bigint }
  | { opcode: PtxOpcode.SetRoot; handle: bigint }
  | { opcode: PtxOpcode.SetText; handle: bigint; text: string }
  | { opcode: PtxOpcode.AppendText; handle: bigint; text: string }
  | { opcode: PtxOpcode.RemoveNode; handle: bigint };

export interface DecodedPtxPacket {
  major: number;
  flags: number;
  sequence: bigint;
  operations: DecodedPtxOperation[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

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
    case PtxOpcode.AppendText: {
      ensurePayload(payloadLength, 16);
      const textLength = view.getUint32(payloadOffset + 8, true);
      ensurePayload(payloadLength, 16 + textLength);
      const text = decoder.decode(packet.subarray(payloadOffset + 16, payloadOffset + 16 + textLength));
      if (opcode === PtxOpcode.CreateText) return { opcode, handle: handle(), text };
      if (opcode === PtxOpcode.SetText) return { opcode, handle: handle(), text };
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

function assertU16(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be a u16`);
  }
}

function ensureRange(packet: Uint8Array, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > packet.byteLength) {
    throw new PtxDecodeError("record exceeds packet bounds");
  }
}

function ensurePayload(actual: number, minimum: number): void {
  if (actual < minimum) throw new PtxDecodeError("operation payload is truncated");
}
