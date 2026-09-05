import test from "node:test";
import assert from "node:assert/strict";
import { verifyReleaseAssets } from "./verify-release-assets.mjs";

const payload = (assets) => ({ isDraft: false, assets });
const valid = [
  { name: "FolioMind_0.1.224_aarch64.dmg", size: 12 },
  { name: "FolioMind_0.1.224_x64-setup.exe", size: 13 },
  { name: "FolioMind_0.1.224_x64_en-US.msi", size: 14 },
  { name: "SHA256SUMS.txt", size: 292 },
];

test("accepts the exact published installer set", () => {
  assert.equal(verifyReleaseAssets(payload(valid), "0.1.224").assets.length, 4);
});

test("rejects a draft, missing installer, duplicate, or empty asset", () => {
  assert.throws(() => verifyReleaseAssets({ isDraft: true, assets: valid }, "0.1.224"), /draft/);
  assert.throws(() => verifyReleaseAssets(payload(valid.slice(0, 3)), "0.1.224"), /资产不完整/);
  assert.throws(() => verifyReleaseAssets(payload([...valid, valid[0]]), "0.1.224"), /资产不完整/);
  assert.throws(() => verifyReleaseAssets(payload(valid.map((asset) => asset.name === "SHA256SUMS.txt" ? { ...asset, size: 0 } : asset)), "0.1.224"), /大小无效/);
});
