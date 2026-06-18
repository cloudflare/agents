/**
 * Shared harness for runFiber recovery e2e tests.
 *
 * Spawns a real `wrangler dev`, supports SIGKILL + restart against a
 * `--persist-to` dir (mimicking DO eviction), and does WebSocket RPC to
 * `@callable` methods. Parameterised by port + persist dir so multiple test
 * files can run against the same worker without colliding.
 *
 * Not a `*.test.ts` file, so vitest does not collect it as a suite.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily, Socket } from "node:net";

// Disable happy-eyeballs dual-stack racing. When a probe `fetch`/WebSocket
// connects to a server that is mid-SIGKILL/restart, the abandoned racing socket
// can throw a connect-time `setTypeOfService` EINVAL that surfaces as an
// unhandled error and fails an otherwise-green chaos run.
setDefaultAutoSelectFamily(false);

// Write-time variant: undici's `writeH1` calls `socket.setTypeOfService(...)` on
// every request when the socket exposes it. Against a server being torn down the
// `setsockopt(IP_TOS)` syscall returns EINVAL, thrown *synchronously* inside
// undici. We never use IP type-of-service, so make the optional setter
// best-effort.
{
  const proto = Socket.prototype as unknown as {
    setTypeOfService?: (tos: number) => unknown;
  };
  const original = proto.setTypeOfService;
  if (typeof original === "function") {
    proto.setTypeOfService = function (this: unknown, tos: number) {
      try {
        return original.call(this, tos);
      } catch {
        return this;
      }
    };
  }
}

export interface Harness {
  configPath: string;
  port: number;
  persistDir: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function killProcessOnPort(port: number): void {
  try {
    const output = execSync(
      `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`
    )
      .toString()
      .trim();
    if (output) {
      const pids = output.split("\n").filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGKILL");
          console.log(`[setup] Killed stale process ${pid} on port ${port}`);
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // lsof not available or other error
  }
}

function killProcessTree(pid: number): void {
  let children: number[] = [];
  try {
    children = execSync(`pgrep -P ${pid} 2>/dev/null || true`)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    // pgrep may be unavailable; killing the parent is still useful.
  }
  for (const childPid of children) {
    killProcessTree(childPid);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead
  }
}

export function startWrangler(h: Harness): ChildProcess {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      h.configPath,
      "--port",
      String(h.port),
      "--persist-to",
      h.persistDir,
      "--inspector-port",
      "0"
    ],
    {
      cwd: h.configPath.replace(/\/wrangler\.jsonc$/, ""),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" }
    }
  );

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler:${h.port}] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler:${h.port}:err] ${line}`);
  });

  return child;
}

export async function waitForReady(
  h: Harness,
  maxAttempts = 30,
  delayMs = 1000
): Promise<void> {
  const url = `http://localhost:${h.port}/`;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // Not ready yet
    }
    await sleep(delayMs);
  }
  throw new Error(`Wrangler did not start within ${maxAttempts * delayMs}ms`);
}

export async function waitForPortFree(
  h: Harness,
  maxAttempts = 30,
  delayMs = 500
): Promise<void> {
  const url = `http://localhost:${h.port}/`;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      await res.body?.cancel();
    } catch {
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(
    `Port ${h.port} did not free within ${maxAttempts * delayMs}ms`
  );
}

export function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }
    const fallback = setTimeout(resolve, 3000);
    child.on("exit", () => {
      clearTimeout(fallback);
      resolve();
    });
    killProcessTree(child.pid);
  });
}

export async function callAgentByPath(
  h: Harness,
  agentPath: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `ws://localhost:${h.port}${agentPath}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC call ${method} timed out`));
    }, 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timeout);
          ws.close();
          if (msg.success) {
            resolve(msg.result);
          } else {
            reject(new Error(msg.error || "RPC failed"));
          }
        }
      } catch {
        // Ignore non-RPC messages
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}
