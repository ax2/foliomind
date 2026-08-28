import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = () => { clearTimeout(timer); resolveExit(true); };
    const timer = setTimeout(() => { child.off("exit", finish); resolveExit(false); }, timeoutMs);
    child.once("exit", finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child, 2_000);
  child.kill();
  if (await exited) return;
  const forcedExit = waitForExit(child, 2_000);
  child.kill("SIGKILL");
  await forcedExit;
}

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
const stderr = [];
let stderrLength = 0;
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  if (stderrLength >= 8_192) return;
  const bounded = chunk.slice(0, 8_192 - stderrLength);
  stderr.push(bounded);
  stderrLength += bounded.length;
});
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
child.stdin.write(`${JSON.stringify({ id: "smoke-1", type: "get_commands" })}\n`);
child.stdin.write(`${JSON.stringify({ id: "smoke-2", type: "get_state" })}\n`);

let commandReady = false;
let modelReady = false;
try {
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
  if (!commandReady || !modelReady) {
    const reason = timedOut ? "timed out" : `exited before completing (code ${child.exitCode}, signal ${child.signalCode})`;
    const detail = stderr.join("").trim();
    throw new Error(`Pi smoke test ${reason}${detail ? `: ${detail}` : ""}`);
  }
} finally {
  clearTimeout(timeout);
  lines.close();
  await terminateChild(child);
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
