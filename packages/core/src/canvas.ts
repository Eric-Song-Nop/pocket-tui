import type { CanvasFrame, CanvasRun, TuiStyle } from "./protocol.js";

export interface CellBufferCell {
  readonly glyph: string;
  readonly style?: TuiStyle;
}

/**
 * Mutable fixed-size cell buffer with compact row-run serialization.
 *
 * This is intentionally terminal independent: it never emits ANSI and can be
 * used by games, charts, and custom widgets before handing a frame to Canvas.
 */
export class CellBuffer {
  readonly width: number;
  readonly height: number;
  readonly #cells: CellBufferCell[];

  constructor(width: number, height: number, fill: CellBufferCell = { glyph: " " }) {
    assertDimension(width, "width");
    assertDimension(height, "height");
    validateGlyph(fill.glyph);
    const area = width * height;
    if (!Number.isSafeInteger(area) || area > 1_000_000) {
      throw new RangeError("CellBuffer area must not exceed 1,000,000 cells");
    }
    this.width = width;
    this.height = height;
    this.#cells = Array.from({ length: width * height }, () => cloneCell(fill));
  }

  clear(fill: CellBufferCell = { glyph: " " }): this {
    validateGlyph(fill.glyph);
    for (let index = 0; index < this.#cells.length; index += 1) {
      this.#cells[index] = cloneCell(fill);
    }
    return this;
  }

  set(x: number, y: number, glyph: string, style?: TuiStyle): this {
    this.#cells[this.#index(x, y)] = { glyph: validateGlyph(glyph), style: cloneStyle(style) };
    return this;
  }

  text(x: number, y: number, text: string, style?: TuiStyle): this {
    if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= this.height) return this;
    let column = x;
    for (const glyph of text) {
      if (column >= 0 && column < this.width) this.set(column, y, glyph, style);
      column += 1;
      if (column >= this.width) break;
    }
    return this;
  }

  get(x: number, y: number): Readonly<CellBufferCell> {
    return this.#cells[this.#index(x, y)] as CellBufferCell;
  }

  frame(): CanvasFrame {
    const runs: CanvasRun[] = [];
    for (let row = 0; row < this.height; row += 1) {
      let column = 0;
      while (column < this.width) {
        const first = this.#cells[row * this.width + column] as CellBufferCell;
        let text = first.glyph;
        let end = column + 1;
        while (end < this.width) {
          const next = this.#cells[row * this.width + end] as CellBufferCell;
          if (!sameStyle(first.style, next.style)) break;
          text += next.glyph;
          end += 1;
        }
        if (first.style !== undefined || !/^ +$/u.test(text)) {
          runs.push({ row, column, text, style: cloneStyle(first.style) });
        }
        column = end;
      }
    }
    return { width: this.width, height: this.height, runs };
  }

  #index(x: number, y: number): number {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new RangeError(`cell (${x}, ${y}) is outside ${this.width}×${this.height}`);
    }
    return y * this.width + x;
  }
}

function assertDimension(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff) {
    throw new RangeError(`${name} must be an integer between 1 and 65535`);
  }
}

function validateGlyph(glyph: string): string {
  const values = [...glyph];
  const codePoint = glyph.codePointAt(0);
  if (
    glyph.length === 0 ||
    values.length !== 1 ||
    codePoint === undefined ||
    /[\p{Cc}\p{Cf}\p{Cs}\p{Mark}]/u.test(glyph) ||
    isWideCodePoint(codePoint)
  ) {
    throw new RangeError("a CellBuffer glyph must occupy exactly one terminal column");
  }
  return glyph;
}

// Mirrors the stable wide ranges used by common wcwidth implementations.
// Rich grapheme clusters and wide glyphs remain available through CanvasRun;
// CellBuffer deliberately has a simpler one-entry-per-column contract.
function isWideCodePoint(value: number): boolean {
  return (
    value >= 0x1100 &&
    (value <= 0x115f ||
      value === 0x2329 ||
      value === 0x232a ||
      (value >= 0x2e80 && value <= 0xa4cf && value !== 0x303f) ||
      (value >= 0xac00 && value <= 0xd7a3) ||
      (value >= 0xf900 && value <= 0xfaff) ||
      (value >= 0xfe10 && value <= 0xfe19) ||
      (value >= 0xfe30 && value <= 0xfe6f) ||
      (value >= 0xff00 && value <= 0xff60) ||
      (value >= 0xffe0 && value <= 0xffe6) ||
      (value >= 0x1f300 && value <= 0x1faff) ||
      (value >= 0x20000 && value <= 0x3fffd))
  );
}

function cloneCell(cell: CellBufferCell): CellBufferCell {
  return { glyph: cell.glyph, style: cloneStyle(cell.style) };
}

function cloneStyle(style: TuiStyle | undefined): TuiStyle | undefined {
  if (style === undefined) return undefined;
  return {
    ...style,
    foreground: style.foreground === undefined ? undefined : { ...style.foreground },
    background: style.background === undefined ? undefined : { ...style.background },
  };
}

function sameStyle(left: TuiStyle | undefined, right: TuiStyle | undefined): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}
