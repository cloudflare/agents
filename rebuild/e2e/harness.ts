import {
  execSync,
  spawn,
  type ChildProcess
} from "node:child_process";
import { Socket, setDefaultAutoSelectFamily } from "node:net";

// Same chaos-test hardening as the original side-effect module: process
// teardown can make undici's optional TOS syscall throw synchronously.
setDefaultAutoSelectFamily(false);
const socketProto = Socket.prototype as unknown as {
  setTypeOfService?: (tos: number) => unknown;
};
const originalSetTypeOfService = socketProto.setTypeOfService;
if (typeof originalSetTypeOfService === "function") {
  socketProto.setTypeOfService = function (
    this: unknown,
    tos: number
  ): unknown {
    try {
      return originalSetTypeOfService.call(this, tos);
    } catch {
      return this;
    }
  };
}

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

export type StartWranglerOptions = {
  configPath: string;
  port: number;
  persistDir: string;
  cwd: string;
  agentPath?: string;
};

type HarnessState = StartWranglerOptions & {
  agentPath: string;
};

let current: HarnessState | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function state(overrides?: Partial<StartWranglerOptions>): HarnessState {
  const merged = { ...current, ...overrides };
  if (
    typeof merged.configPath !== "string" ||
    typeof merged.port !== "number" ||
    typeof merged.persistDir !== "string" ||
    typeof merged.cwd !== "string"
  ) {
    throw new Error("Wrangler harness has not been configured");
  }
  return {
    configPath: merged.configPath,
    port: merged.port,
    persistDir: merged.persistDir,
    cwd: merged.cwd,
    agentPath: merged.agentPath ?? current?.agentPath ?? ""
  };
}

function baseUrl(opts?: Partial<StartWranglerOptions>): string {
  return `http://localhost:${state(opts).port}`;
}

function wsData(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return undefined;
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
          // Already dead.
        }
      }
    }
  } catch {
    // lsof not available.
  }
}

export function killProcessTree(pid: number): void {
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
    // Already dead.
  }
}

export function startWrangler(opts: StartWranglerOptions): ChildProcess {
  current = { ...opts, agentPath: opts.agentPath ?? current?.agentPath ?? "" };
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
      env: { ...process.env, NODE_ENV: "test" }
    }
  );

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler:err] ${line}`);
  });

  return child;
}

export async function waitForReady(
  maxAttempts = 60,
  delayMs = 1000,
  opts?: Partial<StartWranglerOptions>
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${baseUrl(opts)}/`);
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // Not ready.
    }
    await sleep(delayMs);
  }
  throw new Error("Wrangler did not start in time");
}

export async function waitForPortFree(
  maxAttempts = 30,
  delayMs = 500,
  opts?: Partial<StartWranglerOptions>
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${baseUrl(opts)}/`);
      await res.body?.cancel();
    } catch {
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(`Port ${state(opts).port} did not free in time`);
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

export async function restartWrangler(
  child: ChildProcess,
  opts?: StartWranglerOptions
): Promise<ChildProcess> {
  const cfg = state(opts);
  await killProcess(child);
  await waitForPortFree(30, 500, cfg);
  const next = startWrangler(cfg);
  await waitForReady(60, 1000, cfg);
  return next;
}

export async function callAgentByPath(
  path: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${baseUrl()}${path}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC call ${method} timed out`));
    }, 10000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = wsData(event.data);
        if (data === undefined) return;
        const msg = JSON.parse(data) as {
          type?: unknown;
          id?: unknown;
          success?: unknown;
          result?: unknown;
          error?: unknown;
        };
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timeout);
          ws.close();
          if (msg.success) {
            resolve(msg.result);
          } else {
            reject(new Error(typeof msg.error === "string" ? msg.error : "RPC failed"));
          }
        }
      } catch {
        // Ignore non-RPC messages.
      }
    });

    ws.addEventListener("error", (err: Event) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function chatBody(userMessage: string): string {
  return JSON.stringify({
    messages: [
      {
        id: `user-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: userMessage }]
      }
    ]
  });
}

export function sendChatMessageAndWaitForDone(
  userMessage: string,
  path = state().agentPath
): Promise<Record<string, unknown>> {
  const url = `${baseUrl()}${path}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for chat response"));
    }, 10000);

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: MSG_CHAT_REQUEST,
          id: crypto.randomUUID(),
          init: {
            method: "POST",
            body: chatBody(userMessage)
          }
        })
      );
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = wsData(event.data);
        if (data === undefined) return;
        const msg = JSON.parse(data) as Record<string, unknown>;
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
          clearTimeout(timeout);
          ws.close();
          resolve(msg);
        }
      } catch {
        // Ignore non-chat frames.
      }
    });

    ws.addEventListener("error", (err: Event) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export function sendChatMessage(
  userMessage: string,
  path = state().agentPath
): Promise<void> {
  const url = `${baseUrl()}${path}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, 3000);

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: MSG_CHAT_REQUEST,
          id: crypto.randomUUID(),
          init: { method: "POST", body: chatBody(userMessage) }
        })
      );

      setTimeout(() => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }, 2000);
    });

    ws.addEventListener("error", (err: Event) => {
      clearTimeout(timeout);
      reject(err);
    });
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

export { sleep };
