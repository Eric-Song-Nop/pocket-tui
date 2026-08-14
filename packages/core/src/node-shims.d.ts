declare module "node:module" {
  export function createRequire(url: string | URL): (id: string) => unknown;
}

declare module "node:process" {
  export const arch: string;
  export const platform: string;
}

declare const process: {
  readonly argv: string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  once(signal: string, listener: () => void): unknown;
  exit(code?: number): never;
};
