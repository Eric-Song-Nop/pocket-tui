import { createRequire } from "node:module";
import { arch, platform } from "node:process";

export interface NativeTuiSession {
  submit(packet: Uint8Array): string;
  start(): void;
  flush(): void;
  close(): void;
}

export interface NativeBinding {
  NativeTui: new () => NativeTuiSession;
  nativeVersion(): string;
}

let cachedBinding: NativeBinding | undefined;

/** Load the platform N-API artifact produced by `bun run build:native`. */
export function loadNativeBinding(explicitPath?: string): NativeBinding {
  if (explicitPath === undefined && cachedBinding !== undefined) return cachedBinding;

  const filename = explicitPath ?? nativeArtifactUrl().pathname;
  const require = createRequire(import.meta.url);
  let loaded: unknown;
  try {
    loaded = require(decodePathname(filename));
  } catch (cause) {
    const error = new Error(
      `PocketTUI native binding was not found at ${decodePathname(filename)}. ` +
        "Run `bun run build:native` from the PocketTUI workspace first.",
      { cause },
    );
    error.name = "NativeBindingError";
    throw error;
  }
  assertNativeBinding(loaded);
  if (explicitPath === undefined) cachedBinding = loaded;
  return loaded;
}

function nativeArtifactUrl(): URL {
  return new URL(
    `../native/pocket-tui.${normalizePlatform(platform)}-${normalizeArch(arch)}.node`,
    import.meta.url,
  );
}

function normalizePlatform(platform: string): string {
  switch (platform) {
    case "darwin":
    case "linux":
    case "win32":
      return platform;
    default:
      return platform;
  }
}

function normalizeArch(arch: string): string {
  return arch === "x64" || arch === "arm64" ? arch : arch;
}

function decodePathname(pathname: string): string {
  if (!pathname.startsWith("/")) return pathname;
  const decoded = decodeURIComponent(pathname);
  return platform === "win32" && /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

function assertNativeBinding(value: unknown): asserts value is NativeBinding {
  const candidate = value as Partial<NativeBinding> | undefined;
  if (
    candidate === undefined ||
    typeof candidate !== "object" ||
    typeof candidate.NativeTui !== "function" ||
    typeof candidate.nativeVersion !== "function"
  ) {
    throw new TypeError("PocketTUI native artifact does not expose the expected N-API surface");
  }
}
