/**
 * Standalone Node.js HTTP server that executes LLM-generated code in a VM sandbox.
 *
 * Tool calls from the sandboxed code are routed back to the caller via HTTP POSTs
 * to the provided callbackUrl.
 *
 * Usage:
 *   npx tsx node-executor-server.ts
 *
 * Environment variables:
 *   PORT          — listen port (default 3001)
 *   TIMEOUT_MS    — execution timeout in milliseconds (default 30000)
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import * as vm from "node:vm";

const PORT = Number(process.env.PORT) || 3001;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 30_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

interface ExecuteRequest {
  code: string;
  callbackUrl: string;
  tools: string[];
}

async function handleExecute(
  body: ExecuteRequest
): Promise<{ result: unknown; error?: string; logs: string[] }> {
  const { code, callbackUrl, tools } = body;
  const logs: string[] = [];

  // Build a codemode proxy that routes tool calls back via HTTP
  const codemode: Record<string, (args: unknown) => Promise<unknown>> = {};
  for (const toolName of tools) {
    codemode[toolName] = async (args: unknown) => {
      const res = await fetch(`${callbackUrl}/${toolName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args ?? {})
      });
      const data = (await res.json()) as { result?: unknown; error?: string };
      if (data.error) throw new Error(data.error);
      return data.result;
    };
  }

  const sandbox = {
    codemode,
    console: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) =>
        logs.push(`[error] ${args.map(String).join(" ")}`),
      warn: (...args: unknown[]) =>
        logs.push(`[warn] ${args.map(String).join(" ")}`)
    },
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    URL,
    Response,
    Request,
    Headers
  };

  const context = vm.createContext(sandbox);

  try {
    // The code is expected to be an async arrow function expression, e.g.:
    //   async () => { ... }
    // We evaluate it to get the function, then call it.
    const script = new vm.Script(`(${code})()`, {
      filename: "codemode-exec.js"
    });
    const result = await script.runInContext(context, { timeout: TIMEOUT_MS });
    return { result, logs };
  } catch (err) {
    return {
      result: undefined,
      error: err instanceof Error ? err.message : String(err),
      logs
    };
  }
}

const server = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/execute") {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as ExecuteRequest;

        if (!body.code || !body.callbackUrl || !Array.isArray(body.tools)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing required fields: code, callbackUrl, tools"
            })
          );
          return;
        }

        const result = await handleExecute(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err)
          })
        );
      }
      return;
    }

    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
);

server.listen(PORT, () => {
  console.log(`Node executor server listening on http://localhost:${PORT}`);
});
