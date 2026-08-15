import type { ComputedStyle, HostNode, LayoutResult, Rect } from "./model.js";
import type { IndexedRasterRecord, IndexedRasterSnapshot } from "./raster.js";
import { ENUM, NODE } from "./spec.js";
import { beginMapTransaction, commitMap } from "./transaction-map.js";

export type PaintStyleResolver = (node: HostNode) => ComputedStyle;

interface PaintIndexNode {
  readonly id: number;
  readonly type: number;
  readonly parentId: number | null;
  /** Children in the exact z-index/document order used by the scene raster. */
  readonly children: readonly number[];
  readonly rect?: Rect;
  readonly style: ComputedStyle;
  readonly text?: string;
  readonly clip?: Rect;
  readonly childClip?: Rect;
  readonly opacity: number;
  readonly active: boolean;
  readonly painted: boolean;
}

interface PaintIndexState {
  readonly rootId: number;
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyMap<number, PaintIndexNode>;
  readonly rasterBuckets: ReadonlyMap<number, ReadonlySet<number>>;
  readonly hitBuckets: ReadonlyMap<number, ReadonlySet<number>>;
  readonly paintOrder: readonly number[];
  readonly paintRanks: ReadonlyMap<number, number>;
}

interface CaptureContext {
  readonly parentId: number | null;
  readonly active: boolean;
  readonly clip?: Rect;
  readonly opacity: number;
}

interface CapturedSubtree {
  readonly nodes: Map<number, PaintIndexNode>;
  readonly order: readonly number[];
}

/**
 * A retained, terminal-row-addressable index of PocketJS paint semantics.
 * Records contain copied values only: no live HostNode or mutable layout/style
 * object is consulted by rasterization or hit testing after construction.
 */
export class RetainedPaintIndex {
  #state: PaintIndexState;
  #version = 0;

  /** @internal Construct through buildPaintIndex() or a committed transaction. */
  constructor(state: PaintIndexState) {
    this.#state = state;
  }

  get width(): number {
    return this.#state.width;
  }

  get height(): number {
    return this.#state.height;
  }

  get nodeCount(): number {
    return this.#state.nodes.size;
  }

  get paintOrder(): readonly number[] {
    return this.#state.paintOrder;
  }

