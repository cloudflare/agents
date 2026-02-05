import { Agent, type Connection, routeAgentRequest } from "agents";
import type { WorkerEntrypoint } from "cloudflare:workers";
import { YjsStorage, type SqlFunction } from "./yjs-storage";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { createTools, SYSTEM_PROMPT, type ToolContext } from "./agent-tools";
import type { BashLoopback } from "./loopbacks/bash";
import type { FetchLoopback } from "./loopbacks/fetch";

// Re-export loopback classes so they're available via ctx.exports
export { BashLoopback } from "./loopbacks/bash";
export { EchoLoopback } from "./loopbacks/echo";
export { FetchLoopback } from "./loopbacks/fetch";
export { FSLoopback } from "./loopbacks/fs";

// inline this until enable_ctx_exports is supported by default
declare global {
  interface ExecutionContext<Props = unknown> {
    readonly exports: Cloudflare.Exports;
    readonly props: Props;
  }

  interface DurableObjectState<Props = unknown> {
    readonly exports: Cloudflare.Exports;
    readonly props: Props;
  }
}

/**
 * State synced to connected clients via WebSocket
 */
export interface CoderState {
  sessionId: string;
  status: "idle" | "thinking" | "executing" | "waiting";
  activeFile?: string;
  codeVersion: number;
}

/**
 * Chat message stored in history
 */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
  }[];
  timestamp: number;
}

/**
 * Maximum number of tool call rounds to prevent infinite loops
 */
const MAX_TOOL_ROUNDS = 20;

/**
 * Maximum messages to keep in context (to manage token limits)
 */
const MAX_CONTEXT_MESSAGES = 50;

/**
 * Interface for the dynamic worker entrypoint
 */
interface CodeExecutionEntrypoint extends WorkerEntrypoint {
  verify(): void;
  run(): Promise<{ output: unknown; logs: string[] }>;
}

/**
 * Result from executing code in a dynamic worker
 */
export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  errorType?: "syntax" | "runtime" | "timeout" | "unknown";
  logs: string[];
  duration: number;
}

/**
 * Default execution timeout in milliseconds
 */
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Custom error class for timeouts
 */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * The main Coder Agent - orchestrates dynamic code execution
 *
 * Architecture:
 * - This Agent (Durable Object) is the persistent "brain"
 * - Dynamic workers loaded via LOADER are the ephemeral "hands"
 * - Yjs document stores the code with full version history
 * - Loopback bindings provide tools to dynamic workers
 */
export class Coder extends Agent<Env, CoderState> {
  // Yjs storage for code with versioning
  private yjsStorage: YjsStorage | null = null;

  // Chat history for this session (in-memory, backed by SQLite)
  private chatHistory: ModelMessage[] = [];
  private chatHistoryLoaded = false;

  /**
   * Initial state for the Agent - provides defaults before any state is set
   */
  initialState: CoderState = {
    sessionId: crypto.randomUUID(),
    status: "idle",
    codeVersion: 0
  };

  /**
   * Get or initialize the YjsStorage
   */
  private getStorage(): YjsStorage {
    if (!this.yjsStorage) {
      // Bind the sql function to this Agent instance
      // Cast is needed because Agent's sql type doesn't include Uint8Array, but it works at runtime
      const boundSql = this.sql.bind(this) as SqlFunction;
      this.yjsStorage = new YjsStorage(boundSql);
      // Initialize with default files if empty
      const version = this.yjsStorage.initializeDocument({
        "main.ts": "// Your code here\nconsole.log('Hello, world!');",
        "README.md": "# Project\n\nEdit these files to build your application."
      });
      // Update state with current version
      if (version > 0 && this.state.codeVersion !== version) {
        this.setState({ ...this.state, codeVersion: version });
      }
    }
    return this.yjsStorage;
  }

  /**
   * Initialize the Agent state
   */
  async onStart(): Promise<void> {
    // Initialize storage and sync version
    const storage = this.getStorage();
    const version = storage.getVersion();
    if (version > 0 && this.state.codeVersion !== version) {
      this.setState({ ...this.state, codeVersion: version });
    }
    // Initialize chat history tables
    this.initChatTables();
  }

