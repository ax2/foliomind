import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const binary = join(root, "src-tauri/resources/pi", process.platform === "win32" ? "pi.exe" : "pi");
const extension = join(root, "packages/qveris-bridge/index.mjs");
const skill = join(root, "skills/qveris-finance-research");
const agentDir = mkdtempSync(join(tmpdir(), "foliomind-pi-smoke-"));
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { qveris: { baseUrl: "http://127.0.0.1:43211/model/v1", api: "openai-completions", apiKey: "FOLIOMIND_MODEL_TOKEN", authHeader: true, models: [{ id: "smoke-model", name: "Smoke Model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024 }] } } }));
const child = spawn(binary, ["--extension", extension, "--skill", skill, "--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--tools", "bash,qveris_search,qveris_inspect,qveris_call", "--provider", "qveris", "--model", "smoke-model"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    QVERIS_EXECUTOR_URL: "http://127.0.0.1:43210",
    QVERIS_MANAGED_CAPABILITY: "cap_smoke_only",
    QVERIS_PI_RUN_ID: "smoke-run",
    QVERIS_PRODUCT_RUN_ID: "smoke-product-run",
    FOLIOMIND_MODEL_TOKEN: "model_smoke_only",
    PI_CODING_AGENT_DIR: agentDir,
  },
});

const lines = createInterface({ input: child.stdout });
const timeout = setTimeout(() => child.kill(), 10_000);
child.stdin.write(`${JSON.stringify({ id: "smoke-1", type: "get_commands" })}\n`);
child.stdin.write(`${JSON.stringify({ id: "smoke-2", type: "get_state" })}\n`);

try {
  let commandReady = false;
  let modelReady = false;
  for await (const line of lines) {
    const frame = JSON.parse(line);
    if (frame.id !== "smoke-1" && frame.id !== "smoke-2") continue;
    if (frame.type !== "response" || frame.success !== true) throw new Error(`Unexpected Pi response: ${line}`);
    if (frame.id === "smoke-1") {
      const names = new Set((frame.data?.commands || []).map((command) => command.name));
      if (!names.has("qveris-status")) throw new Error("Pi did not load the QVeris bridge command");
      commandReady = true;
    }
    if (frame.id === "smoke-2") {
      if (frame.data?.model?.provider !== "qveris" || frame.data?.model?.id !== "smoke-model") throw new Error(`Pi did not load the managed QVeris model: ${line}`);
      modelReady = true;
    }
    if (commandReady && modelReady) { console.log("Pi RPC loaded the QVeris bridge, Skill flags, and managed model config"); break; }
  }
} finally {
  clearTimeout(timeout);
  child.kill();
  rmSync(agentDir, { recursive: true, force: true });
}
