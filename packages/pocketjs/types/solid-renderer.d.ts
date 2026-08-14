export interface NodeMirror {
  id: number;
  type: number;
  parent: NodeMirror | null;
  children: NodeMirror[];
  text?: string;
  domNodeType?: number;
  domTag?: string;
  domAttrs?: Record<string, unknown>;
  domData?: string;
  focusable?: boolean;
  onPress?: (() => void) | undefined;
  debugName?: string;
}

export type HostProps = Record<string, unknown>;

export function createElement(type: string): NodeMirror;
export function createTextNode(value: string): NodeMirror;
export function insertNode(
  parent: NodeMirror,
  node: NodeMirror,
  anchor?: NodeMirror | null,
): void;
export function replaceText(node: NodeMirror, value: string): void;
export function setProp<T>(node: NodeMirror, name: string, value: T, previous?: T): T;
export function effect<T>(callback: (previous?: T) => T, initial?: T): void;
export function render(code: () => NodeMirror, root: NodeMirror): () => void;
export function retain(node: NodeMirror): void;
export function release(node: NodeMirror): void;
export function runSweep(): void;
