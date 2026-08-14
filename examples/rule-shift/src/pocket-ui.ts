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
 * Tiny source helpers around PocketJS's real universal renderer operations.
 * They keep this example executable directly in Bun without hiding the
 * HostOps boundary behind an example-specific canvas abstraction.
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
