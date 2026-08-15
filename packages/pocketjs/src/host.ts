import type { HostOps } from "#pocketjs-runtime";
import type {
  CanvasFrame,
  CreateTuiOptions,
  CursorPacketOptions,
  EffectBusFrame,
  FlushMode,
  TuiInputEvent,
  TuiViewportSize,
} from "@pocket-tui/core";

import {
  layoutAbsoluteSubtreeCached,
  layoutTreeCached,
  layoutTreeIncremental,
  type LayoutCache,
} from "./layout.js";
import type { ComputedStyle, HostNode, LayoutEntry, LayoutResult, Rect } from "./model.js";
import { rasterize, type PocketTuiColorMode } from "./raster.js";
import {
  COLOR_PROPS,
  ENUM,
  ID_SLOT_BITS,
  ID_SLOT_MASK,
  KNOWN_PROPS,
  MAX_GENERATION,
  MAX_TREE_DEPTH,
  NODE,
  PROP,
  ROOT_ID,
  STYLE_ID_NONE,
  SUPPORTED_PROPS,
} from "./spec.js";
import { parseStyleTable, type HostStyleRecord, type PropertyMap } from "./style.js";
import { createCoreSurface, type PocketTuiSurface } from "./surface.js";
import {
  beginMapTransaction,
  collectChangedMapKeys,
  commitMap,
} from "./transaction-map.js";
import { lineWidth } from "./unicode.js";

const PAINT_ONLY_PROPERTIES = new Set<number>([
  PROP.overflow,
  PROP.zIndex,
  PROP.bgColor,
  PROP.opacity,
  PROP.borderColor,
  PROP.borderWidth,
  PROP.textColor,
  PROP.textAlign,
  PROP.tracking,
]);

const LAYOUT_PROPERTIES = new Set<number>([
  PROP.width,
  PROP.height,
  PROP.minW,
  PROP.minH,
  PROP.maxW,
  PROP.maxH,
  PROP.paddingT,
  PROP.paddingR,
  PROP.paddingB,
  PROP.paddingL,
  PROP.marginT,
  PROP.marginR,
  PROP.marginB,
  PROP.marginL,
  PROP.gap,
  PROP.flexDir,
  PROP.justify,
  PROP.align,
  PROP.grow,
  PROP.shrink,
  PROP.basis,
  PROP.posType,
  PROP.insetT,
  PROP.insetR,
  PROP.insetB,
  PROP.insetL,
  PROP.display,
  PROP.lineHeight,
]);

export interface PocketTuiHostOptions {
  /** An injectable surface keeps HostOps contract tests independent of a TTY. */
  surface?: PocketTuiSurface;
  /** Used only when the default @pocket-tui/core surface is constructed. */
  tui?: CreateTuiOptions;
  /** Explicit initial dimensions override the attached surface's report. */
  columns?: number;
  rows?: number;
  /** ANSI16 is safe for conservative terminals; Ghostty effects use RGB. */
  colorMode?: PocketTuiColorMode;
}

export interface PocketTuiHostDiagnostics {
  readonly liveNodes: number;
  readonly mutations: number;
  readonly renderedFrames: number;
  readonly skippedFrames: number;
  /** Successful frames that recomputed cell geometry. */
  readonly layoutPasses: number;
  /** Successful frames that ran the uncached viewport-root layout oracle. */
  readonly fullLayoutFrames: number;
  /** Successful frames that recomputed isolated absolute subtrees. */
  readonly localizedLayoutFrames: number;
  /** Successful viewport-root passes that reused exact cached Flex work. */
  readonly cachedLayoutFrames: number;
  /** Successful frames that reused all previous geometry. */
  readonly reusedLayoutFrames: number;
  /** Entries recomputed by the most recently presented layout frame. */
  readonly lastLayoutNodes: number;
  /** Total entries recomputed by successfully presented layout frames. */
  readonly layoutNodes: number;
  /** Distinct nodes measured by the most recently presented layout frame. */
  readonly lastMeasuredNodes: number;
  /** Total distinct-per-frame nodes measured by successful layout frames. */
  readonly measuredNodes: number;
  /** Cached entries reused by the most recently presented layout frame. */
  readonly lastReusedLayoutNodes: number;
  /** Total cached entries reused by successfully presented layout frames. */
  readonly reusedLayoutNodes: number;
  /** Solver roots recomputed by the most recently presented frame. */
  readonly lastRelayoutRoots: number;
  /** Successful frames rasterized across the complete viewport. */
  readonly fullRasterFrames: number;
  /** Successful frames rasterized only across affected rows. */
  readonly incrementalRasterFrames: number;
  /** Rows rasterized by the most recently presented frame. */
  readonly lastRepaintedRows: number;
  /** Total rows rasterized by successfully presented frames. */
  readonly repaintedRows: number;
  readonly lastRunCount: number;
  readonly missingStyles: number;
  readonly unsupportedProperties: number;
  readonly unsupportedImages: number;
  readonly unsupportedTextures: number;
  readonly unsupportedSprites: number;
  readonly collapsedAnimations: number;
  readonly ignoredFontAtlases: number;
}

export interface PocketTuiNodeSnapshot {
  readonly id: number;
  readonly type: "view" | "text" | "image";
  readonly parent: number | null;
  readonly children: readonly number[];
  readonly text: string;
  readonly styleId: number;
  readonly focused: boolean;
  readonly active: boolean;
  readonly rect?: Rect;
}

export type PocketTuiHostOps = HostOps & {
  __viewport: { w: number; h: number };
};

interface ArenaSlot {
  generation: number;
  node?: HostNode;
  quarantined?: boolean;
}

