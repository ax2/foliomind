import { lstat, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Keep this list deliberately explicit. Runtime resources such as Pi, the
// portable shell and every source directory must never be swept by cleanup.
export const GENERATED_PATHS = Object.freeze([
  "dist",
  ".qa",
  ".cache",
  "src-tauri/target",
  "src-tauri/target-linux",
]);

const dryRun = process.argv.includes("--dry-run");

for (const relativePath of GENERATED_PATHS) {
  const target = resolve(root, relativePath);
  const resolvedRelative = relative(root, target);
  if (resolvedRelative !== relativePath || resolvedRelative.startsWith("..")) {
    throw new Error(`拒绝清理工作区外路径: ${relativePath}`);
  }
  try {
    const info = await lstat(target);
    if (dryRun) {
      console.log(`Would remove ${relativePath}${info.isDirectory() ? "/" : ""}`);
    } else {
      await rm(target, { recursive: info.isDirectory(), force: true });
      console.log(`Removed ${relativePath}${info.isDirectory() ? "/" : ""}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
}

if (dryRun) console.log("Dry run complete; no files were changed.");
