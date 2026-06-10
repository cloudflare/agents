/**
 * Shared e2e harness for ai-chat recovery tests: real `wrangler dev` process
 * lifecycle, port probing, and a tiny WebSocket RPC/chat client.
 *
 * Importing this module also applies the happy-eyeballs / setTypeOfService
 * hardening that keeps probes against a server mid-SIGKILL/restart from
 * surfacing benign connect-time EINVAL as unhandled errors.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily, Socket } from "node:net";

// Disable happy-eyeballs dual-stack racing. When a probe `fetch`/WebSocket
// connects to a server that is mid-SIGKILL/restart, the abandoned racing socket
// can throw a connect-time `setTypeOfService` EINVAL that surfaces as an
// unhandled error and fails an otherwise-green chaos run.
setDefaultAutoSelectFamily(false);

// Write-time variant of the same hazard: undici's `writeH1` calls
// `socket.setTypeOfService(...)` on every request. Against a server being torn
// down the underlying `setsockopt(IP_TOS)` syscall returns EINVAL, which Node
// throws *synchronously* inside undici — there is no call site to catch it. We
// never use IP type-of-service in these probes, so make the optional setter
// best-effort: still apply it on healthy sockets, swallow the teardown EINVAL.
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
      for (const pid of output.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already dead
        }
      }
    }
  } catch {
    // lsof not available
  }
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
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
  });
}

export type WranglerHarness = {
  readonly url: string;
  start(): ChildProcess;
  waitForReady(maxAttempts?: number, delayMs?: number): Promise<void>;
  waitForPortFree(maxAttempts?: number, delayMs?: number): Promise<void>;
  restart(child: ChildProcess): Promise<ChildProcess>;
};

export function createWranglerHarness(opts: {
  port: number;
  persistDir: string;
  configPath: string;
  cwd: string;
  /** Forwarded to console.log to disambiguate interleaved suites. */
  label?: string;
}): WranglerHarness {
  const url = `http://127.0.0.1:${opts.port}`;
  const tag = opts.label ? `[wrangler:${opts.label}]` : "[wrangler]";

  function start(): ChildProcess {
    const child = spawn(
      "npx",
      [
        "wrangler",
        "dev",
        "--config",
        opts.configPath,
        "--port",
        String(opts.port),
        "--persist-to",
        opts.persistDir,
        "--inspector-port",
        "0"
      ],
      {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, NODE_ENV: "test" }
      }
    );

    child.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`${tag} ${line}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`${tag}:err ${line}`);
    });

    return child;
  }

  async function waitForReady(maxAttempts = 60, delayMs = 1000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`${url}/`);
        await res.body?.cancel();
        if (res.status > 0) return;
      } catch {
        // Not ready
      }
      await sleep(delayMs);
    }
    throw new Error("Wrangler did not start in time");
  }

  async function waitForPortFree(
    maxAttempts = 30,
    delayMs = 500
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`${url}/`);
        await res.body?.cancel();
      } catch {
        return;
      }
      await sleep(delayMs);
    }
    throw new Error(`Port ${opts.port} did not free in time`);
  }

  async function restart(child: ChildProcess): Promise<ChildProcess> {
    await killProcess(child);
    await waitForPortFree();
    const next = start();
    await waitForReady();
    return next;
  }

  return { url, start, waitForReady, waitForPortFree, restart };
}

/** WebSocket RPC call to a callable agent method. */
export function rpcCall(
  agentUrl: string,
  method: string,
  args: unknown[] = [],
  timeoutMs = 10000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(agentUrl);
    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC call ${method} timed out`));
    }, timeoutMs);

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

/** Send a chat submit over the chat WebSocket protocol and resolve quickly. */
export function sendChatMessage(
  agentUrl: string,
  userMessage: string,
  openMs = 2000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(agentUrl);

    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, openMs + 1000);

    ws.onopen = () => {
      const requestId = crypto.randomUUID();
      const body = JSON.stringify({
        messages: [
          {
            id: `user-${Date.now()}`,
            role: "user",
            parts: [{ type: "text", text: userMessage }]
          }
        ]
      });

      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: requestId,
          init: { method: "POST", body }
        })
      );

      setTimeout(() => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }, openMs);
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

export async function pollUntil<T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options?: { attempts?: number; delayMs?: number }
): Promise<T> {
  const attempts = options?.attempts ?? 30;
  const delayMs = options?.delayMs ?? 1000;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      const value = await read();
      console.log(`[test] ${label} poll ${i + 1}:`, value);
      if (done(value)) return value;
    } catch (error) {
      lastError = error;
      console.log(`[test] ${label} poll ${i + 1}: error`);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${label}`);
}
