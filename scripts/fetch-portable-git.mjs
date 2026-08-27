import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(import.meta.dirname, "portable-git-version.json"), "utf8"));
const output = join(root, "src-tauri/resources/portable-git");
const marker = join(output, ".version");
const target = process.env.PI_TARGET_PLATFORM || (process.platform === "win32" ? `windows-${process.arch}` : "");

mkdirSync(output, { recursive: true });
if (!target.startsWith("windows-")) {
  console.log("[fetch-bash] non-Windows target; PortableGit is not required");
  process.exit(0);
}

const asset = lock.assets[target];
if (!asset) throw new Error(`Unsupported PortableGit target: ${target}`);
const git = join(output, "cmd/git.exe");
const bash = join(output, "bin/bash.exe");
if (existsSync(marker) && readFileSync(marker, "utf8").trim() === lock.version && existsSync(git) && existsSync(bash)) {
  console.log(`[fetch-bash] PortableGit ${lock.version} already present`);
  process.exit(0);
}

const cache = join(root, ".cache/portable-git");
const archive = join(cache, asset.name);
mkdirSync(cache, { recursive: true });
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
if (existsSync(archive) && digest(archive) !== asset.sha256) rmSync(archive, { force: true });
if (!existsSync(archive)) {
  const url = `https://github.com/git-for-windows/git/releases/download/${lock.tag}/${asset.name}`;
  console.log(`[fetch-bash] downloading ${url}`);
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`PortableGit download failed: HTTP ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (digest(archive) !== asset.sha256) { rmSync(archive, { force: true }); throw new Error("PortableGit SHA-256 mismatch"); }

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const extraction = spawnSync(archive, [`-o${output}`, "-y"], { stdio: "inherit", windowsHide: true });
if (extraction.status !== 0 || !existsSync(git) || !existsSync(bash)) throw new Error("PortableGit extraction failed or Bash is missing");
writeFileSync(marker, `${lock.version}\n`);
console.log(`[fetch-bash] installed PortableGit ${lock.version}`);
