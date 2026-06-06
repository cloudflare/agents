/**
 * Cross-provider E2E for issue #1685.
 *
 * `ThinkWorkflow.step.prompt({ output })` must return a schema-shaped object on
 * every provider Think supports. Before the fix, Think streamed the structured
 * turn through the AI SDK `output`/`response_format` path, which Workers AI
 * rejects with `AiError 5023: JSON Schema mode is not supported with stream
 * mode`. The fix runs the structured turn as a full agentic turn that
 * terminates by calling a synthetic `final_answer` tool — plain tool-calling
 * that streams on every provider.
 *
 * Workers AI always runs (real `AI` binding). The OpenAI / Anthropic legs run
 * only when the matching API key is exported in the environment; otherwise they
 * skip so CI without keys still exercises the provider that originally broke.
 *
 * Provide keys via the shell, e.g.:
 *   OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... pnpm run test:e2e
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily } from "node:net";
import "./harden-net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

setDefaultAutoSelectFamily(false);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18799;
const BASE_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "test-structured-agent";
const PERSIST_DIR = path.join(__dirname, ".wrangler-structured-state");

type StructuredResult = {
  status: string;
  output?: Record<string, unknown> | null;
  error?: string;
};

const GREETING_PROMPT =
  "Return a short, friendly greeting in the `greeting` field.";
// Forces real (workspace) tool use before answering, exercising the multi-step
// toolChoice:"required" path that terminates with the synthetic final-answer
// tool.
const TOOL_PROMPT =
  "Use the write tool to create the file /secret.txt with the exact contents " +
  '"banana". Then use the read tool to read /secret.txt and return its exact ' +
  "contents in the `word` field.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessOnPort(port: number): void {
  try {
    const output = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`)
      .toString()
      .trim();
    if (output) {
      for (const pid of output.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  } catch {
    // ignore
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
    // pgrep may be unavailable
  }
  for (const childPid of children) killProcessTree(childPid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}

function startWrangler(): ChildProcess {
  const configPath = path.join(__dirname, "wrangler.jsonc");
  const args = [
    "wrangler",
    "dev",
    "--config",
    configPath,
    "--port",
    String(PORT),
    "--persist-to",
    PERSIST_DIR,
    "--inspector-port",
    "0"
  ];
  // Forward provider keys only when present so the worker can construct the
  // OpenAI / Anthropic models. Workers AI needs no key.
  if (process.env.OPENAI_API_KEY) {
    args.push("--var", `OPENAI_API_KEY:${process.env.OPENAI_API_KEY}`);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    args.push("--var", `ANTHROPIC_API_KEY:${process.env.ANTHROPIC_API_KEY}`);
  }

  const child = spawn("npx", args, {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" }
  });

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

async function waitForReady(maxAttempts = 60, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // not ready yet
    }
    await sleep(delayMs);
  }
  throw new Error(`Wrangler did not start within ${maxAttempts * delayMs}ms`);
}

function killProcess(child: ChildProcess): Promise<void> {
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

/** Call a @callable method on the agent via WebSocket RPC. */
async function callAgent(
  room: string,
  method: string,
  args: unknown[] = [],
  timeoutMs = 110_000
): Promise<unknown> {
  const url = `${BASE_URL}/agents/${AGENT_SLUG}/${room}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
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
          if (msg.success) resolve(msg.result);
          else reject(new Error(msg.error || "RPC failed"));
        }
      } catch {
        // ignore non-RPC messages
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

async function runStructuredPrompt(
  provider: "workers-ai" | "openai" | "anthropic",
  mode: "greeting" | "tool" = "greeting"
): Promise<StructuredResult> {
  const room = `e2e-structured-${provider}-${mode}-${Date.now()}`;
  await callAgent(room, "setTestProvider", [provider]);
  const prompt = mode === "tool" ? TOOL_PROMPT : GREETING_PROMPT;
  return (await callAgent(room, "runStructuredPrompt", [
    prompt,
    mode
  ])) as StructuredResult;
}

describe("think e2e — step.prompt structured output (#1685)", () => {
  let wrangler: ChildProcess | null = null;

  beforeAll(async () => {
    killProcessOnPort(PORT);
    wrangler = startWrangler();
    await waitForReady();
    console.log("[test] Wrangler is ready");
  });

  afterAll(async () => {
    if (wrangler) {
      await killProcess(wrangler);
      wrangler = null;
    }
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
    }
  });

  it("workers-ai: step.prompt returns a schema-shaped object", async () => {
    const result = await runStructuredPrompt("workers-ai");
    expect(result.error).toBeFalsy();
    expect(result.status).toBe("complete");
    expect(result.output).toBeTruthy();
    const greeting = result.output?.greeting;
    expect(typeof greeting).toBe("string");
    expect((greeting as string).length).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.OPENAI_API_KEY)(
    "openai: step.prompt returns a schema-shaped object",
    async () => {
      const result = await runStructuredPrompt("openai");
      expect(result.error).toBeFalsy();
      expect(result.status).toBe("complete");
      expect(typeof result.output?.greeting).toBe("string");
    }
  );

  it.skipIf(!process.env.ANTHROPIC_API_KEY)(
    "anthropic: step.prompt returns a schema-shaped object",
    async () => {
      const result = await runStructuredPrompt("anthropic");
      expect(result.error).toBeFalsy();
      expect(result.status).toBe("complete");
      expect(typeof result.output?.greeting).toBe("string");
    }
  );

  // Multi-step agentic path: the model must call real (workspace) tools before
  // producing the structured answer via the final-answer tool.
  it("workers-ai: step.prompt runs a tool-using turn then returns structured output", async () => {
    const result = await runStructuredPrompt("workers-ai", "tool");
    expect(result.error).toBeFalsy();
    expect(result.status).toBe("complete");
    const word = result.output?.word;
    expect(typeof word).toBe("string");
    expect((word as string).toLowerCase()).toContain("banana");
  });

  it.skipIf(!process.env.OPENAI_API_KEY)(
    "openai: step.prompt runs a tool-using turn then returns structured output",
    async () => {
      const result = await runStructuredPrompt("openai", "tool");
      expect(result.error).toBeFalsy();
      expect(result.status).toBe("complete");
      const word = result.output?.word;
      expect((word as string).toLowerCase()).toContain("banana");
    }
  );

  it.skipIf(!process.env.ANTHROPIC_API_KEY)(
    "anthropic: step.prompt runs a tool-using turn then returns structured output",
    async () => {
      const result = await runStructuredPrompt("anthropic", "tool");
      expect(result.error).toBeFalsy();
      expect(result.status).toBe("complete");
      const word = result.output?.word;
      expect((word as string).toLowerCase()).toContain("banana");
    }
  );
});
