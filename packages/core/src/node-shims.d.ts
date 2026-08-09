declare module "node:module" {
  export function createRequire(url: string | URL): (id: string) => unknown;
}

declare module "node:process" {
  export const arch: string;
  export const platform: string;
}
