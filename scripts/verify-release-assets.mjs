import { readFile } from "node:fs/promises";

const installerNames = (version) => [
  `FolioMind_${version}_aarch64.dmg`,
  `FolioMind_${version}_x64-setup.exe`,
  `FolioMind_${version}_x64_en-US.msi`,
  "SHA256SUMS.txt",
];

export function verifyReleaseAssets(payload, version) {
  const release = payload && typeof payload === "object" ? payload : {};
  if (release.isDraft === true) throw new Error("Release 仍为 draft，不能作为正式交付");
  if (!Array.isArray(release.assets)) throw new Error("Release 缺少资产列表");
  const expected = installerNames(String(version || "").trim());
  const assets = release.assets.map((asset) => ({ name: String(asset?.name || ""), size: Number(asset?.size) }));
  const names = assets.map((asset) => asset.name).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected.slice().sort()[index])) {
    throw new Error(`Release 资产不完整：期望 ${expected.join(", ")}，实际 ${names.join(", ")}`);
  }
  for (const asset of assets) {
    if (!Number.isInteger(asset.size) || asset.size <= 0) throw new Error(`Release 资产大小无效：${asset.name}`);
  }
  return { version: String(version), assets };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2];
  if (!version) throw new Error("用法：verify-release-assets.mjs <version>");
  const input = await readFile("/dev/stdin", "utf8");
  const result = verifyReleaseAssets(JSON.parse(input), version);
  console.log(`Release asset verification passed: v${result.version} (${result.assets.length} assets)`);
}
