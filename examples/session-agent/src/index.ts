import { type AgentNamespace, getAgentByName } from "agents";
import {
  SessionAgent,
  type ContextBuilderOptions,
  workersAIAdapter
} from "agents/experimental/memory";

// ---------------------------------------------------------------------------
// Env & State
// ---------------------------------------------------------------------------

interface Env {
  MY_AGENT: AgentNamespace<MyAgent>;
  AI: Ai;
}

interface AgentState {
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools = [
  {
    type: "function" as const,
    function: {
      name: "echo",
      description: "Echoes back the input message",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message to echo back" }
        },
        required: ["message"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "getCurrentWeather",
      description: "Get the current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The city and state, e.g. San Francisco, CA"
          },
          unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "The temperature unit"
          }
        },
        required: ["location"]
      }
    }
  }
];

function executeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "echo":
      return `Echo: ${args.message}`;
    case "getCurrentWeather": {
      const temp = Math.floor(Math.random() * 30) + 10;
      const unit = (args.unit as string) || "celsius";
      return JSON.stringify({
        location: args.location,
        temperature: temp,
        unit,
        conditions: ["sunny", "cloudy", "rainy"][Math.floor(Math.random() * 3)]
      });
    }
    default:
      return `Error: Unknown tool ${name}`;
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are a helpful assistant with access to tools. Use the tools when appropriate to answer user questions.";

export class MyAgent extends SessionAgent<Env, AgentState> {
  initialState: AgentState = { sessionId: undefined };

  async onStart() {
    const sessions = this.listSessions();
    if (sessions.length > 0) {
      // Just use the first session. This is up to user on how they want to handle it
      this.setState({ sessionId: sessions[0].id });
    } else {
      this.setState({ sessionId: this.createSession() });
    }
  }

  private ensureSession(): string {
    let sessionId = this.state.sessionId;
    if (sessionId && this.getSession(sessionId)) return sessionId;
    sessionId = this.createSession();
    this.setState({ sessionId });
    return sessionId;
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);

    // POST /chat — send a message and get an LLM response
    if (url.pathname === "/chat" && request.method === "POST") {
      const body = (await request.json()) as {
        query: string;
        gatewayId?: string;
      };
      if (!body.query) {
        return Response.json({ error: "query is required" }, { status: 400 });
      }

      const sessionId = this.ensureSession();

      // User message is NOT persisted here — it stays in-memory until the
      // full turn completes. This prevents concurrent requests from seeing
      // each other's in-flight user messages via loadEvents().
      const result = await this.runAgentLoop(sessionId, body.query, {
        gatewayId: body.gatewayId
      });

      return Response.json({ ...result, sessionId });
    }

    // GET /session — session info + events
    if (url.pathname === "/session" && request.method === "GET") {
      const sessionId = this.state.sessionId;
      if (!sessionId)
        return Response.json({ error: "No session" }, { status: 404 });
      return Response.json({
        session: this.getSession(sessionId),
        events: this.loadEvents(sessionId, { limit: 200 })
      });
    }

    // DELETE /session — reset
    if (url.pathname === "/session" && request.method === "DELETE") {
      if (this.state.sessionId) this.deleteSession(this.state.sessionId);
      const newId = this.createSession();
      this.setState({ sessionId: newId });
      return Response.json({ success: true, newSessionId: newId });
    }

    // GET / — agent info
    if (request.method === "GET") {
      return Response.json({
        agent: this.name,
        sessionId: this.state.sessionId
      });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  // -------------------------------------------------------------------
  // Agentic loop
  // -------------------------------------------------------------------

  private async runAgentLoop(
    sessionId: string,
    userMessage: string,
    opts: { gatewayId?: string; maxIterations?: number; model?: string } = {}
  ) {
    const {
      gatewayId,
      maxIterations = 5,
      model = "@cf/qwen/qwen3-30b-a3b-fp8"
    } = opts;

    // Build context from completed turns only, then add user message in-memory.
    // persistWorkingContext at the end writes user + assistant atomically.
    const ctx = this.buildWorkingContext(sessionId, {
      systemInstructions: [SYSTEM_PROMPT],
      limit: 100
    });
    ctx.addMessage({ role: "user", content: userMessage });

    let iteration = 0;
    let totalToolCalls = 0;

    while (iteration < maxIterations) {
      iteration++;

      const modelInput = workersAIAdapter.toModelMessages(
        ctx.systemInstructions,
        ctx.messages
      );

      const result = (await this.env.AI.run(
        model as keyof AiModels,
        { messages: modelInput.messages, tools, tool_choice: "auto" },
        gatewayId
          ? { gateway: { id: gatewayId, skipCache: false, cacheTtl: 3600 } }
          : undefined
      )) as {
        choices?: {
          message: {
            content?: string;
            tool_calls?: {
              id: string;
              function: {
                name: string;
                arguments: string | Record<string, unknown>;
              };
            }[];
          };
        }[];
      };

      if (!result.choices?.length) {
        this.persistWorkingContext(sessionId, ctx);
        return {
          response: "Error: No response from AI",
          iterations: iteration,
          toolCalls: totalToolCalls
        };
      }

      const message = result.choices[0].message;

      // Handle tool calls
      if (message.tool_calls?.length) {
        totalToolCalls += message.tool_calls.length;

        ctx.addMessage({
          role: "assistant",
          content: message.content || "",
          toolCalls: message.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments
          }))
        });

        for (const tc of message.tool_calls) {
          const args =
            typeof tc.function.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments;
          ctx.addMessage({
            role: "tool",
            content: executeTool(tc.function.name, args),
            toolCallId: tc.id,
            name: tc.function.name
          });
        }
        continue;
      }

      // Final assistant response
      if (message.content?.trim()) {
        ctx.addMessage({ role: "assistant", content: message.content });
        this.persistWorkingContext(sessionId, ctx);
        return {
          response: message.content,
          iterations: iteration,
          toolCalls: totalToolCalls
        };
      }
    }

    this.persistWorkingContext(sessionId, ctx);
    return {
      response: "Max iterations reached",
      iterations: iteration,
      toolCalls: totalToolCalls
    };
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const agentName = url.searchParams.get("agent") || "default-agent";
    const agent = await getAgentByName<Env, MyAgent>(env.MY_AGENT, agentName);
    return agent.fetch(request);
  }
} satisfies ExportedHandler<Env>;
