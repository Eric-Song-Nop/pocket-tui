import type { ComputedStyle, HostNode, LayoutEntry, LayoutResult, Rect } from "./model.js";
import { ENUM, NODE, SIZE_FULL } from "./spec.js";
import { textExtent } from "./unicode.js";

export type StyleResolver = (node: HostNode) => ComputedStyle;

interface Measured {
  width: number;
  height: number;
}

interface MeasurementBucket {
  /** Snapshot, rather than a live node lookup, for transactional cache safety. */
  readonly revision: number;
  readonly values: ReadonlyMap<string, Measured>;
}

/** Opaque, immutable-by-convention state carried between successful frames. */
export interface LayoutCache {
  readonly measurements: ReadonlyMap<number, MeasurementBucket>;
  readonly geometryRevisions: ReadonlyMap<number, number>;
  readonly textRevisions: ReadonlyMap<number, number>;
  readonly subtreeEntryCounts: ReadonlyMap<number, number>;
}

export interface LayoutPass {
  readonly result: LayoutResult;
  readonly cache: LayoutCache;
  /** Entries whose layout function actually ran. */
  readonly laidOutNodes: number;
  /** Entries copied or retained from an exact geometry-cache hit. */
  readonly reusedNodes: number;
  /** Distinct nodes whose intrinsic measurement was computed. */
  readonly measuredNodes: number;
  readonly measurementCacheHits: number;
}

interface FlexItem {
  node: HostNode;
  style: ComputedStyle;
  measured: Measured;
  main: number;
  cross: number;
  marginMainBefore: number;
  marginMainAfter: number;
  marginCrossBefore: number;
  marginCrossAfter: number;
}

interface LayoutEngine {
  readonly layout: (node: HostNode, rect: Rect) => number;
  readonly layoutAbsolute: (node: HostNode, inner: Rect) => number;
  readonly result: () => LayoutPass;
}

interface LayoutEngineOptions {
  readonly previous?: LayoutResult;
  readonly cache?: LayoutCache;
  /** Full passes intentionally ignore old geometry while still using one solver. */
  readonly reuseGeometry?: boolean;
  /** Partial passes return only entries and text belonging to the requested root. */
  readonly partial?: boolean;
}

const MAX_MEASUREMENTS_PER_NODE = 8;

export function layoutTree(
  root: HostNode,
  columns: number,
  rows: number,
  resolveStyle: StyleResolver,
): LayoutResult {
  return layoutTreeCached(root, columns, rows, resolveStyle).result;
}

/** Performs a full pass and returns the exact caches needed by later frames. */
export function layoutTreeCached(
  root: HostNode,
  columns: number,
  rows: number,
  resolveStyle: StyleResolver,
): LayoutPass {
  const engine = createLayoutEngine(resolveStyle);
  engine.layout(root, { x: 0, y: 0, width: columns, height: rows });
  return engine.result();
}

/**
 * Re-runs the normal root solver but skips clean subtrees whose assigned size
 * and retained revision still exactly match the last successfully presented
 * frame. A changed position with the same size translates cached geometry.
 */
export function layoutTreeIncremental(
  root: HostNode,
  columns: number,
  rows: number,
  resolveStyle: StyleResolver,
  previous: LayoutResult,
  cache: LayoutCache,
): LayoutPass {
  const engine = createLayoutEngine(resolveStyle, {
    previous,
    cache,
    reuseGeometry: true,
  });
  engine.layout(root, { x: 0, y: 0, width: columns, height: rows });
  return engine.result();
}

/**
 * Lays out one absolute-positioned subtree against a cached parent entry.
 *
 * Absolute children do not participate in their parent's flex sizing, so this
 * produces the same subtree entries as a full layout while leaving the parent
 * and its other children untouched. Callers are responsible for ensuring that
 * the cached parent geometry is still valid.
 */
export function layoutAbsoluteSubtree(
  root: HostNode,
  parent: LayoutEntry,
  resolveStyle: StyleResolver,
): LayoutResult {
  return layoutAbsoluteSubtreeCached(root, parent, resolveStyle).result;
}

