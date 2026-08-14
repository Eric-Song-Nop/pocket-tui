import {
  FLOAT_PROPS,
  STYLE_ACTIVE,
  STYLE_ANIMATION,
  STYLE_BASE,
  STYLE_FOCUS,
  STYLE_HEADER_BYTES,
  STYLE_MAGIC,
  STYLE_PROP_BYTES,
  STYLE_TRANSITION,
  STYLE_TRANSITION_BYTES,
  STYLE_VERSION,
} from "./spec.js";

export type PropertyMap = Map<number, number>;

export interface HostStyleRecord {
  readonly base: PropertyMap;
  readonly focus: PropertyMap;
  readonly active: PropertyMap;
}

export function parseStyleTable(bytes: Uint8Array): HostStyleRecord[] {
  if (bytes.byteLength < STYLE_HEADER_BYTES) throw new Error("PocketTUI: truncated PocketJS style table");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== STYLE_MAGIC) throw new Error("PocketTUI: invalid PocketJS style magic");
  if (view.getUint16(4, true) !== STYLE_VERSION) {
    throw new Error(`PocketTUI: unsupported PocketJS style version ${view.getUint16(4, true)}`);
  }
  const count = view.getUint16(6, true);
  let offset = STYLE_HEADER_BYTES;
  const styles: HostStyleRecord[] = [];

  for (let index = 0; index < count; index += 1) {
    ensure(bytes, offset, 1, `style ${index} flags`);
    const flags = bytes[offset++] as number;
    if ((flags & 0xe0) !== 0) throw new Error(`PocketTUI: style ${index} uses reserved flags`);
    if ((flags & STYLE_TRANSITION) !== 0) {
      ensure(bytes, offset, STYLE_TRANSITION_BYTES, `style ${index} transition`);
      offset += STYLE_TRANSITION_BYTES;
    }
    if ((flags & STYLE_ANIMATION) !== 0) {
      ensure(bytes, offset, 3, `style ${index} animation`);
      const references = bytes[offset] as number;
      if (references === 0) throw new Error(`PocketTUI: style ${index} has an empty animation list`);
      ensure(bytes, offset, 3 + references * 2, `style ${index} animation references`);
      offset += 3 + references * 2;
    }

    const record: HostStyleRecord = {
      base: new Map(),
      focus: new Map(),
      active: new Map(),
    };
    for (const [flag, target] of [
      [STYLE_BASE, record.base],
      [STYLE_FOCUS, record.focus],
      [STYLE_ACTIVE, record.active],
    ] as const) {
      if ((flags & flag) === 0) continue;
      ensure(bytes, offset, 1, `style ${index} variant count`);
      const propCount = bytes[offset++] as number;
      ensure(bytes, offset, propCount * STYLE_PROP_BYTES, `style ${index} variant properties`);
      for (let property = 0; property < propCount; property += 1) {
        const id = bytes[offset] as number;
        if (bytes[offset + 1] !== 0) {
          throw new Error(`PocketTUI: style ${index} property ${id} uses a reserved byte`);
        }
        const raw = view.getUint32(offset + 2, true);
        target.set(id, decodeStyleValue(id, raw));
        offset += STYLE_PROP_BYTES;
      }
    }
    styles.push(record);
  }

  // Animation timelines follow the style records. The reference backend
  // deliberately collapses animations to their explicit animate() endpoint,
  // so it need not retain or interpret those bytes.
  return styles;
}

function decodeStyleValue(property: number, raw: number): number {
  if (!FLOAT_PROPS.has(property)) return raw >>> 0;
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setUint32(0, raw, true);
  return view.getFloat32(0, true);
}

function ensure(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new Error(`PocketTUI: invalid ${label} range`);
  }
  if (offset + length > bytes.byteLength) throw new Error(`PocketTUI: truncated ${label}`);
}
