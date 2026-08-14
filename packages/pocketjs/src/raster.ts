import type { CanvasFrame, CanvasRun, TuiColor, TuiStyle } from "@pocket-tui/core";

import type { ComputedStyle, HostNode, LayoutResult, Rect } from "./model.js";
import { ENUM, NODE } from "./spec.js";
import { wrapText } from "./unicode.js";

interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

interface RasterCell {
  glyph: string;
  width: 1 | 2;
  style: TuiStyle;
  continuationOf?: number;
}

export type PocketTuiColorMode = "ansi16" | "truecolor";

export interface RasterResult {
  readonly frame: CanvasFrame;
  readonly paintOrder: readonly number[];
}

export function rasterize(
  root: HostNode,
  layout: LayoutResult,
  width: number,
  height: number,
  colorMode: PocketTuiColorMode = "ansi16",
): RasterResult {
  const cells = new Array<RasterCell | undefined>(width * height);
  const paintOrder: number[] = [];
  const viewport: Rect = { x: 0, y: 0, width, height };

  const paint = (node: HostNode, parentClip: Rect, inheritedOpacity: number): void => {
    const entry = layout.entries.get(node.id);
    if (entry === undefined || entry.style.display === ENUM.displayNone) return;
    const { rect, style } = entry;
    const opacity = clamp01(inheritedOpacity * style.opacity);
    if (opacity <= 0 || rect.width <= 0 || rect.height <= 0) return;
    const ownClip = intersect(parentClip, rect);
    if (ownClip === undefined) return;

    let painted = false;
    if (alpha(style.background) > 0) {
      fillBackground(cells, width, height, ownClip, style.background, opacity, colorMode);
      painted = true;
    }
    if (style.borderWidth >= 0.5 && alpha(style.borderColor) > 0) {
      paintBorder(cells, width, height, rect, ownClip, style.borderColor, opacity, colorMode);
      painted = true;
    }

    if (node.type === NODE.text) {
      const text = layout.flattenedText.get(node.id) ?? node.text;
      if (text.length > 0) {
        paintText(cells, width, height, rect, ownClip, text, style, opacity, colorMode);
        painted = true;
      }
    } else if (node.type === NODE.image) {
      paintText(cells, width, height, rect, ownClip, "▧", style, opacity, colorMode);
      painted = true;
    }
    if (painted) paintOrder.push(node.id);

    if (node.type !== NODE.view) return;
    const childClip = style.overflow === ENUM.overflowHidden ? ownClip : parentClip;
    const ordered = node.children
      .map((child, index) => ({ child, index, z: layout.entries.get(child.id)?.style.zIndex ?? 0 }))
      .sort((left, right) => left.z - right.z || left.index - right.index);
    for (const { child } of ordered) paint(child, childClip, opacity);
  };

  paint(root, viewport, 1);
  return { frame: compactFrame(cells, width, height), paintOrder };
}

function fillBackground(
  cells: Array<RasterCell | undefined>,
  width: number,
  height: number,
  rect: Rect,
  color: number,
  opacity: number,
  colorMode: PocketTuiColorMode,
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const existing = backgroundAt(cells, width, x, y);
      const background = composite(color, opacity, existing);
      writeCell(cells, width, height, x, y, " ", 1, {
        background: tuiColor(background, colorMode),
      });
    }
  }
}