/**
 * Cached form of {@link layoutAbsoluteSubtree}. The returned cache is a
 * complete replacement for the input cache, while the returned LayoutResult
 * remains a partial subtree result suitable for the host's existing merge.
 */
export function layoutAbsoluteSubtreeCached(
  root: HostNode,
  parent: LayoutEntry,
  resolveStyle: StyleResolver,
  previous?: LayoutResult,
  cache?: LayoutCache,
): LayoutPass {
  if (parent.node.type !== NODE.view) {
    throw new TypeError("absolute subtrees require a view parent");
  }

  const engine = createLayoutEngine(resolveStyle, {
    previous,
    cache,
    reuseGeometry: previous !== undefined && cache !== undefined,
    partial: true,
  });
  const inner = innerRect(parent.rect, parent.style);
  const style = resolveStyle(root);
  if (style.display === ENUM.displayNone) {
    engine.layout(root, { x: inner.x, y: inner.y, width: 0, height: 0 });
  } else {
    if (style.position !== ENUM.absolute) {
      throw new TypeError("localized subtree root must be absolutely positioned");
    }
    engine.layoutAbsolute(root, inner);
  }
  return engine.result();
}

function createLayoutEngine(resolveStyle: StyleResolver, options: LayoutEngineOptions = {}): LayoutEngine {
  const entries = options.partial
    ? new Map<number, LayoutEntry>()
    : new Map<number, LayoutEntry>(options.previous?.entries);
  const flattenedText = options.partial
    ? new Map<number, string>()
    : new Map<number, string>(options.previous?.flattenedText);
  const measurements = new Map<number, MeasurementBucket>(options.cache?.measurements);
  const geometryRevisions = new Map<number, number>(options.cache?.geometryRevisions);
  const textRevisions = new Map<number, number>(options.cache?.textRevisions);
  const subtreeEntryCounts = new Map<number, number>(options.cache?.subtreeEntryCounts);
  let laidOutNodes = 0;
  let reusedNodes = 0;
  const measuredNodeIds = new Set<number>();
  let measurementCacheHits = 0;

  function textFor(node: HostNode): string {
    let cached = flattenedText.get(node.id);
    if (cached === undefined && options.partial) {
      cached = options.previous?.flattenedText.get(node.id);
    }
    if (cached !== undefined && textRevisions.get(node.id) === node.layoutRevision) {
      flattenedText.set(node.id, cached);
      return cached;
    }
    let value = node.text;
    for (const child of node.children) value += textFor(child);
    flattenedText.set(node.id, value);
    textRevisions.set(node.id, node.layoutRevision);
    return value;
  }

  function measure(node: HostNode, availableWidth: number, availableHeight: number): Measured {
    const boundedWidth = Math.max(0, availableWidth);
    const boundedHeight = Math.max(0, availableHeight);
    const key = measurementKey(boundedWidth, boundedHeight);
    const bucket = measurements.get(node.id);
    if (bucket?.revision === node.layoutRevision) {
      const cached = bucket.values.get(key);
      if (cached !== undefined) {
        measurementCacheHits += 1;
        return cached;
      }
    }

    measuredNodeIds.add(node.id);
    const style = resolveStyle(node);
    let measured: Measured;
    if (style.display === ENUM.displayNone) {
      measured = { width: 0, height: 0 };
      rememberMeasurement(node, key, measured, bucket);
      return measured;
    }
    let natural: Measured;
    if (node.type === NODE.text) {
      natural = textExtent(textFor(node), Math.max(1, boundedWidth));
      if (style.lineHeight !== undefined) {
        natural.height = Math.max(natural.height, cells(style.lineHeight));
      }
    } else if (node.type === NODE.image) {
      natural = { width: 1, height: 1 };
    } else {
      const innerWidth = Math.max(0, boundedWidth - style.padding.left - style.padding.right);
      const innerHeight = Math.max(0, boundedHeight - style.padding.top - style.padding.bottom);
      const children = node.children.filter((child) => {
        const childStyle = resolveStyle(child);
        return childStyle.display !== ENUM.displayNone && childStyle.position !== ENUM.absolute;
      });
      let main = 0;
      let cross = 0;
      for (const child of children) {
        const childStyle = resolveStyle(child);
        const childSize = measure(child, innerWidth, innerHeight);
        if (style.flexDirection === ENUM.flexRow) {
          main += childSize.width + childStyle.margin.left + childStyle.margin.right;
          cross = Math.max(cross, childSize.height + childStyle.margin.top + childStyle.margin.bottom);
        } else {
          main += childSize.height + childStyle.margin.top + childStyle.margin.bottom;
          cross = Math.max(cross, childSize.width + childStyle.margin.left + childStyle.margin.right);
        }
      }
      if (children.length > 1) main += style.gap * (children.length - 1);
      natural =
        style.flexDirection === ENUM.flexRow
          ? {
              width: main + style.padding.left + style.padding.right,
              height: cross + style.padding.top + style.padding.bottom,
            }
          : {
              width: cross + style.padding.left + style.padding.right,
              height: main + style.padding.top + style.padding.bottom,
            };
    }
    measured = {
      width: resolveDimension(style.width, natural.width, boundedWidth, style.minWidth, style.maxWidth),
      height: resolveDimension(style.height, natural.height, boundedHeight, style.minHeight, style.maxHeight),
    };
    rememberMeasurement(node, key, measured, bucket);
    return measured;
  }

  function rememberMeasurement(
    node: HostNode,
    key: string,
    measured: Measured,
    previousBucket: MeasurementBucket | undefined,
  ): void {
    const values =
      previousBucket?.revision === node.layoutRevision
        ? new Map(previousBucket.values)
        : new Map<string, Measured>();
    // Refresh overwritten keys and bound animated constraint churn per node.
    values.delete(key);
    values.set(key, measured);
    while (values.size > MAX_MEASUREMENTS_PER_NODE) {
      const oldest = values.keys().next().value;
      if (oldest === undefined) break;
      values.delete(oldest);
    }
    measurements.set(node.id, { revision: node.layoutRevision, values });
  }

  function layout(node: HostNode, rect: Rect): number {
    const normalized = normalizeRect(rect);
    const previousEntry = options.previous?.entries.get(node.id);
    if (
      options.reuseGeometry === true &&
      previousEntry !== undefined &&
      geometryRevisions.get(node.id) === node.layoutRevision &&
      previousEntry.rect.width === normalized.width &&
      previousEntry.rect.height === normalized.height
    ) {
      let count = subtreeEntryCounts.get(node.id) ?? 1;
      const dx = normalized.x - previousEntry.rect.x;
      const dy = normalized.y - previousEntry.rect.y;
      if (options.partial || dx !== 0 || dy !== 0) {
        count = copySubtree(node, dx, dy);
      }
      reusedNodes += count;
      return count;
    }

    laidOutNodes += 1;
    const style = resolveStyle(node);
    entries.set(node.id, { node, style, rect: normalized });
    if (
      style.display === ENUM.displayNone ||
      normalized.width === 0 ||
      normalized.height === 0 ||
      node.type !== NODE.view
    ) {
      if (node.type === NODE.text) textFor(node);
      removeDescendantResults(node, style.display === ENUM.displayNone);
      geometryRevisions.set(node.id, node.layoutRevision);
      subtreeEntryCounts.set(node.id, 1);
      return 1;
    }

    const inner = innerRect(normalized, style);
    let count = 1;
    const relative: HostNode[] = [];
    const absolute: HostNode[] = [];
    for (const child of node.children) {
      const childStyle = resolveStyle(child);
      if (childStyle.display === ENUM.displayNone) {
        count += layout(child, { x: inner.x, y: inner.y, width: 0, height: 0 });
      } else if (childStyle.position === ENUM.absolute) {
        absolute.push(child);
      } else {
        relative.push(child);
      }
    }

    count += layoutFlexChildren(relative, inner, style, measure, layout, resolveStyle);
    for (const child of absolute) {
      count += layoutAbsolute(child, inner);
    }
    geometryRevisions.set(node.id, node.layoutRevision);
    subtreeEntryCounts.set(node.id, count);
    return count;
  }

  function layoutAbsolute(node: HostNode, inner: Rect): number {
    const style = resolveStyle(node);
    const measured = measure(node, inner.width, inner.height);
    const left = style.inset.left;
    const right = style.inset.right;
    const top = style.inset.top;
    const bottom = style.inset.bottom;
    const width = resolveAbsoluteSize(
      style.width,
      measured.width,
      inner.width,
      left,
      right,
      style.minWidth,
      style.maxWidth,
    );
    const height = resolveAbsoluteSize(
      style.height,
      measured.height,
      inner.height,
      top,
      bottom,
      style.minHeight,
      style.maxHeight,
    );
    const x =
      left !== undefined
        ? inner.x + cells(left) + style.margin.left
        : right !== undefined
          ? inner.x + inner.width - cells(right) - width - style.margin.right
          : inner.x + style.margin.left;
    const y =
      top !== undefined
        ? inner.y + cells(top) + style.margin.top
        : bottom !== undefined
          ? inner.y + inner.height - cells(bottom) - height - style.margin.bottom
          : inner.y + style.margin.top;
    return layout(node, { x, y, width, height });
  }

  function copySubtree(node: HostNode, dx: number, dy: number): number {
    const previousEntry = options.previous?.entries.get(node.id);
    if (previousEntry === undefined) return 0;
    entries.set(
      node.id,
      dx === 0 && dy === 0
        ? previousEntry
        : {
            node,
            style: previousEntry.style,
            rect: {
              x: previousEntry.rect.x + dx,
              y: previousEntry.rect.y + dy,
              width: previousEntry.rect.width,
              height: previousEntry.rect.height,
            },
          },
    );
    const previousText = options.previous?.flattenedText.get(node.id);
    if (previousText !== undefined) flattenedText.set(node.id, previousText);
    let count = 1;
    for (const child of node.children) count += copySubtree(child, dx, dy);
    return count;
  }

  function removeDescendantResults(node: HostNode, removeText: boolean): void {
    for (const child of node.children) {
      entries.delete(child.id);
      if (removeText) flattenedText.delete(child.id);
      removeDescendantResults(child, removeText);
    }
  }

  return {
    layout,
    layoutAbsolute,
    result: () => ({
      result: { entries, flattenedText },
      cache: { measurements, geometryRevisions, textRevisions, subtreeEntryCounts },
      laidOutNodes,
      reusedNodes,
      measuredNodes: measuredNodeIds.size,
      measurementCacheHits,
    }),
  };
}

