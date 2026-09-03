import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDir = new URL("../dist/client/assets/", import.meta.url);
const assetsPath = fileURLToPath(assetsDir);
const files = await readdir(assetsDir);
const entryFiles = files.filter((file) => /^index-[\w-]+\.js$/.test(file));
if (!entryFiles.length) throw new Error("未找到生产入口 JavaScript chunk");

const entries = await Promise.all(entryFiles.map(async (file) => ({ file, size: (await stat(join(assetsPath, file))).size })));
const entry = entries.sort((left, right) => right.size - left.size)[0];
const maxBytes = 450 * 1024;
if (entry.size > maxBytes) throw new Error(`首屏入口 ${entry.file} 为 ${(entry.size / 1024).toFixed(1)}KB，超过 450KB 门禁`);
if (!files.some((file) => /^SecondaryViews-[\w-]+\.js$/.test(file))) throw new Error("SecondaryViews 未生成独立异步 chunk");

console.log(`Bundle budget passed: ${entry.file} ${(entry.size / 1024).toFixed(1)}KB; SecondaryViews async chunk present`);
