import {
  createElement,
  createTextNode,
  effect,
  insertNode,
  replaceText,
  setProp,
  type NodeMirror,
} from "@pocket-tui/pocketjs";

export type PocketStyle = Readonly<Record<string, number | string>>;
export type ReactiveValue<T> = T | (() => T);

/**
 * Small source-level helpers for the PocketJS universal renderer.
 *
 * These calls are the same retained operations emitted by PocketJS's Solid
 * JSX transform. Keeping the demo directly executable by Bun makes the host
 * boundary visible: every element and reactive update still crosses the real
 * PocketJS HostOps contract implemented by @pocket-tui/pocketjs.
 */
export function pocketView(
  style: ReactiveValue<PocketStyle>,
  ...children: readonly NodeMirror[]
): NodeMirror {
  const node = createElement("view");
  bindStyle(node, style);
  appendPocketChildren(node, ...children);
  return node;
}

export function pocketText(
  value: ReactiveValue<string>,
  style: ReactiveValue<PocketStyle>,
): NodeMirror {
  const node = createElement("text");
  const content = createTextNode("");
  insertNode(node, content);
  bindStyle(node, style);
  bindText(content, value);
  return node;
}

export function appendPocketChildren(
  parent: NodeMirror,
  ...children: readonly NodeMirror[]
): NodeMirror {
  for (const child of children) insertNode(parent, child);
  return parent;
}

export function bindStyle(node: NodeMirror, value: ReactiveValue<PocketStyle>): void {
  if (typeof value !== "function") {
    setProp(node, "style", value);
    return;
  }
  effect<PocketStyle | undefined>((previous) => {
    const next = value();
    setProp(node, "style", next, previous);
    return next;
  });
}

export function bindText(node: NodeMirror, value: ReactiveValue<string>): void {
  if (typeof value !== "function") {
    replaceText(node, value);
    return;
  }
  effect<string | undefined>((previous) => {
    const next = value();
    if (next !== previous) replaceText(node, next);
    return next;
  });
}