  rasterSnapshot(dirtyRows?: ReadonlySet<number>): IndexedRasterSnapshot {
    return rasterSnapshot(this.#state, dirtyRows);
  }

  hitTest(x: number, y: number): number {
    return hitTest(this.#state, x, y);
  }

  /** Latest retained z-index for an indexed structural node. */
  zIndex(id: number): number | undefined {
    return this.#state.nodes.get(id)?.style.zIndex;
  }

  /**
   * Prepare disjoint subtree replacements without changing this confirmed
   * index. The returned transaction is directly queryable before terminal
   * present and mutates retained maps only when commit() is called.
   */
  prepareSubtreePatch(
    roots: readonly HostNode[],
    layout: LayoutResult,
    resolveStyle: PaintStyleResolver,
  ): PaintIndexTransaction {
    const baseVersion = this.#version;
    const nodes = beginMapTransaction(this.#state.nodes);
    const rasterBuckets = beginMapTransaction(this.#state.rasterBuckets);
    const hitBuckets = beginMapTransaction(this.#state.hitBuckets);
    const touchedRasterBuckets = new Set<number>();
    const touchedHitBuckets = new Set<number>();
    const distinctRoots = [...new Map(roots.map((root) => [root.id, root])).values()];
    const rootIds = new Set(distinctRoots.map((root) => root.id));
    for (const root of distinctRoots) {
      let ancestor = root.parent;
      while (ancestor !== null) {
        if (rootIds.has(ancestor.id)) {
          throw new Error("PocketTUI: paint-index patch roots must be disjoint");
        }
        ancestor = ancestor.parent;
      }
    }
    let visitedNodes = 0;
    let orderChanged = false;

    for (const root of distinctRoots) {
      const oldRoot = nodes.get(root.id);
      if (oldRoot === undefined) {
        throw new Error(`PocketTUI: paint-index root ${root.id} is not retained`);
      }
      if (oldRoot.parentId === null || root.parent?.id !== oldRoot.parentId) {
        throw new Error(`PocketTUI: paint-index root ${root.id} has no stable parent context`);
      }
      const parent = nodes.get(oldRoot.parentId);
      if (parent === undefined) {
        throw new Error(`PocketTUI: paint-index parent ${oldRoot.parentId} is not retained`);
      }
      const oldOrder = collectSubtreeOrder(nodes, root.id);
      const captured = captureSubtree(root, layout, resolveStyle, {
        parentId: parent.id,
        active: parent.active && parent.type === NODE.view,
        clip: parent.childClip,
        opacity: parent.opacity,
      });
      visitedNodes += captured.order.length;

      const oldPainted = oldOrder.filter((id) => nodes.get(id)?.painted === true);
      const newPainted = captured.order.filter((id) => captured.nodes.get(id)?.painted === true);
      if (!sameNumberArray(oldPainted, newPainted)) orderChanged = true;

      for (const id of oldOrder) {
        const record = nodes.get(id);
        if (record === undefined) continue;
        patchRecordBuckets(
          rasterBuckets,
          touchedRasterBuckets,
          hitBuckets,
          touchedHitBuckets,
          record,
          this.#state.height,
          false,
        );
        nodes.delete(id);
      }
      for (const id of captured.order) {
        const record = captured.nodes.get(id)!;
        nodes.set(id, record);
        patchRecordBuckets(
          rasterBuckets,
          touchedRasterBuckets,
          hitBuckets,
          touchedHitBuckets,
          record,
          this.#state.height,
          true,
        );
      }
    }

    let paintOrder = this.#state.paintOrder;
    let paintRanks = this.#state.paintRanks;
    if (orderChanged) {
      paintOrder = collectPaintOrder(nodes, this.#state.rootId);
      paintRanks = rankPaintOrder(paintOrder);
    }
    const state: PaintIndexState = {
      ...this.#state,
      nodes,
      rasterBuckets,
      hitBuckets,
      paintOrder,
      paintRanks,
    };
    return new PaintIndexTransaction(
      this,
      baseVersion,
      state,
      distinctRoots.length,
      visitedNodes,
      orderChanged,
    );
  }

  /** @internal */
  _commit(baseVersion: number, state: PaintIndexState): RetainedPaintIndex {
    this._assertVersion(baseVersion);
    // Commit happens synchronously after surface.present() returns. There is no
    // callback between these writes and publishing the advanced state, so the
    // retained index can take ownership of the transaction's delta without
    // cloning every full-scene map on each incremental frame.
    this.#state = {
      ...state,
      nodes: commitMap(state.nodes),
      rasterBuckets: commitMap(state.rasterBuckets),
      hitBuckets: commitMap(state.hitBuckets),
      paintRanks: commitMap(state.paintRanks),
    };
    this.#version += 1;
    return this;
  }

  /** @internal Guard candidate reads as well as commits against ownership transfer. */
  _assertVersion(baseVersion: number): void {
    if (this.#version !== baseVersion) {
      throw new Error("PocketTUI: stale paint-index transaction");
    }
  }
}

/** Candidate retained index whose maps remain isolated until commit(). */
export class PaintIndexTransaction {
  readonly roots: number;
  readonly visitedNodes: number;
  readonly orderRebuilt: boolean;
  readonly #base: RetainedPaintIndex;
  readonly #baseVersion: number;
  readonly #state: PaintIndexState;
  #finished = false;

  /** @internal */
  constructor(
    base: RetainedPaintIndex,
    baseVersion: number,
    state: PaintIndexState,
    roots: number,
    visitedNodes: number,
    orderRebuilt: boolean,
  ) {
    this.#base = base;
    this.#baseVersion = baseVersion;
    this.#state = state;
    this.roots = roots;
    this.visitedNodes = visitedNodes;
    this.orderRebuilt = orderRebuilt;
  }

  get width(): number {
    return this.#state.width;
  }

  get height(): number {
    return this.#state.height;
  }

  get paintOrder(): readonly number[] {
    this.#assertOpen();
    return this.#state.paintOrder;
  }

  rasterSnapshot(dirtyRows?: ReadonlySet<number>): IndexedRasterSnapshot {
    this.#assertOpen();
    return rasterSnapshot(this.#state, dirtyRows);
  }

  hitTest(x: number, y: number): number {
    this.#assertOpen();
    return hitTest(this.#state, x, y);
  }

  commit(): RetainedPaintIndex {
    this.#assertOpen();
    this.#finished = true;
    return this.#base._commit(this.#baseVersion, this.#state);
  }

  discard(): void {
    this.#finished = true;
  }

  #assertOpen(): void {
    if (this.#finished) throw new Error("PocketTUI: paint-index transaction is finished");
    this.#base._assertVersion(this.#baseVersion);
  }
}

/** Build the authoritative retained index after a full scene/layout pass. */
export function buildPaintIndex(
  root: HostNode,
  layout: LayoutResult,
  width: number,
  height: number,
  resolveStyle: PaintStyleResolver,
): RetainedPaintIndex {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("PocketTUI: paint-index viewport must be positive integers");
  }
  const captured = captureSubtree(root, layout, resolveStyle, {
    parentId: null,
    active: true,
    clip: { x: 0, y: 0, width, height },
    opacity: 1,
  });
  const paintOrder = captured.order.filter((id) => captured.nodes.get(id)?.painted === true);
  const rasterBuckets = new Map<number, ReadonlySet<number>>();
  const hitBuckets = new Map<number, ReadonlySet<number>>();
  for (const id of paintOrder) {
    const record = captured.nodes.get(id)!;
    addRecordToNativeBuckets(rasterBuckets, hitBuckets, record, height);
  }
  return new RetainedPaintIndex({
    rootId: root.id,
    width,
    height,
    nodes: captured.nodes,
    rasterBuckets,
    hitBuckets,
    paintOrder,
    paintRanks: rankPaintOrder(paintOrder),
  });
}

function captureSubtree(
  root: HostNode,
  layout: LayoutResult,
  resolveStyle: PaintStyleResolver,
  context: CaptureContext,
): CapturedSubtree {
  const nodes = new Map<number, PaintIndexNode>();
  const order: number[] = [];
  const styles = new Map<number, ComputedStyle>();
  const styleFor = (node: HostNode): ComputedStyle => {
    let style = styles.get(node.id);
    if (style === undefined) {
      style = cloneStyle(layout.entries.get(node.id)?.style ?? resolveStyle(node));
      styles.set(node.id, style);
    }
    return style;
  };

  const visit = (node: HostNode, parent: CaptureContext): void => {
    const style = styleFor(node);
    const entry = layout.entries.get(node.id);
    const rect = entry === undefined ? undefined : cloneRect(entry.rect);
    const opacity = clamp01(parent.opacity * style.opacity);
    const clip =
      parent.active &&
      rect !== undefined &&
      style.display !== ENUM.displayNone &&
      opacity > 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      parent.clip !== undefined
        ? intersect(parent.clip, rect)
        : undefined;
    const active = clip !== undefined;
    const childClip =
      active && parent.clip !== undefined
        ? style.overflow === ENUM.overflowHidden
          ? clip
          : parent.clip
        : undefined;
    const text = node.type === NODE.text ? (layout.flattenedText.get(node.id) ?? node.text) : undefined;
    const painted =
      active &&
      (alpha(style.background) > 0 ||
        (style.borderWidth >= 0.5 && alpha(style.borderColor) > 0) ||
        (node.type === NODE.text && (text?.length ?? 0) > 0) ||
        node.type === NODE.image);
    const children = [...node.children]
      .map((child, index) => ({ child, index, z: styleFor(child).zIndex }))
      .sort((left, right) =>
        node.type === NODE.view ? left.z - right.z || left.index - right.index : left.index - right.index,
      )
      .map(({ child }) => child);
    const record: PaintIndexNode = {
      id: node.id,
      type: node.type,
      parentId: parent.parentId,
      children: children.map((child) => child.id),
      rect,
      style,
      text,
      clip: clip === undefined ? undefined : cloneRect(clip),
      childClip: childClip === undefined ? undefined : cloneRect(childClip),
      opacity,
      active,
      painted,
    };
    nodes.set(node.id, record);
    order.push(node.id);
    const childContext: CaptureContext = {
      parentId: node.id,
      active: active && node.type === NODE.view,
      clip: childClip,
      opacity,
    };
    for (const child of children) visit(child, childContext);
  };

  visit(root, context);
  return { nodes, order };
}

function rasterSnapshot(
  state: PaintIndexState,
  dirtyRows?: ReadonlySet<number>,
): IndexedRasterSnapshot {
  let ids: readonly number[];
  if (dirtyRows === undefined) {
    ids = state.paintOrder;
  } else if (dirtyRows.size === 0) {
    ids = [];
  } else {
    const selected = new Set<number>();
    for (const row of dirtyRows) {
      if (!Number.isInteger(row) || row < 0 || row >= state.height) continue;
      collectSegmentPoint(state.rasterBuckets, state.height, row, selected);
    }
    ids = [...selected].sort(
      (left, right) => (state.paintRanks.get(left) ?? 0) - (state.paintRanks.get(right) ?? 0),
    );
  }
  const candidates: IndexedRasterRecord[] = [];
  for (const id of ids) {
    const record = state.nodes.get(id);
    if (record?.painted !== true || record.rect === undefined || record.clip === undefined) continue;
    candidates.push({
      id: record.id,
      type: record.type,
      rect: record.rect,
      style: record.style,
      text: record.text,
      clip: record.clip,
      opacity: record.opacity,
    });
  }
  return { candidates, paintOrder: state.paintOrder };
}

function hitTest(state: PaintIndexState, x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  let candidates: Iterable<number>;
  if (y >= 0 && y < state.height) {
    const selected = new Set<number>();
    collectSegmentPoint(state.hitBuckets, state.height, Math.floor(y), selected);
    candidates = selected;
  } else {
    candidates = state.paintOrder;
  }
  let bestId = 0;
  let bestRank = -1;
  for (const id of candidates) {
    const record = state.nodes.get(id);
    const rank = state.paintRanks.get(id);
    if (
      record?.painted === true &&
      record.rect !== undefined &&
      rank !== undefined &&
      rank > bestRank &&
      contains(record.rect, x, y)
    ) {
      bestId = id;
      bestRank = rank;
    }
  }
  return bestId;
}

function collectSubtreeOrder(
  nodes: ReadonlyMap<number, PaintIndexNode>,
  rootId: number,
): number[] {
  const result: number[] = [];
  const visit = (id: number): void => {
    const node = nodes.get(id);
    if (node === undefined) return;
    result.push(id);
    for (const child of node.children) visit(child);
  };
  visit(rootId);
  return result;
}

function collectPaintOrder(
  nodes: ReadonlyMap<number, PaintIndexNode>,
  rootId: number,
): readonly number[] {
  return collectSubtreeOrder(nodes, rootId).filter((id) => nodes.get(id)?.painted === true);
}

function rankPaintOrder(order: readonly number[]): Map<number, number> {
  return new Map(order.map((id, index) => [id, index]));
}

function patchRecordBuckets(
  rasterBuckets: Map<number, ReadonlySet<number>>,
  touchedRasterBuckets: Set<number>,
  hitBuckets: Map<number, ReadonlySet<number>>,
  touchedHitBuckets: Set<number>,
  record: PaintIndexNode,
  height: number,
  add: boolean,
): void {
  if (!record.painted || record.rect === undefined || record.clip === undefined) return;
  patchInterval(
    rasterBuckets,
    touchedRasterBuckets,
    record.id,
    record.clip.y,
    record.clip.y + record.clip.height,
    height,
    add,
  );
  patchInterval(
    hitBuckets,
    touchedHitBuckets,
    record.id,
    record.rect.y,
    record.rect.y + record.rect.height,
    height,
    add,
  );
}

function addRecordToNativeBuckets(
  rasterBuckets: Map<number, ReadonlySet<number>>,
  hitBuckets: Map<number, ReadonlySet<number>>,
  record: PaintIndexNode,
  height: number,
): void {
  if (!record.painted || record.rect === undefined || record.clip === undefined) return;
  addIntervalNative(
    rasterBuckets,
    record.id,
    record.clip.y,
    record.clip.y + record.clip.height,
    height,
  );
  addIntervalNative(
    hitBuckets,
    record.id,
    record.rect.y,
    record.rect.y + record.rect.height,
    height,
  );
}

function addIntervalNative(
  buckets: Map<number, ReadonlySet<number>>,
  id: number,
  start: number,
  end: number,
  height: number,
): void {
  forEachIntervalBucket(start, end, height, (bucket) => {
    let values = buckets.get(bucket) as Set<number> | undefined;
    if (values === undefined) {
      values = new Set();
      buckets.set(bucket, values);
    }
    values.add(id);
  });
}

function patchInterval(
  buckets: Map<number, ReadonlySet<number>>,
  touched: Set<number>,
  id: number,
  start: number,
  end: number,
  height: number,
  add: boolean,
): void {
  forEachIntervalBucket(start, end, height, (bucket) => {
    let values = buckets.get(bucket);
    if (!touched.has(bucket)) {
      values = new Set(values);
      touched.add(bucket);
      if (values.size === 0) {
        buckets.delete(bucket);
      } else {
        buckets.set(bucket, values);
      }
    }
    const mutable = (buckets.get(bucket) as Set<number> | undefined) ?? new Set<number>();
    if (add) mutable.add(id);
    else mutable.delete(id);
    if (mutable.size === 0) buckets.delete(bucket);
    else buckets.set(bucket, mutable);
  });
}

function forEachIntervalBucket(
  rawStart: number,
  rawEnd: number,
  height: number,
  visit: (bucket: number) => void,
): void {
  const start = Math.max(0, Math.min(height, Math.floor(rawStart)));
  const end = Math.max(0, Math.min(height, Math.ceil(rawEnd)));
  if (end <= start) return;
  const decompose = (bucket: number, left: number, right: number): void => {
    if (end <= left || right <= start) return;
    if (start <= left && right <= end) {
      visit(bucket);
      return;
    }
    const middle = left + Math.floor((right - left) / 2);
    if (middle <= left) return;
    decompose(bucket * 2, left, middle);
    decompose(bucket * 2 + 1, middle, right);
  };
  decompose(1, 0, height);
}

function collectSegmentPoint(
  buckets: ReadonlyMap<number, ReadonlySet<number>>,
  height: number,
  row: number,
  target: Set<number>,
): void {
  let bucket = 1;
  let left = 0;
  let right = height;
  while (right > left) {
    for (const id of buckets.get(bucket) ?? []) target.add(id);
    if (right - left === 1) break;
    const middle = left + Math.floor((right - left) / 2);
    if (row < middle) {
      bucket *= 2;
      right = middle;
    } else {
      bucket = bucket * 2 + 1;
      left = middle;
    }
  }
}

function cloneStyle(style: ComputedStyle): ComputedStyle {
  return {
    ...style,
    padding: { ...style.padding },
    margin: { ...style.margin },
    inset: { ...style.inset },
  };
}

function cloneRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

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

function alpha(color: number): number {
  return (color >>> 24) & 0xff;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
