import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const binary = join(root, "src-tauri/resources/pi", process.platform === "win32" ? "pi.exe" : "pi");
const extension = join(root, "packages/qveris-bridge/index.mjs");
const child = spawn(binary, ["--extension", extension, "--mode", "rpc", "--no-session"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    QVERIS_EXECUTOR_URL: "http://127.0.0.1:43210",
    QVERIS_MANAGED_CAPABILITY: "cap_smoke_only",
    QVERIS_PI_RUN_ID: "smoke-run",
    QVERIS_PRODUCT_RUN_ID: "smoke-product-run",
  },
});

const lines = createInterface({ input: child.stdout });
const timeout = setTimeout(() => child.kill(), 10_000);
child.stdin.write(`${JSON.stringify({ id: "smoke-1", type: "get_commands" })}\n`);

try {
  for await (const line of lines) {
    const frame = JSON.parse(line);
    if (frame.id !== "smoke-1") continue;
    if (frame.type !== "response" || frame.success !== true) throw new Error(`Unexpected Pi response: ${line}`);
    const names = new Set((frame.data?.commands || []).map((command) => command.name));
    if (!names.has("qveris-status")) throw new Error("Pi did not load the QVeris bridge command");
    console.log("Pi RPC loaded the QVeris bridge");
    break;
  }
} finally {
  clearTimeout(timeout);
  child.kill();
}