function paintBorder(
  cells: Array<RasterCell | undefined>,
  width: number,
  height: number,
  rect: Rect,
  clip: Rect,
  color: number,
  opacity: number,
  colorMode: PocketTuiColorMode,
): void {
  if (rect.width < 1 || rect.height < 1) return;
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  const draw = (x: number, y: number, glyph: string): void => {
    if (!contains(clip, x, y)) return;
    const background = backgroundAt(cells, width, x, y);
    const foreground = composite(color, opacity, background);
    writeCell(cells, width, height, x, y, glyph, 1, {
      foreground: tuiColor(foreground, colorMode),
      background: tuiColor(background, colorMode),
    });
  };
  for (let x = rect.x + 1; x < right; x += 1) {
    draw(x, rect.y, "─");
    if (bottom !== rect.y) draw(x, bottom, "─");
  }
  for (let y = rect.y + 1; y < bottom; y += 1) {
    draw(rect.x, y, "│");
    if (right !== rect.x) draw(right, y, "│");
  }
  draw(rect.x, rect.y, rect.width === 1 ? "│" : rect.height === 1 ? "─" : "┌");
  if (right !== rect.x) draw(right, rect.y, rect.height === 1 ? "─" : "┐");
  if (bottom !== rect.y) draw(rect.x, bottom, rect.width === 1 ? "│" : "└");
  if (right !== rect.x && bottom !== rect.y) draw(right, bottom, "┘");
}

function paintText(
  cells: Array<RasterCell | undefined>,
  width: number,
  height: number,
  rect: Rect,
  clip: Rect,
  text: string,
  style: ComputedStyle,
  opacity: number,
  colorMode: PocketTuiColorMode,
): void {
  if (rect.width <= 0 || rect.height <= 0) return;
  const lines = wrapText(text, rect.width);
  const lineStep = Math.max(1, Math.round(style.lineHeight ?? 1));
  const tracking = Math.max(0, Math.round(style.tracking));
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const y = rect.y + lineIndex * lineStep;
    if (y >= rect.y + rect.height) break;
    const line = lines[lineIndex] ?? [];
    const lineWidth = line.reduce((sum, item, index) => sum + item.width + (index === line.length - 1 ? 0 : tracking), 0);
    let x = rect.x;
    if (style.textAlign === ENUM.textCenter) x += Math.max(0, Math.floor((rect.width - lineWidth) / 2));
    if (style.textAlign === ENUM.textRight) x += Math.max(0, rect.width - lineWidth);
    for (const grapheme of line) {
      if (grapheme.width === 0) continue;
      if (contains(clip, x, y) && (grapheme.width === 1 || contains(clip, x + 1, y))) {
        const background = backgroundAt(cells, width, x, y);
        const foreground = composite(style.textColor, opacity, background);
        writeCell(cells, width, height, x, y, grapheme.text, grapheme.width, {
          foreground: tuiColor(foreground, colorMode),
          background: tuiColor(background, colorMode),
        });
      }
      x += grapheme.width + tracking;
      if (x >= rect.x + rect.width) break;
    }
  }
}

function writeCell(
  cells: Array<RasterCell | undefined>,
  width: number,
  height: number,
  x: number,
  y: number,
  glyph: string,
  glyphWidth: 1 | 2,
  style: TuiStyle,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height || (glyphWidth === 2 && x + 1 >= width)) return;
  clearOwnedCell(cells, width, x, y);
  if (glyphWidth === 2) clearOwnedCell(cells, width, x + 1, y);
  cells[y * width + x] = { glyph, width: glyphWidth, style };
  if (glyphWidth === 2) cells[y * width + x + 1] = { glyph: "", width: 1, style, continuationOf: x };
}

function clearOwnedCell(cells: Array<RasterCell | undefined>, width: number, x: number, y: number): void {
  const index = y * width + x;
  const cell = cells[index];
  if (cell === undefined) return;
  if (cell.continuationOf !== undefined) {
    const leadIndex = y * width + cell.continuationOf;
    cells[leadIndex] = undefined;
    cells[index] = undefined;
    return;
  }
  if (cell.width === 2 && x + 1 < width) cells[index + 1] = undefined;
  cells[index] = undefined;
}

