import type { Executor, ExecuteResult } from "@cloudflare/codemode";

type ToolFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

export interface NodeServerExecutorOptions {
  /** URL of the Node executor server, e.g. "http://localhost:3001" */
  serverUrl: string;
  /** Base URL that the Node server will call back to for tool invocations */
  callbackUrl: string;
  /** Shared registry — the Agent instance owns this Map so it survives across isolate boundaries */
  registry: Map<string, ToolFns>;
}

/**
 * Executor that delegates code execution to an external Node.js HTTP server.
 * Tool calls from the sandboxed code are routed back via HTTP to the callback URL,
 * which forwards to the DO where the registry lives.
 */
export class NodeServerExecutor implements Executor {
  #serverUrl: string;
  #callbackUrl: string;
  #registry: Map<string, ToolFns>;

  constructor(options: NodeServerExecutorOptions) {
    this.#serverUrl = options.serverUrl;
    this.#callbackUrl = options.callbackUrl;
    this.#registry = options.registry;
  }

  async execute(code: string, fns: ToolFns): Promise<ExecuteResult> {
    const execId = crypto.randomUUID();

    // Register tool functions so the DO's onRequest can find them
    this.#registry.set(execId, fns);

    try {
      const res = await fetch(`${this.#serverUrl}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          callbackUrl: `${this.#callbackUrl}/${execId}`,
          tools: Object.keys(fns)
        })
      });

      const data = (await res.json()) as {
        result?: unknown;
        error?: string;
        logs?: string[];
      };

      if (data.error) {
        return { result: undefined, error: data.error, logs: data.logs };
      }

      return { result: data.result, logs: data.logs };
    } finally {
      this.#registry.delete(execId);
    }
  }
}

/**
 * Handle an incoming tool callback request.
 *
 * @param request  - the forwarded request (pathname: /node-executor-callback/{agentName}/{execId}/{toolName})
 * @param registry - the Agent-owned Map of execution IDs → tool functions
 */
export async function handleToolCallback(
  request: Request,
  registry: Map<string, ToolFns>
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  // parts: ["node-executor-callback", agentName, execId, toolName]
  const execId = parts[2];
  const toolName = parts[3];

  if (!execId || !toolName) {
    return Response.json(
      {
        error:
          "Invalid callback path — expected /node-executor-callback/{agent}/{execId}/{toolName}"
      },
      { status: 400 }
    );
  }

  const fns = registry.get(execId);
  if (!fns) {
    return Response.json(
      { error: `No execution found for id "${execId}"` },
      { status: 404 }
    );
  }

  const fn = fns[toolName];
  if (!fn) {
    return Response.json(
      { error: `Tool "${toolName}" not found` },
      { status: 404 }
    );
  }

  try {
    const body = await request.text();
    const args = body ? JSON.parse(body) : {};
    const result = await fn(args);
    return Response.json({ result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