  /**
   * Initialize SQLite tables for chat history
   */
  private initChatTables(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        timestamp INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_session 
      ON chat_messages(session_id, timestamp)
    `;
  }

  /**
   * Load chat history from SQLite
   */
  private loadChatHistory(): void {
    if (this.chatHistoryLoaded) return;

    const rows = this.sql`
      SELECT role, content, tool_calls 
      FROM chat_messages 
      WHERE session_id = ${this.state.sessionId}
      ORDER BY timestamp ASC
      LIMIT ${MAX_CONTEXT_MESSAGES}
    `;

    this.chatHistory = [];
    for (const row of rows) {
      const msg: ModelMessage = {
        role: row.role as "user" | "assistant" | "system",
        content: row.content as string
      };
      this.chatHistory.push(msg);
    }
    this.chatHistoryLoaded = true;
  }

  /**
   * Save a message to chat history
   */
  private saveChatMessage(
    role: "user" | "assistant" | "system",
    content: string,
    toolCalls?: unknown
  ): void {
    const toolCallsJson = toolCalls ? JSON.stringify(toolCalls) : null;
    this.sql`
      INSERT INTO chat_messages (session_id, role, content, tool_calls, timestamp)
      VALUES (${this.state.sessionId}, ${role}, ${content}, ${toolCallsJson}, ${Date.now()})
    `;
  }

  /**
   * Get OpenAI client configured with API key
   */
  private getOpenAI() {
    return createOpenAI({
      apiKey: this.env.OPENAI_API_KEY
    });
  }

  /**
   * Get tool context for the agent
   */
  private getToolContext(): ToolContext {
    const sessionId = this.state.sessionId;
    return {
      storage: this.getStorage(),
      bash: this.ctx.exports.BashLoopback({
        props: { sessionId }
      }) as unknown as BashLoopback,
      fetch: this.ctx.exports.FetchLoopback({
        props: { sessionId }
      }) as unknown as FetchLoopback
    };
  }

  /**
   * Handle incoming WebSocket messages from clients
   */
  async onMessage(
    connection: Connection,
    message: string | ArrayBuffer
  ): Promise<void> {
    // Handle binary Yjs updates
    if (message instanceof ArrayBuffer) {
      const update = new Uint8Array(message);
      const storage = this.getStorage();
      const newVersion = storage.updateCode(update);
      this.setState({ ...this.state, codeVersion: newVersion });

      // Broadcast to other clients (exclude sender)
      this.broadcast(message, [connection.id]);
      return;
    }

    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "chat":
          await this.handleChatMessage(connection, data.content);
          break;

        case "execute": {
          // One-off code execution
          const result = await this.executeCode(data.code, {
            modules: data.modules,
            timeoutMs: data.timeoutMs
          });
          connection.send(JSON.stringify({ type: "execution_result", result }));
          break;
        }

        case "read-file": {
          const storage = this.getStorage();
          const content = storage.readFile(data.path);
          connection.send(
            JSON.stringify({
              type: "file-content",
              path: data.path,
              content,
              requestId: data.requestId
            })
          );
          break;
        }

        case "write-file": {
          const storage = this.getStorage();
          const newVersion = storage.writeFile(data.path, data.content);
          this.setState({ ...this.state, codeVersion: newVersion });
          connection.send(
            JSON.stringify({
              type: "file-written",
              path: data.path,
              version: newVersion,
              requestId: data.requestId
            })
          );
          // Broadcast file change to other clients
          this.broadcast(
            JSON.stringify({
              type: "file-changed",
              path: data.path,
              version: newVersion
            }),
            [connection.id]
          );
          break;
        }

        case "list-files": {
          const storage = this.getStorage();
          const files = storage.listFiles();
          connection.send(
            JSON.stringify({
              type: "files-list",
              files,
              requestId: data.requestId
            })
          );
          break;
        }

        case "get-files": {
          const storage = this.getStorage();
          const files = storage.getFiles();
          connection.send(
            JSON.stringify({
              type: "files-content",
              files,
              version: this.state.codeVersion,
              requestId: data.requestId
            })
          );
          break;
        }

        default:
          console.warn("Unknown message type:", data.type);
      }
    } catch (e) {
      console.error("Failed to handle message:", e);
      connection.send(JSON.stringify({ type: "error", error: String(e) }));
    }
  }

  /**
   * Handle new WebSocket connections
   */
  async onConnect(connection: Connection): Promise<void> {
    // Send current state to new connection
    connection.send(
      JSON.stringify({
        type: "state",
        state: this.state
      })
    );

    // TODO: Send full Yjs document state for late-joining clients
    // Currently clients need to fetch files via get-files message
  }

  /**
   * Handle chat messages from the user - runs the LLM agent loop
   */
  private async handleChatMessage(
    connection: Connection,
    content: string
  ): Promise<void> {
    this.setState({ ...this.state, status: "thinking" });

    try {
      // Load chat history
      this.loadChatHistory();

      // Add user message to history
      const userMessage: ModelMessage = { role: "user", content };
      this.chatHistory.push(userMessage);
      this.saveChatMessage("user", content);

      // Get OpenAI client and tools
      const openai = this.getOpenAI();
      const toolContext = this.getToolContext();
      const tools = createTools(toolContext);

      // Build messages array with system prompt
      const messages: ModelMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...this.chatHistory.slice(-MAX_CONTEXT_MESSAGES)
      ];

      // Run the agent with AI SDK v6's automatic tool loop
      const result = await generateText({
        model: openai("gpt-4o"),
        messages,
        tools,
        stopWhen: stepCountIs(MAX_TOOL_ROUNDS),
        onStepFinish: async (step) => {
          // Report each step's tool calls and results to the client
          if (step.toolCalls && step.toolCalls.length > 0) {
            this.setState({ ...this.state, status: "executing" });

            // Send tool calls
            connection.send(
              JSON.stringify({
                type: "tool_calls",
                calls: step.toolCalls.map((tc) => ({
                  id: tc.toolCallId,
                  name: tc.toolName,
                  input: tc.input
                }))
              })
            );

            // Send tool results
            if (step.toolResults) {
              for (const tr of step.toolResults) {
                connection.send(
                  JSON.stringify({
                    type: "tool_result",
                    callId: tr.toolCallId,
                    name: tr.toolName,
                    output: tr.output
                  })
                );
              }
            }

            this.setState({ ...this.state, status: "thinking" });
          }
        }
      });

      // Get final response text
      const finalResponse = result.text || "";

      // Save assistant response to history
      if (finalResponse) {
        const assistantMessage: ModelMessage = {
          role: "assistant",
          content: finalResponse
        };
        this.chatHistory.push(assistantMessage);
        this.saveChatMessage("assistant", finalResponse);

        // Send final response to client
        connection.send(
          JSON.stringify({
            type: "chat",
            message: {
              role: "assistant",
              content: finalResponse
            }
          })
        );
      }

      // Log usage stats
      if (result.usage) {
        console.log(
          `Agent completed: ${result.steps.length} steps, ` +
            `${result.usage.inputTokens ?? 0} input tokens, ` +
            `${result.usage.outputTokens ?? 0} output tokens`
        );
      }
    } catch (e) {
      console.error("Agent loop error:", e);
      const errorMessage = e instanceof Error ? e.message : String(e);
      connection.send(
        JSON.stringify({
          type: "error",
          error: `Agent error: ${errorMessage}`
        })
      );
    } finally {
      this.setState({ ...this.state, status: "idle" });
    }
  }

  /**
   * Execute arbitrary code in an isolated dynamic worker
   *
   * This is the core primitive for code execution. The code runs in a
   * sandboxed isolate with only the bindings we explicitly provide.
   *
   * Features:
   * - Timeout protection (default 30s)
   * - Error categorization (syntax, runtime, timeout)
   * - Console log capture
   *
   * @param code - JavaScript/TypeScript code to execute (must export default function)
   * @param options - Execution options (modules, timeout)
   * @returns ExecutionResult with output, logs, errors
   */
  async executeCode(
    code: string,
    options: {
      modules?: Record<string, string>;
      timeoutMs?: number;
    } = {}
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const logs: string[] = [];
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;

    try {
      this.setState({ ...this.state, status: "executing" });

      // Generate unique ID for this execution
      const executionId = crypto.randomUUID();

      // Build the harness that wraps user code
      const harnessModule = this.buildHarnessModule();

      // Get the dynamic worker
      const worker = this.env.LOADER.get(executionId, () => ({
        compatibilityDate: "2025-11-01",
        compatibilityFlags: ["disallow_importable_env"],
        mainModule: "harness.js",
        modules: {
          "harness.js": harnessModule,
          "agent.js": code,
          ...(options.modules || {})
        },
        // Pass loopback bindings - tools the code can use
        env: this.getEnvForLoader(),
        // Block direct network access
        globalOutbound: null
      }));

      // Get the entrypoint
      const entrypoint = worker.getEntrypoint<CodeExecutionEntrypoint>();

      // Verify it loaded correctly (catches syntax errors early)
      try {
        await entrypoint.verify();
      } catch (verifyError) {
        return {
          success: false,
          error: this.formatError(verifyError),
          errorType: "syntax",
          logs,
          duration: Date.now() - startTime
        };
      }

      // Run with timeout protection
      const result = await this.withTimeout(
        entrypoint.run() as Promise<{ output: unknown; logs: string[] }>,
        timeoutMs,
        `Execution timed out after ${timeoutMs}ms`
      );

      return {
        success: true,
        output:
          typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.output),
        logs: result.logs || logs,
        duration: Date.now() - startTime
      };
    } catch (e) {
      const { message, errorType } = this.categorizeError(e);
      return {
        success: false,
        error: message,
        errorType,
        logs,
        duration: Date.now() - startTime
      };
    } finally {
      this.setState({ ...this.state, status: "idle" });
    }
  }

  /**
   * Run a promise with a timeout
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TimeoutError(timeoutMessage));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  /**
   * Format an error for display
   */
  private formatError(e: unknown): string {
    if (e instanceof Error) {
      let message = e.message;
      // Remove "Failed to start Worker:" prefix for cleaner display
      if (message.startsWith("Failed to start Worker:")) {
        message = message.replace("Failed to start Worker:", "").trim();
      }
      return message;
    }
    return String(e);
  }

  /**
   * Categorize an error by type for better error handling
   */
  private categorizeError(e: unknown): {
    message: string;
    errorType: "syntax" | "runtime" | "timeout" | "unknown";
  } {
    const message = this.formatError(e);

    if (e instanceof TimeoutError) {
      return { message, errorType: "timeout" };
    }

    // Syntax errors
    if (
      message.includes("SyntaxError") ||
      message.includes("Unexpected token") ||
      message.includes("Unexpected identifier")
    ) {
      return { message, errorType: "syntax" };
    }

    // Runtime errors
    if (
      message.includes("TypeError") ||
      message.includes("ReferenceError") ||
      message.includes("RangeError") ||
      message.includes("is not defined") ||
      message.includes("is not a function") ||
      message.includes("Cannot read properties of") ||
      message.includes("Cannot set properties of") ||
      message.includes("is not iterable")
    ) {
      return { message, errorType: "runtime" };
    }

    return { message, errorType: "unknown" };
  }

  /**
   * Build the harness module that wraps and executes user code
   *
   * The harness:
   * - Captures console.log calls
   * - Runs the user's code (default export function)
   * - Returns results in a structured format
   */
  private buildHarnessModule(): string {
    return `
import { WorkerEntrypoint } from "cloudflare:workers";
import agent from "agent.js";

// Capture logs
const logs = [];
const originalLog = console.log;
console.log = (...args) => {
  logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
  originalLog(...args);
};

export default class extends WorkerEntrypoint {
  verify() {
    // Called first to ensure the worker loaded correctly
    // If there are syntax errors, they'll surface here
  }

  async run() {
    try {
      let output;
      if (typeof agent === 'function') {
        output = await agent(this.env);
      } else if (agent && typeof agent.default === 'function') {
        output = await agent.default(this.env);
      } else {
        output = agent;
      }
      return { output, logs };
    } catch (e) {
      throw e;
    }
  }
}
`;
  }

  /**
   * Build environment bindings for the dynamic worker
   *
   * These are the "tools" available to code running in the isolate.
   * Each binding is a loopback to this parent Agent via ctx.exports.
   */
  private getEnvForLoader(): Record<string, unknown> {
    const sessionId = this.state.sessionId;

    return {
      // Echo loopback for testing
      ECHO: this.ctx.exports.EchoLoopback({ props: { sessionId } }),

      // Bash command execution
      BASH: this.ctx.exports.BashLoopback({ props: { sessionId } }),

      // File system operations (in-memory scratch space)
      FS: this.ctx.exports.FSLoopback({ props: { sessionId } }),

      // Controlled HTTP fetch with allowlist
      FETCH: this.ctx.exports.FetchLoopback({ props: { sessionId } })
    };
  }

  /**
   * Handle HTTP requests to the Agent
   * The pathname is the full path, e.g., /agents/coder/room/state
   * We extract the sub-path after the room identifier
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract the sub-path after /agents/{agent}/{room}
    // pathname: /agents/coder/test/state → subPath: /state
    const pathParts = url.pathname.split("/");
    const subPath = `/${pathParts.slice(4).join("/")}`;

    // API endpoints
    if (subPath === "/execute" && request.method === "POST") {
      const { code, modules, timeoutMs } = (await request.json()) as {
        code: string;
        modules?: Record<string, string>;
        timeoutMs?: number;
      };
      const result = await this.executeCode(code, { modules, timeoutMs });
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (subPath === "/state" || subPath === "/") {
      return new Response(JSON.stringify(this.state), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Chat endpoint for HTTP-based chat (useful for testing)
    if (subPath === "/chat" && request.method === "POST") {
      const { message } = (await request.json()) as { message: string };

      // Create a simple response collector
      const responses: unknown[] = [];
      const mockConnection = {
        id: "http-" + crypto.randomUUID(),
        send: (data: string) => {
          responses.push(JSON.parse(data));
        }
      } as Connection;

      await this.handleChatMessage(mockConnection, message);

      return new Response(JSON.stringify({ responses }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Get chat history
    if (subPath === "/chat/history" && request.method === "GET") {
      this.loadChatHistory();
      return new Response(
        JSON.stringify({
          messages: this.chatHistory,
          sessionId: this.state.sessionId
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Clear chat history
    if (subPath === "/chat/clear" && request.method === "POST") {
      this
        .sql`DELETE FROM chat_messages WHERE session_id = ${this.state.sessionId}`;
      this.chatHistory = [];
      return new Response(
        JSON.stringify({ success: true, sessionId: this.state.sessionId }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // File operations
    if (subPath === "/files" && request.method === "GET") {
      const storage = this.getStorage();
      const files = storage.getFiles();
      return new Response(
        JSON.stringify({ files, version: this.state.codeVersion }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (subPath.startsWith("/file/") && request.method === "GET") {
      const path = decodeURIComponent(subPath.slice(6));
      const storage = this.getStorage();
      const content = storage.readFile(path);
      if (content === null) {
        return new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ path, content }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (subPath.startsWith("/file/") && request.method === "PUT") {
      const path = decodeURIComponent(subPath.slice(6));
      const { content } = (await request.json()) as { content: string };
      const storage = this.getStorage();
      const newVersion = storage.writeFile(path, content);
      this.setState({ ...this.state, codeVersion: newVersion });
      return new Response(JSON.stringify({ path, version: newVersion }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (subPath.startsWith("/file/") && request.method === "DELETE") {
      const path = decodeURIComponent(subPath.slice(6));
      const storage = this.getStorage();
      const newVersion = storage.deleteFile(path);
      if (newVersion === null) {
        return new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      this.setState({ ...this.state, codeVersion: newVersion });
      return new Response(
        JSON.stringify({ deleted: path, version: newVersion }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response("Not found", { status: 404 });
  }
}

/**
 * Main Worker entry point
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK");
    }

    // Route to Agent using the SDK's router
    // This handles WebSocket upgrades, connection management, etc.
    const agentResponse = await routeAgentRequest(request, env, {
      cors: true
    });

    if (agentResponse) {
      return agentResponse;
    }

    // Default: serve static files (TODO: Vite integration)
    return new Response("Cloud-Native Coding Agent Runtime", {
      headers: { "Content-Type": "text/plain" }
    });
  }
};