function compactFrame(cells: Array<RasterCell | undefined>, width: number, height: number): CanvasFrame {
  const runs: CanvasRun[] = [];
  for (let row = 0; row < height; row += 1) {
    let column = 0;
    while (column < width) {
      const cell = cells[row * width + column];
      if (cell === undefined || cell.continuationOf !== undefined) {
        column += 1;
        continue;
      }
      const start = column;
      const style = cell.style;
      let text = "";
      while (column < width) {
        const next = cells[row * width + column];
        if (next === undefined || next.continuationOf !== undefined || !sameStyle(style, next.style)) break;
        text += next.glyph;
        column += next.width;
      }
      runs.push({ row, column: start, text, style });
    }
  }
  return { width, height, runs };
}

function backgroundAt(cells: Array<RasterCell | undefined>, width: number, x: number, y: number): Rgb {
  const color = cells[y * width + x]?.style.background;
  if (color?.kind === "rgb") return { red: color.red, green: color.green, blue: color.blue };
  if (color?.kind === "indexed") return ansiColor(color.index);
  return { red: 0, green: 0, blue: 0 };
}

function composite(color: number, opacity: number, backdrop: Rgb): Rgb {
  const source = abgr(color);
  const weight = clamp01((source.alpha / 255) * opacity);
  return {
    red: Math.round(source.red * weight + backdrop.red * (1 - weight)),
    green: Math.round(source.green * weight + backdrop.green * (1 - weight)),
    blue: Math.round(source.blue * weight + backdrop.blue * (1 - weight)),
  };
}

function abgr(color: number): Rgb & { alpha: number } {
  const value = color >>> 0;
  return {
    red: value & 0xff,
    green: (value >>> 8) & 0xff,
    blue: (value >>> 16) & 0xff,
    alpha: (value >>> 24) & 0xff,
  };
}

function alpha(color: number): number {
  return (color >>> 24) & 0xff;
}

function tuiColor(color: Rgb, colorMode: PocketTuiColorMode): TuiColor {
  if (colorMode === "truecolor") {
    return { kind: "rgb", red: color.red, green: color.green, blue: color.blue };
  }
  return { kind: "indexed", index: nearestAnsi16(color) };
}

function ansiColor(index: number): Rgb {
  return ANSI16[index & 0x0f] ?? ANSI16[0];
}

function nearestAnsi16(color: Rgb): number {
  let closest = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ANSI16.length; index += 1) {
    const candidate = ANSI16[index]!;
    const red = color.red - candidate.red;
    const green = color.green - candidate.green;
    const blue = color.blue - candidate.blue;
    const distance = red * red + green * green + blue * blue;
    if (distance < closestDistance) {
      closest = index;
      closestDistance = distance;
    }
  }
  return closest;
}

const ANSI16: readonly [
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
  Rgb,
] = [
  { red: 0, green: 0, blue: 0 },
  { red: 205, green: 49, blue: 49 },
  { red: 13, green: 188, blue: 121 },
  { red: 229, green: 229, blue: 16 },
  { red: 36, green: 114, blue: 200 },
  { red: 188, green: 63, blue: 188 },
  { red: 17, green: 168, blue: 205 },
  { red: 229, green: 229, blue: 229 },
  { red: 102, green: 102, blue: 102 },
  { red: 241, green: 76, blue: 76 },
  { red: 35, green: 209, blue: 139 },
  { red: 245, green: 245, blue: 67 },
  { red: 59, green: 142, blue: 234 },
  { red: 214, green: 112, blue: 214 },
  { red: 41, green: 184, blue: 219 },
  { red: 255, green: 255, blue: 255 },
];

function intersect(left: Rect, right: Rect): Rect | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) return undefined;
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function sameStyle(left: TuiStyle, right: TuiStyle): boolean {
  return colorKey(left.foreground) === colorKey(right.foreground) && colorKey(left.background) === colorKey(right.background);
}

function colorKey(color: TuiColor | undefined): string {
  if (color === undefined) return "";
  if (color.kind === "default") return "d";
  if (color.kind === "indexed") return `i${color.index}`;
  return `r${color.red},${color.green},${color.blue}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