interface MutableDiagnostics {
  liveNodes: number;
  mutations: number;
  renderedFrames: number;
  skippedFrames: number;
  layoutPasses: number;
  fullLayoutFrames: number;
  localizedLayoutFrames: number;
  cachedLayoutFrames: number;
  reusedLayoutFrames: number;
  lastLayoutNodes: number;
  layoutNodes: number;
  lastMeasuredNodes: number;
  measuredNodes: number;
  lastReusedLayoutNodes: number;
  reusedLayoutNodes: number;
  lastRelayoutRoots: number;
  fullRasterFrames: number;
  incrementalRasterFrames: number;
  lastRepaintedRows: number;
  repaintedRows: number;
  lastRunCount: number;
  missingStyles: number;
  unsupportedProperties: number;
  unsupportedImages: number;
  unsupportedTextures: number;
  unsupportedSprites: number;
  collapsedAnimations: number;
  ignoredFontAtlases: number;
}

interface LocalizedLayoutResult {
  readonly layout: LayoutResult;
  readonly cache?: LayoutCache;
  readonly dirtyRows: Set<number>;
  readonly roots: readonly HostNode[];
  readonly layoutNodes: number;
  readonly measuredNodes: number;
}

export class PocketTuiHost {
  readonly ops: PocketTuiHostOps;
  readonly #surface: PocketTuiSurface;
  readonly #colorMode: PocketTuiColorMode;
  readonly #slots: ArenaSlot[] = [{ generation: 0 }, { generation: 0 }];
  readonly #freeSlots: number[] = [];
  readonly #workListeners = new Set<() => void>();
  readonly #inputReadyDisposers = new Set<() => void>();
  readonly #stats: MutableDiagnostics = {
    liveNodes: 1,
    mutations: 0,
    renderedFrames: 0,
    skippedFrames: 0,
    layoutPasses: 0,
    fullLayoutFrames: 0,
    localizedLayoutFrames: 0,
    cachedLayoutFrames: 0,
    reusedLayoutFrames: 0,
    lastLayoutNodes: 0,
    layoutNodes: 0,
    lastMeasuredNodes: 0,
    measuredNodes: 0,
    lastReusedLayoutNodes: 0,
    reusedLayoutNodes: 0,
    lastRelayoutRoots: 0,
    fullRasterFrames: 0,
    incrementalRasterFrames: 0,
    lastRepaintedRows: 0,
    repaintedRows: 0,
    lastRunCount: 0,
    missingStyles: 0,
    unsupportedProperties: 0,
    unsupportedImages: 0,
    unsupportedTextures: 0,
    unsupportedSprites: 0,
    collapsedAnimations: 0,
    ignoredFontAtlases: 0,
  };
  readonly #root: HostNode;
  #styles: HostStyleRecord[] = [];
  #focused = 0;
  #nextAnimation = 1;
  #viewport: TuiViewportSize;
  #dirty: "full" | "layout" | "paint" | undefined = "full";
  readonly #layoutDirtyNodes = new Set<HostNode>();
  readonly #paintDirtyNodes = new Set<HostNode>();
  #layoutRevision = 0;
  #mutationRevision = 0;
  #surfacePending = false;
  #surfaceRevision = 0;
  #rendering = false;
  #renderNotificationPending = false;
  #closed = false;
  #lastLayout?: LayoutResult;
  #lastLayoutCache?: LayoutCache;
  #lastPaintOrder: readonly number[] = [];
  #lastFrame: CanvasFrame;

  constructor(options: PocketTuiHostOptions = {}) {
    this.#surface = options.surface ?? createCoreSurface(options.tui);
    this.#colorMode = options.colorMode ?? defaultColorMode();
    const reported = this.#surface.viewportSize();
    this.#viewport = validateViewport({
      columns: options.columns ?? reported.columns,
      rows: options.rows ?? reported.rows,
    });
    this.#root = createNodeRecord(ROOT_ID, NODE.view);
    this.#slots[1] = { generation: 0, node: this.#root };
    this.#lastFrame = { width: this.#viewport.columns, height: this.#viewport.rows, runs: [] };

    const viewport = { w: this.#viewport.columns, h: this.#viewport.rows };
    this.ops = {
      __viewport: viewport,
      createNode: (type) => this.#createNode(type),
      destroyNode: (id) => this.#destroyNode(id),
      insertBefore: (parent, child, anchor) => this.#insertBefore(parent, child, anchor),
      removeChild: (parent, child) => this.#removeChild(parent, child),
      setStyle: (id, styleId) => this.#setStyle(id, styleId),
      setProp: (id, property, value) => this.#setProperty(id, property, value),
      setText: (id, value) => this.#setText(id, value),
      replaceText: (id, value) => this.#setText(id, value),
      uploadTexture: (bytes, width, height, psm) => this.#uploadTexture(bytes, width, height, psm),
      setImage: (id, texture) => this.#setImage(id, texture),
      setSprite: (id, atlas, frames, columns, step) =>
        this.#setSprite(id, atlas, frames, columns, step),
      animate: (id, property, to, duration, easing, delay) =>
        this.#animate(id, property, to, duration, easing, delay),
      cancelAnim: (animation) => this.#cancelAnimation(animation),
      setFocus: (id) => this.#setFocus(id),
      setActive: (id, active) => this.#setActive(id, active),
      hitTest: (x, y) => this.#hitTest(x, y),
      loadStyles: (bytes) => this.loadStyles(bytes),
      loadFontAtlas: (bytes) => this.#loadFontAtlas(bytes),
      measureText: (value, fontSlot) => this.#measureText(value, fontSlot),
    };
  }

  get diagnostics(): PocketTuiHostDiagnostics {
    return Object.freeze({ ...this.#stats });
  }

  get frame(): CanvasFrame {
    return this.#lastFrame;
  }

  /** Whether retained scene mutations still need layout and/or raster work. */
  get renderPending(): boolean {
    return this.#dirty !== undefined;
  }

  /** Whether commands submitted to the surface still need an explicit flush. */
  get surfacePending(): boolean {
    return this.#surfacePending;
  }

  /** Whether adaptive sessions can sleep without a JavaScript polling timer. */
  get inputReadySupported(): boolean {
    if (this.#surface.onInputReady === undefined) return false;
    return this.#surface.inputReadySupported?.() ?? true;
  }

  /**
   * Subscribe to retained render work or unflushed surface work. A listener
   * attached while work is already pending is invoked immediately.
   */
  onWorkNeeded(listener: () => void): () => void {
    this.#assertOpen();
    if (typeof listener !== "function") throw new TypeError("PocketTUI: work listener must be a function");
    const registration = (): void => listener();
    this.#workListeners.add(registration);
    try {
      if (this.#dirty !== undefined || this.#surfacePending) {
        if (this.#rendering) {
          this.#renderNotificationPending = true;
        } else {
          registration();
        }
      }
    } catch (error) {
      this.#workListeners.delete(registration);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#workListeners.delete(registration);
    };
  }

  /** @deprecated Prefer onWorkNeeded(), which also describes surface work. */
  onRenderNeeded(listener: () => void): () => void {
    return this.onWorkNeeded(listener);
  }

  /** Forward native readiness notifications when the attached surface supports them. */
  onInputReady(listener: () => void): () => void {
    this.#assertOpen();
    if (typeof listener !== "function") {
      throw new TypeError("PocketTUI: input readiness listener must be a function");
    }
    const subscribe = this.#surface.onInputReady;
    if (subscribe === undefined) return () => {};

    let active = true;
    const surfaceDispose = subscribe.call(this.#surface, () => {
      if (active && !this.#closed) listener();
    });
    const dispose = (): void => {
      if (!active) return;
      active = false;
      this.#inputReadyDisposers.delete(dispose);
      surfaceDispose();
    };
    this.#inputReadyDisposers.add(dispose);
    return dispose;
  }

  viewportSize(): TuiViewportSize {
    return Object.freeze({ ...this.#viewport });
  }

  /** Return the latest laid-out cell rectangle for a live PocketJS node. */
  nodeRect(id: number): Readonly<Rect> | undefined {
    this.#assertOpen();
    this.#node(id);
    const rect = this.#lastLayout?.entries.get(id)?.rect;
    return rect === undefined ? undefined : Object.freeze({ ...rect });
  }

  resize(columns: number, rows: number): void {
    this.#assertOpen();
    const next = validateViewport({ columns, rows });
    if (next.columns === this.#viewport.columns && next.rows === this.#viewport.rows) return;
    this.#viewport = next;
    this.ops.__viewport.w = columns;
    this.ops.__viewport.h = rows;
    // PocketJS creates exactly two direct root layers (application + overlay)
    // using the viewport observed during mount. Keep those framework-owned
    // layers synchronized without reaching into Pocket's private mirror tree.
    for (const layer of this.#root.children) {
      layer.inline.set(PROP.width, columns);
      layer.inline.set(PROP.height, rows);
    }
    this.#markMutation();
  }

  setCursor(options: CursorPacketOptions): void {
    this.#assertOpen();
    this.#markSurfaceMutation();
    this.#surface.setCursor(options);
  }

  setEffectBus(frame: EffectBusFrame): void {
    this.#assertOpen();
    if (this.#surface.setEffectBus === undefined) {
      throw new Error("PocketTUI: the attached surface does not support an effect bus");
    }
    this.#markSurfaceMutation();
    this.#surface.setEffectBus(frame);
  }

  clearEffectBus(): void {
    this.#assertOpen();
    if (this.#surface.clearEffectBus === undefined) {
      throw new Error("PocketTUI: the attached surface does not support an effect bus");
    }
    this.#markSurfaceMutation();
    this.#surface.clearEffectBus();
  }

  loadStyles(bytes: Uint8Array): void {
    this.#assertOpen();
    this.#styles = parseStyleTable(bytes);
    this.#markMutation();
  }

  render(force = false): CanvasFrame {
    this.#assertOpen();
    if (this.#rendering) throw new Error("PocketTUI: render is already in progress");
    this.#rendering = true;
    let frame: CanvasFrame | undefined;
    let renderFailed = false;
    let renderFailure: unknown;
    try {
      frame = this.#renderFrame(force);
    } catch (error) {
      renderFailed = true;
      renderFailure = error;
    } finally {
      this.#rendering = false;
    }
    const notify = this.#renderNotificationPending;
    this.#renderNotificationPending = false;
    let notificationFailed = false;
    let notificationFailure: unknown;
    if (notify) {
      try {
        this.#notifyWorkNeeded();
      } catch (error) {
        notificationFailed = true;
        notificationFailure = error;
      }
    }
    if (renderFailed) {
      if (notificationFailed) {
        throw new AggregateError(
          [renderFailure, notificationFailure],
          "PocketTUI: render failed and a work listener also failed",
          { cause: renderFailure },
        );
      }
      throw renderFailure;
    }
    if (notificationFailed) throw notificationFailure;
    if (frame === undefined) throw new Error("PocketTUI: render produced no frame");
    return frame;
  }

  #renderFrame(force: boolean): CanvasFrame {
    const pending = this.#dirty;
    if (pending === undefined && !force) {
      this.#stats.skippedFrames += 1;
      return this.#lastFrame;
    }
    const previousLayout = this.#lastLayout;
    let renderKind: "full" | "localized" | "cached" | "reuse";
    let layout: LayoutResult;
    let layoutCache: LayoutCache | undefined;
    let dirtyRows: Set<number> | undefined;
    let layoutNodes = 0;
    let measuredNodes = 0;
    let reusedLayoutNodes = 0;
    let relayoutRoots = 0;
    if (force || pending === "full" || previousLayout === undefined) {
      renderKind = "full";
      const pass = layoutTreeCached(
        this.#root,
        this.#viewport.columns,
        this.#viewport.rows,
        (node) => this.#computedStyle(node),
      );
      layout = pass.result;
      layoutCache = pass.cache;
      layoutNodes = pass.laidOutNodes;
      measuredNodes = pass.measuredNodes;
      relayoutRoots = 1;
    } else if (pending === "layout") {
      const localized = this.#localizedLayout(previousLayout);
      if (localized !== undefined) {
        renderKind = localized.roots.length === 0 ? "reuse" : "localized";
        layout = localized.layout;
        layoutCache = localized.cache;
        dirtyRows = localized.dirtyRows;
        layoutNodes = localized.layoutNodes;
        measuredNodes = localized.measuredNodes;
        reusedLayoutNodes =
          localized.roots.length === 0
            ? 0
            : Math.max(0, layout.entries.size - layoutNodes);
        relayoutRoots = localized.roots.length;
      } else if (this.#lastLayoutCache !== undefined) {
        renderKind = "cached";
        const pass = layoutTreeIncremental(
          this.#root,
          this.#viewport.columns,
          this.#viewport.rows,
          (node) => this.#computedStyle(node),
          previousLayout,
          this.#lastLayoutCache,
        );
        layout = this.#refreshPaintStyles(pass.result);
        layoutCache = pass.cache;
        dirtyRows = this.#collectLayoutDirtyRows(previousLayout, layout);
        this.#collectDirtyRows(previousLayout, layout, dirtyRows);
        layoutNodes = pass.laidOutNodes;
        measuredNodes = pass.measuredNodes;
        reusedLayoutNodes = pass.reusedNodes;
        relayoutRoots = 1;
      } else {
        renderKind = "full";
        const pass = layoutTreeCached(
          this.#root,
          this.#viewport.columns,
          this.#viewport.rows,
          (node) => this.#computedStyle(node),
        );
        layout = pass.result;
        layoutCache = pass.cache;
        layoutNodes = pass.laidOutNodes;
        measuredNodes = pass.measuredNodes;
        relayoutRoots = 1;
      }
    } else {
      renderKind = "reuse";
      // The missing-cache case is handled above, so retained geometry and text
      // are always available here.
      if (previousLayout === undefined) throw new Error("PocketTUI: missing retained layout");
      layout = this.#refreshPaintStyles(previousLayout);
      layoutCache = this.#lastLayoutCache;
      dirtyRows = this.#collectDirtyRows(previousLayout, layout);
    }
    const raster = rasterize(
      this.#root,
      layout,
      this.#viewport.columns,
      this.#viewport.rows,
      this.#colorMode,
      renderKind === "full"
        ? undefined
        : {
            previousFrame: this.#lastFrame,
            dirtyRows,
          },
    );
    const mutationRevision = this.#mutationRevision;
    const notifySurfaceWork = this.#setSurfacePending();
    try {
      this.#surface.present(raster.frame);
    } catch (error) {
      // A failed forced render from a clean scene still needs a render retry;
      // ordinary dirty renders already retain their more precise state.
      const promotedRenderRetry = this.#dirty === undefined;
      if (promotedRenderRetry) this.#dirty = "full";
      if (notifySurfaceWork || promotedRenderRetry) this.#notifyWorkNeeded();
      throw error;
    }
    this.#lastLayout = {
      entries: commitMap(layout.entries),
      flattenedText: commitMap(layout.flattenedText),
    };
    this.#lastLayoutCache =
      layoutCache === undefined
        ? undefined
        : {
            measurements: commitMap(layoutCache.measurements),
            geometryRevisions: commitMap(layoutCache.geometryRevisions),
            textRevisions: commitMap(layoutCache.textRevisions),
            subtreeEntryCounts: commitMap(layoutCache.subtreeEntryCounts),
          };
    this.#lastPaintOrder = raster.paintOrder;
    this.#lastFrame = raster.frame;
    const retainedRenderWork = mutationRevision !== this.#mutationRevision;
    if (!retainedRenderWork) {
      this.#dirty = undefined;
      this.#layoutDirtyNodes.clear();
      this.#paintDirtyNodes.clear();
    }
    this.#stats.renderedFrames += 1;
    if (renderKind === "full") {
      this.#stats.layoutPasses += 1;
      this.#stats.fullLayoutFrames += 1;
      this.#stats.fullRasterFrames += 1;
    } else if (renderKind === "localized") {
      this.#stats.layoutPasses += 1;
      this.#stats.localizedLayoutFrames += 1;
      this.#stats.incrementalRasterFrames += 1;
    } else if (renderKind === "cached") {
      this.#stats.layoutPasses += 1;
      this.#stats.cachedLayoutFrames += 1;
      this.#stats.incrementalRasterFrames += 1;
    } else {
      this.#stats.reusedLayoutFrames += 1;
      this.#stats.incrementalRasterFrames += 1;
    }
    this.#stats.lastLayoutNodes = layoutNodes;
    this.#stats.layoutNodes += layoutNodes;
    this.#stats.lastMeasuredNodes = measuredNodes;
    this.#stats.measuredNodes += measuredNodes;
    this.#stats.lastReusedLayoutNodes = reusedLayoutNodes;
    this.#stats.reusedLayoutNodes += reusedLayoutNodes;
    this.#stats.lastRelayoutRoots = relayoutRoots;
    const repaintedRows = renderKind === "full" ? raster.frame.height : (dirtyRows?.size ?? 0);
    this.#stats.lastRepaintedRows = repaintedRows;
    this.#stats.repaintedRows += repaintedRows;
    this.#stats.lastRunCount = raster.frame.runs.length;
    if (notifySurfaceWork || retainedRenderWork) this.#notifyWorkNeeded();
    return raster.frame;
  }

  pollInput(): TuiInputEvent[] {
    this.#assertOpen();
    return this.#surface.pollInput();
  }

  async start(): Promise<void> {
    this.#assertOpen();
    await this.#surface.start();
  }

  async flush(mode: FlushMode = "terminal"): Promise<void> {
    this.#assertOpen();
    const revision = this.#surfaceRevision;
    await this.#surface.flush(mode);
    if (revision === this.#surfaceRevision) this.#surfacePending = false;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#workListeners.clear();
    const inputReadyDisposers = [...this.#inputReadyDisposers];
    this.#inputReadyDisposers.clear();
    let failure: unknown;
    for (const dispose of inputReadyDisposers) {
      try {
        dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await this.#surface.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  snapshot(): readonly PocketTuiNodeSnapshot[] {
    const snapshots: PocketTuiNodeSnapshot[] = [];
    for (const slot of this.#slots) {
      const node = slot.node;
      if (node === undefined) continue;
      snapshots.push({
        id: node.id,
        type: node.type === NODE.view ? "view" : node.type === NODE.text ? "text" : "image",
        parent: node.parent?.id ?? null,
        children: node.children.map((child) => child.id),
        text: node.text,
        styleId: node.styleId,
        focused: node.id === this.#focused,
        active: node.active,
        rect: this.#lastLayout?.entries.get(node.id)?.rect,
      });
    }
    return snapshots;
  }

  #createNode(type: number): number {
    this.#assertOpen();
    if (type !== NODE.view && type !== NODE.text && type !== NODE.image) {
      throw new RangeError(`PocketTUI: unsupported PocketJS node type ${type}`);
    }
    let slot = this.#freeSlots.pop();
    if (slot === undefined) {
      slot = this.#slots.length;
      if (slot > ID_SLOT_MASK) throw new RangeError("PocketTUI: PocketJS node arena is full");
      this.#slots.push({ generation: 1 });
    }
    const entry = this.#slots[slot];
    if (entry === undefined || entry.quarantined) throw new Error("PocketTUI: corrupt node free list");
    const id = entry.generation * 2 ** ID_SLOT_BITS + slot;
    if (!Number.isSafeInteger(id) || id <= 0 || id > 0x7fff_ffff) {
      throw new RangeError("PocketTUI: PocketJS node id space is exhausted");
    }
    entry.node = createNodeRecord(id, type);
    this.#stats.liveNodes += 1;
    this.#markMutation();
    return id;
  }

  #destroyNode(id: number): void {
    this.#assertOpen();
    if (id === ROOT_ID) throw new Error("PocketTUI: the PocketJS root cannot be destroyed");
    const node = this.#node(id);
    this.#unlink(node);
    const destroy = (current: HostNode): void => {
      for (const child of [...current.children]) destroy(child);
      current.children.length = 0;
      current.parent = null;
      if (this.#focused === current.id) this.#focused = 0;
      this.#releaseId(current.id);
      this.#stats.liveNodes -= 1;
    };
    destroy(node);
    this.#markMutation();
  }

  #insertBefore(parentId: number, childId: number, anchorId: number): void {
    this.#assertOpen();
    const parent = this.#node(parentId);
    const child = this.#node(childId);
    if (child === this.#root) throw new Error("PocketTUI: the PocketJS root cannot be inserted");
    if (child === parent || isAncestor(child, parent)) {
      throw new Error("PocketTUI: insertBefore would create a cycle");
    }
    if (anchorId === childId) return;
    const anchor = anchorId === 0 ? undefined : this.#node(anchorId);
    if (anchor !== undefined && anchor.parent !== parent) {
      throw new Error(`PocketTUI: anchor ${anchorId} is not a child of ${parentId}`);
    }
    const resultingDepth = depth(parent) + subtreeDepth(child);
    if (resultingDepth > MAX_TREE_DEPTH) {
      throw new RangeError(`PocketTUI: tree depth would exceed ${MAX_TREE_DEPTH}`);
    }
    this.#unlink(child);
    if (anchor === undefined) {
      parent.children.push(child);
    } else {
      const index = parent.children.indexOf(anchor);
      if (index < 0) throw new Error("PocketTUI: anchor disappeared during move");
      parent.children.splice(index, 0, child);
    }
    child.parent = parent;
    this.#markMutation();
  }

  #removeChild(parentId: number, childId: number): void {
    this.#assertOpen();
    const parent = this.#node(parentId);
    const child = this.#node(childId);
    if (child.parent !== parent) throw new Error(`PocketTUI: node ${childId} is not a child of ${parentId}`);
    this.#unlink(child);
    this.#markMutation();
  }

  #setStyle(id: number, styleId: number): void {
    this.#assertOpen();
    const node = this.#node(id);
    if (!Number.isInteger(styleId) || styleId < STYLE_ID_NONE) {
      throw new RangeError("PocketTUI: style id must be -1 or a non-negative integer");
    }
    if (styleId >= this.#styles.length) {
      this.#stats.missingStyles += 1;
      throw new RangeError(`PocketTUI: style ${styleId} is not loaded`);
    }
    node.styleId = styleId;
    this.#markMutation();
  }

  #setProperty(id: number, property: number, value: number): void {
    this.#assertOpen();
    const node = this.#node(id);
    if (!Number.isInteger(property) || !KNOWN_PROPS.has(property)) {
      throw new RangeError(`PocketTUI: unknown PocketJS property ${property}`);
    }
    if (!Number.isFinite(value)) throw new RangeError(`PocketTUI: property ${property} must be finite`);
    validateEnum(property, value);
    const normalized = COLOR_PROPS.has(property) ? value >>> 0 : value;
    node.inline.set(property, normalized);
    if (!SUPPORTED_PROPS.has(property)) this.#stats.unsupportedProperties += 1;
    if (PAINT_ONLY_PROPERTIES.has(property)) {
      this.#markPaintMutation(node);
    } else if (LAYOUT_PROPERTIES.has(property)) {
      this.#markLayoutMutation(node);
    } else {
      this.#markMutation();
    }
  }

  #setText(id: number, value: string): void {
    this.#assertOpen();
    const node = this.#node(id);
    if (node.type !== NODE.text) throw new TypeError(`PocketTUI: node ${id} is not text`);
    if (typeof value !== "string") throw new TypeError("PocketTUI: text must be a string");
    if (node.text === value) return;
    node.text = value;
    this.#markLayoutMutation(node);
  }

  #uploadTexture(bytes: Uint8Array, width: number, height: number, psm: number): number {
    this.#assertOpen();
    if (!(bytes instanceof Uint8Array)) throw new TypeError("PocketTUI: texture payload must be Uint8Array");
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new RangeError("PocketTUI: texture dimensions must be positive integers");
    }
    if (!Number.isInteger(psm)) throw new RangeError("PocketTUI: texture format must be an integer");
    this.#stats.unsupportedTextures += 1;
    return -1;
  }

  #setImage(id: number, texture: number): void {
    this.#assertOpen();
    const node = this.#node(id);
    if (node.type !== NODE.image) throw new TypeError(`PocketTUI: node ${id} is not an image`);
    if (!Number.isInteger(texture)) throw new RangeError("PocketTUI: texture handle must be an integer");
    node.image = texture;
    if (texture >= 0) this.#stats.unsupportedImages += 1;
    this.#markMutation();
  }

  #setSprite(id: number, atlas: number, frames: number, columns: number, step: number): void {
    this.#assertOpen();
    const node = this.#node(id);
    if (node.type !== NODE.image) throw new TypeError(`PocketTUI: node ${id} is not an image`);
    if (![atlas, frames, columns, step].every(Number.isInteger)) {
      throw new RangeError("PocketTUI: sprite arguments must be integers");
    }
    if (frames > 0) this.#stats.unsupportedSprites += 1;
    node.image = atlas;
    this.#markMutation();
  }

  #animate(
    id: number,
    property: number,
    to: number,
    duration: number,
    easing: number,
    delay: number,
  ): number {
    if (![duration, easing, delay].every(Number.isFinite)) {
      throw new RangeError("PocketTUI: animation parameters must be finite");
    }
    this.#setProperty(id, property, to);
    this.#stats.collapsedAnimations += 1;
    return this.#nextAnimation++;
  }

  #cancelAnimation(animation: number): void {
    this.#assertOpen();
    if (!Number.isInteger(animation) || animation <= 0) {
      throw new RangeError("PocketTUI: animation id must be a positive integer");
    }
    // animate() completes synchronously at its final value, so cancellation is
    // intentionally stable and has nothing left to revoke.
  }

  #setFocus(id: number): void {
    this.#assertOpen();
    if (id !== 0) this.#node(id);
    if (this.#focused === id) return;
    this.#focused = id;
    this.#markMutation();
  }

  #setActive(id: number, active: number): void {
    this.#assertOpen();
    const node = this.#node(id);
    if (active !== 0 && active !== 1) throw new RangeError("PocketTUI: active must be 0 or 1");
    if (node.active === (active === 1)) return;
    node.active = active === 1;
    this.#markMutation();
  }

  #hitTest(x: number, y: number): number {
    this.#assertOpen();
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    for (let index = this.#lastPaintOrder.length - 1; index >= 0; index -= 1) {
      const id = this.#lastPaintOrder[index];
      if (id === undefined) continue;
      const entry = this.#lastLayout?.entries.get(id);
      if (entry !== undefined && contains(entry.rect, x, y)) return id;
    }
    return 0;
  }

  #loadFontAtlas(bytes: Uint8Array): void {
    this.#assertOpen();
    if (!(bytes instanceof Uint8Array)) throw new TypeError("PocketTUI: font atlas must be Uint8Array");
    this.#stats.ignoredFontAtlases += 1;
  }

  #measureText(value: string, fontSlot: number): number {
    this.#assertOpen();
    if (typeof value !== "string") throw new TypeError("PocketTUI: measureText requires a string");
    if (!Number.isInteger(fontSlot) || fontSlot < 0) {
      throw new RangeError("PocketTUI: font slot must be a non-negative integer");
    }
    return lineWidth(value);
  }

  #computedStyle(node: HostNode): ComputedStyle {
    const properties: PropertyMap = new Map();
    if (node.styleId !== STYLE_ID_NONE) {
      const record = this.#styles[node.styleId];
      if (record !== undefined) {
        assign(properties, record.base);
        if (node.id === this.#focused) assign(properties, record.focus);
        if (node.active) assign(properties, record.active);
      }
    }
    assign(properties, node.inline);
    const value = (property: number): number | undefined => properties.get(property);
    return {
      width: value(PROP.width),
      height: value(PROP.height),
      minWidth: value(PROP.minW),
      minHeight: value(PROP.minH),
      maxWidth: value(PROP.maxW),
      maxHeight: value(PROP.maxH),
      padding: {
        top: edge(value(PROP.paddingT)),
        right: edge(value(PROP.paddingR)),
        bottom: edge(value(PROP.paddingB)),
        left: edge(value(PROP.paddingL)),
      },
      margin: {
        top: edge(value(PROP.marginT)),
        right: edge(value(PROP.marginR)),
        bottom: edge(value(PROP.marginB)),
        left: edge(value(PROP.marginL)),
      },
      gap: edge(value(PROP.gap)),
      flexDirection: value(PROP.flexDir) ?? ENUM.flexColumn,
      justify: value(PROP.justify) ?? ENUM.justifyStart,
      align: value(PROP.align) ?? ENUM.alignStretch,
      grow: Math.max(0, value(PROP.grow) ?? 0),
      shrink: Math.max(0, value(PROP.shrink) ?? 1),
      basis: value(PROP.basis),
      position: value(PROP.posType) ?? ENUM.relative,
      inset: {
        top: value(PROP.insetT),
        right: value(PROP.insetR),
        bottom: value(PROP.insetB),
        left: value(PROP.insetL),
      },
      display: value(PROP.display) ?? ENUM.displayFlex,
      overflow: value(PROP.overflow) ?? ENUM.overflowVisible,
      zIndex: signed(value(PROP.zIndex) ?? 0),
      background: unsigned(value(PROP.bgColor) ?? 0),
      opacity: clamp01(value(PROP.opacity) ?? 1),
      borderColor: unsigned(value(PROP.borderColor) ?? 0),
      borderWidth: Math.max(0, value(PROP.borderWidth) ?? 0),
      textColor: unsigned(value(PROP.textColor) ?? 0xffff_ffff),
      textAlign: value(PROP.textAlign) ?? ENUM.textLeft,
      lineHeight: value(PROP.lineHeight),
      tracking: Math.max(0, value(PROP.tracking) ?? 0),
    };
  }

  #refreshPaintStyles(previous: LayoutResult): LayoutResult {
    if (this.#paintDirtyNodes.size === 0) return previous;
    const entries = beginMapTransaction(previous.entries);
    for (const node of this.#paintDirtyNodes) {
      const entry = entries.get(node.id);
      if (entry === undefined) continue;
      entries.set(node.id, {
        node: entry.node,
        style: this.#computedStyle(entry.node),
        rect: entry.rect,
      });
    }
    return { entries, flattenedText: previous.flattenedText };
  }

  /**
   * Recompute layout below absolute-positioned isolation roots. Absolute
   * children do not contribute to their parent's Flex measurement, so their
   * geometry may change without invalidating the cached parent or siblings.
   * Any connected dirty source without such a boundary returns undefined so
   * the cache-aware root Flex solver can preserve dependent flow semantics.
   */
  #localizedLayout(previous: LayoutResult): LocalizedLayoutResult | undefined {
    const candidates = new Set<HostNode>();
    for (const source of this.#layoutDirtyNodes) {
      if (!isAncestor(this.#root, source)) continue;
      let current: HostNode | null = source;
      let candidate: HostNode | undefined;
      while (current !== null) {
        const oldEntry = previous.entries.get(current.id);
        if (
          oldEntry !== undefined &&
          oldEntry.style.position === ENUM.absolute &&
          this.#computedStyle(current).position === ENUM.absolute
        ) {
          const parent = current.parent;
          if (
            parent !== null &&
            parent.type === NODE.view &&
            previous.entries.has(parent.id)
          ) {
            candidate = current;
          }
          break;
        }
        current = current.parent;
      }
      if (candidate === undefined) return undefined;
      candidates.add(candidate);
    }

    const roots = [...candidates].filter(
      (candidate) =>
        ![...candidates].some(
          (other) => other !== candidate && isAncestor(other, candidate),
        ),
    );
    const entries = beginMapTransaction(previous.entries);
    const flattenedText = beginMapTransaction(previous.flattenedText);
    const dirtyRows = new Set<number>();
    let layoutNodes = 0;
    let measuredNodes = 0;

    for (const root of roots) {
      this.#collectSubtreeRows(root, previous, dirtyRows);
      visitSubtree(root, (node) => {
        entries.delete(node.id);
        flattenedText.delete(node.id);
      });

      const parent = root.parent;
      const parentEntry = parent === null ? undefined : previous.entries.get(parent.id);
      if (parentEntry === undefined) return undefined;
      const partial = layoutAbsoluteSubtreeCached(root, parentEntry, (node) =>
        this.#computedStyle(node),
      );
      for (const [id, entry] of partial.result.entries) entries.set(id, entry);
      for (const [id, value] of partial.result.flattenedText) flattenedText.set(id, value);
      layoutNodes += partial.result.entries.size;
      measuredNodes += partial.measuredNodes;
      this.#collectSubtreeRows(root, partial.result, dirtyRows);
    }

    const layout = this.#refreshPaintStyles({ entries, flattenedText });
    this.#collectDirtyRows(previous, layout, dirtyRows);
    const cache = this.#invalidateLocalizedLayoutCache(this.#lastLayoutCache, roots);
    return { layout, cache, dirtyRows, roots, layoutNodes, measuredNodes };
  }

  #invalidateLocalizedLayoutCache(
    cache: LayoutCache | undefined,
    roots: readonly HostNode[],
  ): LayoutCache | undefined {
    if (cache === undefined || roots.length === 0) return cache;
    const geometryRevisions = beginMapTransaction(cache.geometryRevisions);
    const subtreeEntryCounts = beginMapTransaction(cache.subtreeEntryCounts);
    const invalidate = (node: HostNode): void => {
      geometryRevisions.delete(node.id);
      subtreeEntryCounts.delete(node.id);
    };
    for (const root of roots) {
      visitSubtree(root, invalidate);
      let ancestor = root.parent;
      while (ancestor !== null) {
        invalidate(ancestor);
        ancestor = ancestor.parent;
      }
    }
    return {
      ...cache,
      geometryRevisions,
      subtreeEntryCounts,
    };
  }

  #collectLayoutDirtyRows(
    previous: LayoutResult,
    current: LayoutResult,
    rows = new Set<number>(),
  ): Set<number> {
    const ids = new Set<number>();
    const preciseEntries = collectChangedMapKeys(current.entries, ids);
    const preciseText = collectChangedMapKeys(current.flattenedText, ids);
    const precise = preciseEntries && preciseText;
    if (!precise) {
      for (const id of previous.entries.keys()) ids.add(id);
      for (const id of current.entries.keys()) ids.add(id);
    }
    for (const id of ids) {
      const before = previous.entries.get(id);
      const after = current.entries.get(id);
      if (
        before === undefined ||
        after === undefined ||
        !sameRect(before.rect, after.rect) ||
        before.style.lineHeight !== after.style.lineHeight ||
        previous.flattenedText.get(id) !== current.flattenedText.get(id)
      ) {
        this.#collectRectRows(before?.rect, rows);
        this.#collectRectRows(after?.rect, rows);
      }
    }
    return rows;
  }

  #collectDirtyRows(
    previous: LayoutResult,
    current: LayoutResult,
    rows = new Set<number>(),
  ): Set<number> {
    for (const node of this.#paintDirtyNodes) {
      this.#collectSubtreeRows(node, previous, rows);
      this.#collectSubtreeRows(node, current, rows);
    }
    return rows;
  }

  #collectSubtreeRows(node: HostNode, layout: LayoutResult, rows: Set<number>): void {
    const visited = new Set<number>();
    const collect = (node: HostNode): void => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      const rect = layout.entries.get(node.id)?.rect;
      this.#collectRectRows(rect, rows);
      for (const child of node.children) collect(child);
    };
    collect(node);
  }

  #collectRectRows(rect: Rect | undefined, rows: Set<number>): void {
    if (rect === undefined) return;
    const start = Math.max(0, rect.y);
    const end = Math.min(this.#viewport.rows, rect.y + rect.height);
    for (let row = start; row < end; row += 1) rows.add(row);
  }

  #node(id: number): HostNode {
    if (!Number.isInteger(id) || id <= 0 || id > 0x7fff_ffff) {
      throw new RangeError(`PocketTUI: invalid PocketJS node id ${id}`);
    }
    const slot = id & ID_SLOT_MASK;
    const generation = Math.floor(id / 2 ** ID_SLOT_BITS);
    const entry = this.#slots[slot];
    if (entry === undefined || entry.generation !== generation || entry.node?.id !== id) {
      throw new Error(`PocketTUI: stale PocketJS node id ${id}`);
    }
    return entry.node;
  }

  #releaseId(id: number): void {
    const slot = id & ID_SLOT_MASK;
    const entry = this.#slots[slot];
    if (entry === undefined) throw new Error("PocketTUI: missing node slot during release");
    entry.node = undefined;
    if (entry.generation >= MAX_GENERATION) {
      entry.quarantined = true;
      return;
    }
    entry.generation += 1;
    this.#freeSlots.push(slot);
  }

  #unlink(node: HostNode): void {
    const parent = node.parent;
    if (parent === null) return;
    const index = parent.children.indexOf(node);
    if (index < 0) throw new Error("PocketTUI: corrupt retained parent link");
    parent.children.splice(index, 1);
    node.parent = null;
  }

  #markMutation(): void {
    const wasClean = this.#dirty === undefined;
    this.#dirty = "full";
    this.#layoutDirtyNodes.clear();
    this.#paintDirtyNodes.clear();
    this.#mutationRevision += 1;
    this.#stats.mutations += 1;
    if (wasClean) this.#notifyWorkNeeded();
  }

  #markLayoutMutation(node: HostNode): void {
    const wasClean = this.#dirty === undefined;
    if (this.#dirty !== "full") {
      this.#dirty = "layout";
      this.#layoutDirtyNodes.add(node);
    }
    const revision = ++this.#layoutRevision;
    let current: HostNode | null = node;
    while (current !== null) {
      current.layoutRevision = revision;
      current = current.parent;
    }
    this.#mutationRevision += 1;
    this.#stats.mutations += 1;
    if (wasClean) this.#notifyWorkNeeded();
  }

  #markPaintMutation(node: HostNode): void {
    const wasClean = this.#dirty === undefined;
    if (this.#dirty !== "full") {
      if (this.#dirty === undefined) this.#dirty = "paint";
      this.#paintDirtyNodes.add(node);
    }
    this.#mutationRevision += 1;
    this.#stats.mutations += 1;
    if (wasClean) this.#notifyWorkNeeded();
  }

  #markSurfaceMutation(): void {
    if (this.#setSurfacePending()) this.#notifyWorkNeeded();
  }

  #setSurfacePending(): boolean {
    const shouldNotify = !this.#surfacePending;
    this.#surfacePending = true;
    this.#surfaceRevision += 1;
    return shouldNotify;
  }

  #notifyWorkNeeded(): void {
    if (this.#rendering) {
      this.#renderNotificationPending = true;
      return;
    }
    for (const listener of [...this.#workListeners]) listener();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("PocketTUI: host is closed");
  }
}

