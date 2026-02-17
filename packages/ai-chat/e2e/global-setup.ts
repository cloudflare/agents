/**
 * Playwright global setup: kill any stale process on the test port
 * left behind by a previous run that was forcefully terminated.
 */
import { execSync } from "node:child_process";

const PORT = 8799;

function killProcessOnPort(port: number): void {
  try {
    const output = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`)
      .toString()
      .trim();
    if (output) {
      const pids = output.split("\n").filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGKILL");
          console.log(
            `[global-setup] Killed stale process ${pid} on port ${port}`
          );
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // lsof not available or other error — ignore
  }
}

export default function globalSetup() {
  killProcessOnPort(PORT);
}