function layoutFlexChildren(
  children: HostNode[],
  inner: Rect,
  parentStyle: ComputedStyle,
  measure: (node: HostNode, width: number, height: number) => Measured,
  layout: (node: HostNode, rect: Rect) => number,
  resolveStyle: StyleResolver,
): number {
  if (children.length === 0) return 0;
  const row = parentStyle.flexDirection === ENUM.flexRow;
  const availableMain = row ? inner.width : inner.height;
  const availableCross = row ? inner.height : inner.width;
  const items: FlexItem[] = children.map((node) => {
    const style = resolveStyle(node);
    const measured = measure(node, inner.width, inner.height);
    const requestedMain = style.basis ?? (row ? style.width : style.height);
    const requestedCross = row ? style.height : style.width;
    const main = resolveDimension(
      requestedMain,
      row ? measured.width : measured.height,
      availableMain,
      row ? style.minWidth : style.minHeight,
      row ? style.maxWidth : style.maxHeight,
    );
    const cross = resolveDimension(
      requestedCross,
      row ? measured.height : measured.width,
      availableCross,
      row ? style.minHeight : style.minWidth,
      row ? style.maxHeight : style.maxWidth,
    );
    return {
      node,
      style,
      measured,
      main,
      cross,
      marginMainBefore: row ? style.margin.left : style.margin.top,
      marginMainAfter: row ? style.margin.right : style.margin.bottom,
      marginCrossBefore: row ? style.margin.top : style.margin.left,
      marginCrossAfter: row ? style.margin.bottom : style.margin.right,
    };
  });

  const base = items.reduce(
    (sum, item) => sum + item.main + item.marginMainBefore + item.marginMainAfter,
    parentStyle.gap * Math.max(0, items.length - 1),
  );
  let free = availableMain - base;
  if (free > 0) {
    const grow = items.reduce((sum, item) => sum + Math.max(0, item.style.grow), 0);
    if (grow > 0) {
      let remaining = free;
      let remainingWeight = grow;
      for (const item of items) {
        const weight = Math.max(0, item.style.grow);
        if (weight === 0) continue;
        const share = remainingWeight === weight ? remaining : Math.floor((remaining * weight) / remainingWeight);
        item.main += share;
        remaining -= share;
        remainingWeight -= weight;
      }
      free = 0;
    }
  } else if (free < 0) {
    const deficit = -free;
    const shrink = items.reduce((sum, item) => sum + Math.max(0, item.style.shrink) * item.main, 0);
    if (shrink > 0) {
      let remaining = deficit;
      let remainingWeight = shrink;
      for (const item of items) {
        const weight = Math.max(0, item.style.shrink) * item.main;
        if (weight === 0) continue;
        const share = remainingWeight === weight ? remaining : Math.floor((remaining * weight) / remainingWeight);
        const applied = Math.min(item.main, share);
        item.main -= applied;
        remaining -= applied;
        remainingWeight -= weight;
      }
    }
    free = 0;
  }

  let cursor = 0;
  let extraGap = 0;
  const positiveFree = Math.max(0, free);
  switch (parentStyle.justify) {
    case ENUM.justifyCenter:
      cursor = Math.floor(positiveFree / 2);
      break;
    case ENUM.justifyEnd:
      cursor = positiveFree;
      break;
    case ENUM.justifyBetween:
      extraGap = items.length > 1 ? Math.floor(positiveFree / (items.length - 1)) : 0;
      break;
    case ENUM.justifyAround:
      extraGap = Math.floor(positiveFree / items.length);
      cursor = Math.floor(extraGap / 2);
      break;
    default:
      break;
  }

  let count = 0;
  for (const item of items) {
    cursor += item.marginMainBefore;
    const crossAvailable = Math.max(0, availableCross - item.marginCrossBefore - item.marginCrossAfter);
    const explicitCross = row ? item.style.height : item.style.width;
    const cross =
      parentStyle.align === ENUM.alignStretch && explicitCross === undefined
        ? crossAvailable
        : Math.min(crossAvailable, item.cross);
    let crossOffset = item.marginCrossBefore;
    if (parentStyle.align === ENUM.alignCenter) {
      crossOffset += Math.floor((crossAvailable - cross) / 2);
    } else if (parentStyle.align === ENUM.alignEnd) {
      crossOffset += crossAvailable - cross;
    }
    const rect: Rect = row
      ? { x: inner.x + cursor, y: inner.y + crossOffset, width: item.main, height: cross }
      : { x: inner.x + crossOffset, y: inner.y + cursor, width: cross, height: item.main };
    count += layout(item.node, rect);
    cursor += item.main + item.marginMainAfter + parentStyle.gap + extraGap;
  }
  return count;
}

