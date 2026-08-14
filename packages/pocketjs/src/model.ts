import type { PropertyMap } from "./style.js";

export interface HostNode {
  readonly id: number;
  readonly type: number;
  parent: HostNode | null;
  readonly children: HostNode[];
  text: string;
  styleId: number;
  readonly inline: PropertyMap;
  active: boolean;
  image: number;
}

export interface Edges {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ComputedStyle {
  readonly width?: number;
  readonly height?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly padding: Edges;
  readonly margin: Edges;
  readonly gap: number;
  readonly flexDirection: number;
  readonly justify: number;
  readonly align: number;
  readonly grow: number;
  readonly shrink: number;
  readonly basis?: number;
  readonly position: number;
  readonly inset: Partial<Edges>;
  readonly display: number;
  readonly overflow: number;
  readonly zIndex: number;
  readonly background: number;
  readonly opacity: number;
  readonly borderColor: number;
  readonly borderWidth: number;
  readonly textColor: number;
  readonly textAlign: number;
  readonly lineHeight?: number;
  readonly tracking: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutEntry {
  readonly node: HostNode;
  readonly style: ComputedStyle;
  readonly rect: Rect;
}

export interface LayoutResult {
  readonly entries: ReadonlyMap<number, LayoutEntry>;
  readonly flattenedText: ReadonlyMap<number, string>;
}
