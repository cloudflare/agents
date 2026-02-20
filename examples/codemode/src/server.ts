import {
  routeAgentRequest,
  getAgentByName,
  Agent,
  callable,
  type Connection
} from "agents";
import { getSchedulePrompt } from "agents/schedule";
import { createCodeTool } from "@cloudflare/codemode/ai";
import {
  DynamicWorkerExecutor,
  generateTypes,
  type Executor
} from "@cloudflare/codemode";
import {
  streamText,
  type UIMessage,
  stepCountIs,
  convertToModelMessages,
  readUIMessageStream,
  generateId
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { initDatabase, createTools } from "./tools";
import {
  NodeServerExecutor,
  handleToolCallback
} from "./executors/node-server-client";

export type ExecutorType = "dynamic-worker" | "node-server";

type ToolFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

type State = {
  messages: UIMessage[];
  loading: boolean;
  executor: ExecutorType;
};

export class Codemode extends Agent<Env, State> {
  observability = undefined;
  lastMessageRepliedTo: string | undefined;

  /** Registry for in-flight Node executor tool callbacks — lives on the DO instance. */
  nodeExecutorRegistry = new Map<string, ToolFns>();

  /** PM tools wired to this DO's SQLite — built once in onStart. */
  tools!: ReturnType<typeof createTools>;

  /** Cached tool definition for the frontend — built once in onStart. */
  toolDefinition!: { name: string; description: string; inputSchema: unknown };

  initialState: State = {
    messages: [],
    loading: false,
    executor: "dynamic-worker"
  };

  async onStart() {
    initDatabase(this.ctx.storage.sql);
    this.tools = createTools(this.ctx.storage.sql);

    // Build tool definition once — used both for LLM context and frontend display.
    // createCodeTool uses the package's DEFAULT_DESCRIPTION when description is
    // omitted, which interpolates {{types}} automatically. We build the same
    // description here so the frontend can display it.
    const types = generateTypes(this.tools);
    const description = [
      "Execute code to achieve a goal.",
      "",
      "Available:",
      types,
      "",
      "Write an async arrow function that returns the result.",
      "Do NOT define named functions then call them — just write the arrow function body directly.",
      "",
      'Example: async () => { const r = await codemode.searchWeb({ query: "test" }); return r; }'
    ].join("\n");

    this.toolDefinition = {
      name: "codemode",
      description,
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript async arrow function to execute"
          }
        },
        required: ["code"]
      }
    };

    this.lastMessageRepliedTo =
      this.state.messages[this.state.messages.length - 1]?.id;
  }

  /** Handle HTTP requests forwarded to this DO (tool callbacks from Node executor). */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/node-executor-callback/")) {
      return handleToolCallback(request, this.nodeExecutorRegistry);
    }
    return new Response("Not found", { status: 404 });
  }

  @callable({ description: "Set the executor type" })
  setExecutor(executorType: ExecutorType) {
    this.setState({
      ...this.state,
      executor: executorType
    });
  }

  @callable({ description: "Get the codemode tool definition" })
  getToolDefinition() {
    return this.toolDefinition;
  }

  createExecutor(): Executor {
    switch (this.state.executor) {
      case "node-server":
        return new NodeServerExecutor({
          serverUrl: "http://localhost:3001",
          callbackUrl: `http://localhost:5173/node-executor-callback/${this.name}`,
          registry: this.nodeExecutorRegistry
        });
      case "dynamic-worker":
      default:
        return new DynamicWorkerExecutor({
          loader: this.env.LOADER
        });
    }
  }

  async onStateChanged(state: State, source: Connection | "server") {
    if (source === "server") return;

    const lastMessage = state.messages[state.messages.length - 1];
    if (
      state.messages.length > 0 &&
      this.lastMessageRepliedTo !== lastMessage?.id
    ) {
      await this.onChatMessage();
      this.lastMessageRepliedTo = lastMessage?.id;
    }
  }

  async onChatMessage() {
    this.setState({ ...this.state, loading: true });

    const workersai = createWorkersAI({ binding: this.env.AI });
    // @ts-expect-error -- model not yet in workers-ai-provider type list
    const model = workersai("@cf/zai-org/glm-4.7-flash");

    const executor = this.createExecutor();
    const codemode = createCodeTool({
      tools: this.tools,
      executor,
      description: this.toolDefinition.description
    });

    const result = streamText({
      system: `You are a helpful project management assistant. You can create and manage projects, tasks, sprints, and comments using the codemode tool.

When you need to perform operations, use the codemode tool to write JavaScript that calls the available functions on the \`codemode\` object.

Current executor: ${this.state.executor}

${getSchedulePrompt({ date: new Date() })}
`,
      messages: await convertToModelMessages(this.state.messages),
      model,
      tools: { codemode },
      onError: (error) => console.error("error", error),
      stopWhen: stepCountIs(10)
    });

    for await (const uiMessage of readUIMessageStream<UIMessage>({
      stream: result.toUIMessageStream({ generateMessageId: generateId }),
      onError: (error) => console.error("error", error)
    })) {
      this.setState({
        ...this.state,
        messages: updateMessages(this.state.messages, uiMessage)
      });
    }

    this.setState({ ...this.state, loading: false });
  }
}

function updateMessages(messages: UIMessage[], newMessage: UIMessage) {
  const index = messages.findIndex((m) => m.id === newMessage.id);
  if (index >= 0) {
    return [
      ...messages.slice(0, index),
      newMessage,
      ...messages.slice(index + 1)
    ];
  }
  return [...messages, newMessage];
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Forward tool callback requests to the correct Codemode DO instance
    if (url.pathname.startsWith("/node-executor-callback/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      // parts: ["node-executor-callback", agentName, execId, toolName]
      const agentName = parts[1];
      if (!agentName) {
        return Response.json(
          { error: "Missing agent name in callback URL" },
          { status: 400 }
        );
      }
      const agent = await getAgentByName(env.Codemode, agentName);
      return agent.fetch(request);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