function measurementKey(width: number, height: number): string {
  return `${width}:${height}`;
}

function resolveAbsoluteSize(
  requested: number | undefined,
  natural: number,
  available: number,
  before: number | undefined,
  after: number | undefined,
  minimum: number | undefined,
  maximum: number | undefined,
): number {
  const inferred =
    requested === undefined && before !== undefined && after !== undefined
      ? Math.max(0, available - cells(before) - cells(after))
      : natural;
  return resolveDimension(requested, inferred, available, minimum, maximum);
}

function resolveDimension(
  requested: number | undefined,
  natural: number,
  available: number,
  minimum: number | undefined,
  maximum: number | undefined,
): number {
  let value = requested === undefined ? natural : requested < 0 || requested === SIZE_FULL ? available : cells(requested);
  if (minimum !== undefined) value = Math.max(value, cells(minimum));
  if (maximum !== undefined) value = Math.min(value, cells(maximum));
  return Math.max(0, Math.min(available, cells(value)));
}

function cells(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function innerRect(rect: Rect, style: ComputedStyle): Rect {
  return {
    x: rect.x + style.padding.left,
    y: rect.y + style.padding.top,
    width: Math.max(0, rect.width - style.padding.left - style.padding.right),
    height: Math.max(0, rect.height - style.padding.top - style.padding.bottom),
  };
}

function normalizeRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}