export function createPocketTuiHost(options: PocketTuiHostOptions = {}): PocketTuiHost {
  return new PocketTuiHost(options);
}

function createNodeRecord(id: number, type: number): HostNode {
  return {
    id,
    type,
    layoutRevision: 0,
    parent: null,
    children: [],
    text: "",
    styleId: STYLE_ID_NONE,
    inline: new Map(),
    active: false,
    image: -1,
  };
}

function assign(target: PropertyMap, source: ReadonlyMap<number, number>): void {
  for (const [property, value] of source) target.set(property, value);
}

function edge(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.round(value));
}

function signed(value: number): number {
  return value >>> 0 > 0x7fff_ffff ? (value >>> 0) - 0x1_0000_0000 : value;
}

function unsigned(value: number): number {
  return value >>> 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isAncestor(candidate: HostNode, node: HostNode): boolean {
  let current: HostNode | null = node;
  while (current !== null) {
    if (current === candidate) return true;
    current = current.parent;
  }
  return false;
}

function visitSubtree(node: HostNode, visit: (node: HostNode) => void): void {
  visit(node);
  for (const child of node.children) visitSubtree(child, visit);
}

function depth(node: HostNode): number {
  let result = 0;
  let current = node.parent;
  while (current !== null) {
    result += 1;
    current = current.parent;
  }
  return result;
}

function subtreeDepth(node: HostNode): number {
  let result = 1;
  for (const child of node.children) result = Math.max(result, 1 + subtreeDepth(child));
  return result;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function sameRect(left: Rect, right: Rect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function validateViewport(size: TuiViewportSize): TuiViewportSize {
  if (
    !Number.isInteger(size.columns) ||
    !Number.isInteger(size.rows) ||
    size.columns <= 0 ||
    size.rows <= 0 ||
    size.columns > 0xffff ||
    size.rows > 0xffff ||
    size.columns * size.rows > 1_000_000
  ) {
    throw new RangeError("PocketTUI: viewport must contain 1..1,000,000 addressable cells");
  }
  return { columns: size.columns, rows: size.rows };
}

function validateEnum(property: number, value: number): void {
  const valid = (minimum: number, maximum: number): void => {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`PocketTUI: property ${property} has invalid enum value ${value}`);
    }
  };
  switch (property) {
    case PROP.flexDir:
    case PROP.posType:
    case PROP.display:
    case PROP.overflow:
    case PROP.flexWrap:
      valid(0, 1);
      break;
    case PROP.justify:
      valid(0, 4);
      break;
    case PROP.align:
      valid(0, 3);
      break;
    case PROP.textAlign:
      valid(0, 2);
      break;
    default:
      break;
  }
}

function defaultColorMode(): PocketTuiColorMode {
  const processLike = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  return processLike?.env?.POCKET_TUI_GHOSTTY_EFFECTS === "1" ? "truecolor" : "ansi16";
}
