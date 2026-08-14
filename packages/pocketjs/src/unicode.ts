export interface GraphemeCell {
  readonly text: string;
  readonly width: 0 | 1 | 2;
}

type SegmenterLike = {
  segment(value: string): Iterable<{ segment: string }>;
};

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => SegmenterLike;

const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
const segmenter = Segmenter === undefined ? undefined : new Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(value: string): GraphemeCell[] {
  const segments = segmenter === undefined ? [...value] : [...segmenter.segment(value)].map((item) => item.segment);
  return segments.map((text) => ({ text, width: graphemeWidth(text) }));
}

export function lineWidth(value: string): number {
  let width = 0;
  let maximum = 0;
  for (const grapheme of graphemes(value)) {
    if (grapheme.text.includes("\n")) {
      maximum = Math.max(maximum, width);
      width = 0;
    } else {
      width += grapheme.width;
    }
  }
  return Math.max(maximum, width);
}

export function textExtent(value: string, maxWidth = Number.MAX_SAFE_INTEGER): { width: number; height: number } {
  const limit = Math.max(1, Math.floor(maxWidth));
  let width = 0;
  let maximum = 0;
  let height = 1;
  for (const grapheme of graphemes(value)) {
    if (grapheme.text.includes("\n")) {
      maximum = Math.max(maximum, width);
      width = 0;
      height += 1;
      continue;
    }
    if (grapheme.width > 0 && width > 0 && width + grapheme.width > limit) {
      maximum = Math.max(maximum, width);
      width = 0;
      height += 1;
    }
    width += grapheme.width;
  }
  return { width: Math.min(limit, Math.max(maximum, width)), height };
}

export function wrapText(value: string, maxWidth: number): GraphemeCell[][] {
  const limit = Math.max(1, Math.floor(maxWidth));
  const lines: GraphemeCell[][] = [[]];
  let width = 0;
  for (const grapheme of graphemes(value)) {
    if (grapheme.text.includes("\n")) {
      lines.push([]);
      width = 0;
      continue;
    }
    if (grapheme.width > 0 && width > 0 && width + grapheme.width > limit) {
      lines.push([]);
      width = 0;
    }
    if (grapheme.width > limit) continue;
    (lines[lines.length - 1] as GraphemeCell[]).push(grapheme);
    width += grapheme.width;
  }
  return lines;
}

export function graphemeWidth(value: string): 0 | 1 | 2 {
  let width: 0 | 1 | 2 = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined || isZeroWidth(point)) continue;
    if (isWideCodePoint(point)) return 2;
    width = 1;
  }
  return width;
}

function isZeroWidth(value: number): boolean {
  return (
    value === 0x200b ||
    value === 0x200c ||
    value === 0x200d ||
    value === 0xfe0e ||
    value === 0xfe0f ||
    (value >= 0x0300 && value <= 0x036f) ||
    (value >= 0x1ab0 && value <= 0x1aff) ||
    (value >= 0x1dc0 && value <= 0x1dff) ||
    (value >= 0x20d0 && value <= 0x20ff) ||
    (value >= 0xfe20 && value <= 0xfe2f)
  );
}

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
