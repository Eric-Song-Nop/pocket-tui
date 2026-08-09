import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const library =
  platform === "darwin"
    ? "libpocket_tui_napi.dylib"
    : platform === "win32"
      ? "pocket_tui_napi.dll"
      : "libpocket_tui_napi.so";

const source = resolve(root, "target", "release", library);
const outputDirectory = resolve(root, "packages", "core", "native");
const output = resolve(outputDirectory, `pocket-tui.${platform}-${arch}.node`);

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(source, output);
console.log(output);

