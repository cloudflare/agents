import type {
  AgentCard,
  JSONRPCResponse,
  Message,
  Task,
  TaskStatusUpdateEvent
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore
} from "@a2a-js/sdk/server";
import { Agent, getAgentByName } from "agents";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

type Env = {
  AI: Ai;
  MyA2A: DurableObjectNamespace<MyA2A>;
};

const agentCard: AgentCard = {
  capabilities: {
    pushNotifications: false,
    stateTransitionHistory: true,
    streaming: true
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  description:
    "An AI assistant powered by Cloudflare Workers AI, exposed via the A2A protocol.",
  name: "Cloudflare A2A Agent",
  protocolVersion: "0.3.0",
  provider: {
    organization: "Cloudflare",
    url: "https://developers.cloudflare.com/agents"
  },
  skills: [
    {
      description:
        "Chat with an AI assistant powered by Workers AI (GLM 4.7 Flash).",
      examples: [
        "Hello, how are you?",
        "Explain the A2A protocol in simple terms.",
        "Write a haiku about cloud computing."
      ],
      id: "chat",
      name: "Chat",
      tags: ["chat", "ai"]
    }
  ],
  url: "http://localhost:5173/a2a",
  version: "0.1.0"
};

// Task store backed by Durable Object SQLite storage
class DurableObjectTaskStore implements TaskStore {
  constructor(private sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS a2a_tasks (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `);
  }

  async save(task: Task): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO a2a_tasks (id, data) VALUES (?, ?)",
      task.id,
      JSON.stringify(task)
    );
  }

  async load(taskId: string): Promise<Task | undefined> {
    const rows = [
      ...this.sql.exec("SELECT data FROM a2a_tasks WHERE id = ?", taskId)
    ];
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0].data as string) as Task;
  }
}

// Agent executor that calls Workers AI
class AIAgentExecutor implements AgentExecutor {
  constructor(private getEnv: () => Env) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;

    // Publish initial task if new
    if (!task) {
      const initialTask: Task = {
        contextId,
        history: [userMessage],
        id: taskId,
        kind: "task",
        status: {
          state: "submitted",
          timestamp: new Date().toISOString()
        }
      };
      eventBus.publish(initialTask);
    }

    // Working status
    eventBus.publish({
      contextId,
      final: false,
      kind: "status-update",
      status: {
        state: "working",
        timestamp: new Date().toISOString()
      },
      taskId
    } as TaskStatusUpdateEvent);

    // Extract user text
    const userText = userMessage.parts
      .filter((p) => p.kind === "text")
      .map((p) => (p as { kind: "text"; text: string }).text)
      .join("");

    // Call Workers AI
    const workersai = createWorkersAI({ binding: this.getEnv().AI });
    const result = await generateText({
      model: workersai("@cf/moonshotai/kimi-k2.6"),
      system:
        "You are a helpful AI assistant. Keep responses concise and clear.",
      messages: [{ role: "user", content: userText }]
    });

    // Publish agent response
    const responseMessage: Message = {
      contextId,
      kind: "message",
      messageId: crypto.randomUUID(),
      parts: [{ kind: "text", text: result.text }],
      role: "agent",
      taskId
    };
    eventBus.publish(responseMessage);

    // Completed
    eventBus.publish({
      contextId,
      final: true,
      kind: "status-update",
      status: {
        message: responseMessage,
        state: "completed",
        timestamp: new Date().toISOString()
      },
      taskId
    } as TaskStatusUpdateEvent);

    eventBus.finished();
  }

  cancelTask = async (): Promise<void> => {};
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

export class MyA2A extends Agent<Env> {
  private handler: DefaultRequestHandler;
  private transport: JsonRpcTransportHandler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const taskStore = new DurableObjectTaskStore(ctx.storage.sql);
    const executor = new AIAgentExecutor(() => this.env);

    this.handler = new DefaultRequestHandler(agentCard, taskStore, executor);
    this.transport = new JsonRpcTransportHandler(this.handler);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Agent card discovery
    if (
      url.pathname === "/.well-known/agent-card.json" ||
      url.pathname === "/.well-known/agent.json"
    ) {
      const card = await this.handler.getAgentCard();
      return Response.json(card, {
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // A2A JSON-RPC endpoint
    if (request.method === "POST") {
      const body = await request.json();
      const result = await this.transport.handle(body);

      if (isAsyncIterable(result)) {
        const stream = result as AsyncGenerator<
          JSONRPCResponse,
          void,
          undefined
        >;
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        (async () => {
          try {
            for await (const event of stream) {
              await writer.write(
                encoder.encode(
                  `id: ${Date.now()}\ndata: ${JSON.stringify(event)}\n\n`
                )
              );
            }
          } finally {
            await writer.close();
          }
        })();

        return new Response(readable, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
            "Content-Type": "text/event-stream"
          }
        });
      }

      return Response.json(result, {
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Route A2A endpoints to the Durable Object
    if (url.pathname.startsWith("/.well-known/") || url.pathname === "/a2a") {
      const agent = await getAgentByName(env.MyA2A, "default");
      return agent.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
