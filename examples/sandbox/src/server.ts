import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { getSandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { Config } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  ToolLoopAgent,
  createAgentUIStreamResponse,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";

// Re-export the Sandbox Durable Object class (required by wrangler)
export { Sandbox } from "@cloudflare/sandbox";

/**
 * Persisted state for the chat agent.
 * The OpenCode session ID survives across requests so subsequent
 * coding tasks build on prior context within the same sandbox.
 */
interface SandboxAgentState {
  opencodeSessionId?: string;
}

/**
 * Chat agent that lazily spins up a Sandbox with OpenCode.
 *
 * Normal conversation is handled directly by Workers AI.
 * When the user asks to build something or run code, the agent
 * uses tools that create a sandbox container on demand.
 *
 * The UI shows a live terminal panel alongside the chat. The agent
 * can run commands visibly in the terminal via the "run_in_terminal"
 * tool, or silently via "exec" when it just needs the output.
 */
export class ChatAgent extends AIChatAgent<Env, SandboxAgentState> {
  initialState: SandboxAgentState = {};
  maxPersistedMessages = 200;

  // Instance-level reference — recreated if the DO is evicted and reactivated.
  // Not serializable, so not stored in state.
  private _opencodeClient?: OpencodeClient;

  /**
   * Lazily creates the sandbox container and OpenCode server.
   * Reuses the client on subsequent calls within the same DO activation.
   */
  private async getOpenCodeClient(): Promise<OpencodeClient> {
    if (this._opencodeClient) return this._opencodeClient;

    if (!this.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env to enable sandbox coding."
      );
    }

    const sandbox = getSandbox(this.env.Sandbox, this.name);
    const config: Config = {
      provider: {
        anthropic: {
          options: { apiKey: this.env.ANTHROPIC_API_KEY }
        }
      }
    };

    const { client } = await createOpencode(sandbox, {
      directory: "/home/user/project",
      config
    });

    this._opencodeClient = client;
    return client;
  }

  /**
   * Ensures an OpenCode session exists, reusing the persisted session ID
   * when possible. Creates a new session if the old one expired.
   */
  private async ensureSession(): Promise<string> {
    const client = await this.getOpenCodeClient();

    if (this.state.opencodeSessionId) {
      try {
        const existing = await client.session.get({
          sessionID: this.state.opencodeSessionId
        });
        if (existing.data) return this.state.opencodeSessionId;
      } catch {
        // Session expired or container restarted — fall through to create
      }
    }

    const session = await client.session.create({
      title: "Sandbox Session",
      directory: "/home/user/project"
    });

    if (!session.data) {
      throw new Error("Failed to create OpenCode session");
    }

    this.setState({ ...this.state, opencodeSessionId: session.data.id });
    return session.data.id;
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    // Capture references for use inside async generator tools
    // (generator functions don't bind `this` from the enclosing class)
    const self = this;

    const sandboxAgent = new ToolLoopAgent({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      instructions: `You are a helpful coding assistant with access to a cloud sandbox environment.
The user has a live terminal panel next to this chat that is connected to the same sandbox.

For normal questions and explanations, respond directly — no tools needed.

When the user asks you to build something, write code, analyze a repo, or do anything that needs a real dev environment, use your tools:

- "code": Delegate a coding task to OpenCode (an AI coding agent) running inside the sandbox. Best for building apps, writing multi-file projects, refactoring, and complex development work. Describe the task clearly so OpenCode can execute it.
- "exec": Run a shell command silently and get its output back. Use for quick operations where you need the result: listing files, reading file contents, checking git status, etc.
- "run_in_terminal": Run a command visibly in the user's terminal panel. Use for long-running processes (dev servers, watchers, build commands), interactive commands, or anything the user should see running live. The command is typed into their terminal — they can see the output in real time and interact with it.

The sandbox container starts lazily on first tool use — there's no cost until you actually need it.

Tips:
- Use "exec" when you need the output to make decisions. Use "run_in_terminal" when the user should watch it happen.
- For dev servers (npm start, vite dev, etc.), always use "run_in_terminal" — the user needs to see the output and the process stays running.
- Use "exec" first for exploration (ls, cat, git status) before jumping to "code" for bigger tasks.
- After "code" finishes, use "run_in_terminal" to show them the results live (e.g., start the dev server).
- The sandbox persists between messages, so files and state carry over.
- The user can also type directly into the terminal — it's a real shell session.`,
      tools: {
        code: tool({
          description:
            "Send a coding task to OpenCode in the sandbox. " +
            "Use for building apps, writing code, refactoring, and complex dev tasks. " +
            "The sandbox starts automatically on first use.",
          inputSchema: z.object({
            task: z.string().describe("Detailed description of the coding task")
          }),
          // Async generator streams preliminary results to show live progress
          async *execute({ task }) {
            const events: string[] = [];

            try {
              events.push("Starting sandbox...");
              yield { status: "starting", events: [...events] };

              const client = await self.getOpenCodeClient();
              const sessionId = await self.ensureSession();

              events.push("Connected to OpenCode");
              events.push(`Sending task: ${task.slice(0, 80)}...`);
              yield { status: "coding", events: [...events] };

              // Run prompt in background so we can poll for progress
              let promptDone = false;
              let promptError: Error | undefined;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let promptResult: any;

              const promptWork = client.session
                .prompt({
                  sessionID: sessionId,
                  directory: "/home/user/project",
                  parts: [{ type: "text", text: task }]
                })
                .then((r) => {
                  promptResult = r;
                  promptDone = true;
                })
                .catch((e: unknown) => {
                  promptError = e instanceof Error ? e : new Error(String(e));
                  promptDone = true;
                });

              // Poll session messages while prompt is running
              let lastSeenParts = 0;
              while (!promptDone) {
                await new Promise<void>((r) => setTimeout(r, 2000));
                if (promptDone) break;

                try {
                  const msgs = await client.session.messages({
                    sessionID: sessionId,
                    limit: 5
                  });
                  const msgList = (msgs.data ?? []) as unknown as Array<{
                    role: string;
                    parts?: Array<{
                      type: string;
                      text?: string;
                      tool?: string;
                      state?: { status?: string };
                    }>;
                  }>;

                  // Scan recent assistant messages for new activity
                  let currentParts = 0;
                  for (const msg of msgList) {
                    if (msg.role !== "assistant" || !msg.parts) continue;
                    for (const part of msg.parts) {
                      currentParts++;
                      if (currentParts <= lastSeenParts) continue;

                      if (part.type === "tool" && part.tool) {
                        const status = part.state?.status ?? "running";
                        events.push(`Tool: ${part.tool} (${status})`);
                      } else if (
                        part.type === "text" &&
                        part.text &&
                        part.text.length > 0
                      ) {
                        const preview = part.text.slice(0, 120);
                        events.push(preview);
                      } else if (part.type === "step-start") {
                        events.push("— new step —");
                      }
                    }
                  }

                  if (currentParts > lastSeenParts) {
                    lastSeenParts = currentParts;
                    yield { status: "coding", events: [...events] };
                  }
                } catch {
                  // Polling failure is non-fatal
                }
              }

              // Wait for the prompt to fully resolve
              await promptWork;

              if (promptError) {
                events.push(`Error: ${promptError.message}`);
                yield {
                  status: "error",
                  success: false,
                  error: promptError.message,
                  events
                };
                return;
              }

              // Extract final text from OpenCode's response
              const parts = (promptResult?.data?.parts ?? []) as Array<{
                type: string;
                text?: string;
              }>;
              const textParts = parts
                .filter(
                  (p): p is { type: "text"; text: string } =>
                    p.type === "text" && typeof p.text === "string"
                )
                .map((p) => p.text);

              yield {
                status: "done",
                success: true,
                response:
                  textParts.join("\n") || "Task completed (no text output)",
                events
              };
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : "Unknown error";
              events.push(`Error: ${msg}`);
              yield {
                status: "error",
                success: false,
                error: msg,
                events
              };
            }
          }
        }),

        exec: tool({
          description:
            "Run a shell command silently in the sandbox and return its output. " +
            "Use for quick operations where you need the result: ls, cat, git status, etc. " +
            "Output is NOT shown in the user's terminal panel.",
          inputSchema: z.object({
            command: z.string().describe("Shell command to run")
          }),
          execute: async ({ command }) => {
            try {
              const sandbox = getSandbox(self.env.Sandbox, self.name);
              const result = await sandbox.exec(command);
              return {
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                success: result.success
              };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error"
              };
            }
          }
        }),

        run_in_terminal: tool({
          description:
            "Run a command visibly in the user's live terminal panel. " +
            "The command is typed into their terminal so they see it execute in real time. " +
            "Use for: dev servers, build commands, interactive processes, " +
            "or anything the user should watch running. " +
            "Does NOT return command output — use 'exec' if you need the result.",
          inputSchema: z.object({
            command: z.string().describe("Shell command to run in the terminal")
          }),
          execute: async ({ command }) => {
            // The actual execution happens client-side — the client reads
            // this tool result and writes the command into the xterm WebSocket.
            // We return the command so the client knows what to type.
            return {
              success: true,
              command,
              runInTerminal: true
            };
          }
        })
      },
      stopWhen: stepCountIs(5)
    });

    return createAgentUIStreamResponse({
      agent: sandboxAgent,
      uiMessages: this.messages
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Proxy terminal WebSocket connections to the sandbox container
    if (url.pathname === "/ws/terminal") {
      const name = url.searchParams.get("name");
      if (!name) {
        return new Response("Missing ?name= parameter", { status: 400 });
      }
      const sandbox = getSandbox(env.Sandbox, name);
      return sandbox.terminal(request);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
