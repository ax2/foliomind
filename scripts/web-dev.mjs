import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { startLocalHost } from "./local-host.mjs";

function availablePort(preferred) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(preferred + 1));
    probe.listen(preferred, "127.0.0.1", () => probe.close(() => resolve(preferred)));
  });
}

const port = await availablePort(Number(process.env.FOLIOMIND_HOST_PORT || 43123));
const webPort = await availablePort(Number(process.env.FOLIOMIND_WEB_PORT || 5173));
process.env.FOLIOMIND_HOST_PORT = String(port);
process.env.VITE_FOLIOMIND_HOST_PORT = String(port);
process.env.FOLIOMIND_WEB_PORT = String(webPort);
const host = startLocalHost({ port });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const vite = spawn(npm, ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(webPort)], { stdio: "inherit", env: process.env });
console.log(`[foliomind-web] Web + standalone Dev Host ready: http://127.0.0.1:${webPort}`);
console.log(`[foliomind-web] Host API: http://127.0.0.1:${port} (无需启动桌面端)`);
const shutdown = () => { host.close(); if (!vite.killed) vite.kill("SIGTERM"); };
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
vite.once("exit", (code, signal) => { host.close(); if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });
