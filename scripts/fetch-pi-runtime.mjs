import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(root, "scripts/pi-version.json"), "utf8"));
const target = process.env.PI_TARGET_PLATFORM || `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const windows = target.startsWith("windows-");
const archiveName = `pi-${target}.${windows ? "zip" : "tar.gz"}`;
const binaryName = windows ? "pi.exe" : "pi";
const output = join(root, "src-tauri/resources/pi");
const marker = join(output, ".version");
const binary = join(output, binaryName);

if (existsSync(marker) && readFileSync(marker, "utf8").trim() === lock.version && existsSync(binary)) {
  console.log(`[fetch-pi] pi ${lock.version} already present`);
  process.exit(0);
}
if (!lock.sha256[archiveName]) throw new Error(`Unsupported Pi target: ${target}`);

const cache = join(root, ".cache/pi-binaries");
const archive = join(cache, `${lock.version}-${archiveName}`);
mkdirSync(cache, { recursive: true });
if (!existsSync(archive)) {
  const url = `https://github.com/earendil-works/pi-mono/releases/download/v${lock.version}/${archiveName}`;
  console.log(`[fetch-pi] downloading ${url}`);
  try {
    execFileSync("curl", ["--fail", "--location", "--retry", "3", "--connect-timeout", "30", "--max-time", "600", "--output", archive, url], { stdio: "inherit" });
  } catch (curlError) {
    rmSync(archive, { force: true });
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`Pi download failed: HTTP ${response.status}`, { cause: curlError });
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
}
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (digest !== lock.sha256[archiveName]) {
  rmSync(archive, { force: true });
  throw new Error(`Pi checksum mismatch for ${archiveName}`);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
execFileSync("tar", [windows ? "-xf" : "-xzf", archive, "-C", output], { stdio: "inherit" });
const wrapper = join(output, "pi");
if (existsSync(wrapper) && statSync(wrapper).isDirectory()) {
  const staging = join(output, `pi-wrapper-${process.pid}`);
  renameSync(wrapper, staging);
  for (const entry of readdirSync(staging)) renameSync(join(staging, entry), join(output, entry));
  rmSync(staging, { recursive: true, force: true });
}
if (!existsSync(binary)) throw new Error(`Pi archive did not contain ${binaryName}`);
if (!windows) chmodSync(binary, 0o755);
writeFileSync(marker, `${lock.version}\n`);
console.log(`[fetch-pi] installed pi ${lock.version} for ${target}`);
