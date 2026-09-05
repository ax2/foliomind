import test from "node:test";
import assert from "node:assert/strict";
import { GENERATED_PATHS } from "./clean-generated.mjs";

test("cleaner keeps an explicit, runtime-safe generated path allowlist", () => {
  assert.deepEqual([...GENERATED_PATHS], [
    "dist",
    ".qa",
    ".cache",
    "src-tauri/target",
    "src-tauri/target-linux",
  ]);
  for (const protectedPath of ["src-tauri/resources/pi", "src-tauri/resources/portable-git", "src", "package.json"]) {
    assert.equal(GENERATED_PATHS.includes(protectedPath), false, `protected path entered cleanup allowlist: ${protectedPath}`);
  }
});
