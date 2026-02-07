import { routeAgentRequest, Agent, callable, type Connection } from "agents";

import { getSchedulePrompt } from "agents/schedule";

import { experimental_codemode as codemode } from "@cloudflare/codemode/ai";
import {
  streamText,
  type UIMessage,
  stepCountIs,
  convertToModelMessages,
  type ToolSet,
  readUIMessageStream,
  generateId
} from "ai";
import { openai } from "@ai-sdk/openai";
import { tools } from "./tools";
import { env } from "cloudflare:workers";

// export this WorkerEntryPoint that lets you
// reroute function calls back to a caller
export { CodeModeProxy } from "@cloudflare/codemode/ai";

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

const model = openai("gpt-5");

export const globalOutbound = {
  fetch: async (
    input: string | URL | RequestInfo,
    init?: RequestInit<CfProperties<unknown>> | undefined
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : typeof input === "object" && "url" in input
          ? input.url
          : input.toString()
    );
    if (url.hostname === "example.com" && url.pathname === "/sub-path") {
      return new Response("Not allowed", { status: 403 });
    }
    return fetch(input, init);
  }
};

type State = {
  messages: UIMessage<typeof tools>[];
  loading: boolean;
};

export class Codemode extends Agent<Env, State> {
  /**
   * Handles incoming chat messages and manages the response stream
   */
  tools: ToolSet = {};

  observability = undefined;

  lastMessageRepliedTo: string | undefined;

  initialState: State = {
    messages: [],
    loading: false
  };

  async onStart() {
    this.lastMessageRepliedTo =
      this.state.messages[this.state.messages.length - 1]?.id;
  }

  @callable({
    description: "Add an MCP server to the agent"
  })
  addMcp({ name, url }: { name: string; url: string }) {
    void this.addMcpServer(name, url, { callbackHost: "http://localhost:5173" })
      .then(() => {
        console.log("mcpServer added", name, url);
      })
      .catch((error) => {
        console.error("mcpServer addition failed", error);
      });
  }

  @callable({
    description: "Remove an MCP server from the agent"
  })
  removeMcp(id: string) {
    void this.removeMcpServer(id);
  }

  callTool(functionName: string, args: unknown[]) {
    return this.tools[functionName]?.execute?.(args, {
      abortSignal: new AbortController().signal,
      toolCallId: "123",
      messages: []
    });
  }

  async onStateUpdate(state: State, source: Connection | "server") {
    if (source === "server") {
      return;
    }
    if (
      state.messages.length > 0 &&
      this.lastMessageRepliedTo !==
        state.messages[state.messages.length - 1]?.id
    ) {
      await this.onChatMessage();
      this.lastMessageRepliedTo = state.messages[state.messages.length - 1]?.id;
    }
  }

  async onChatMessage() {
    // Collect all tools, including MCP tools
    this.setState({ messages: this.state.messages, loading: true });
    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    this.tools = allTools;

    const { prompt, tools: wrappedTools } = await codemode({
      model,
      prompt: `You are a helpful assistant that can do various tasks... 

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.
`,
      tools: allTools,
      globalOutbound: env.globalOutbound,
      loader: env.LOADER,
      proxy: this.ctx.exports.CodeModeProxy({
        props: {
          binding: "Codemode",
          name: this.name,
          callback: "callTool"
        }
      })
    });

    const result = streamText({
      system: prompt,

      messages: await convertToModelMessages(this.state.messages),
      model,
      // tools: allTools,
      tools: wrappedTools,

      onError: (error) => {
        console.error("error", error);
      },
      // onFinish: ({response}) => {
      //   this.setState({ messages: this.state.messages, loading: false });
      // },

      stopWhen: stepCountIs(10)
    });

    for await (const uiMessage of readUIMessageStream<UIMessage<typeof tools>>({
      stream: result.toUIMessageStream({
        generateMessageId: generateId
      }),
      onError: (error) => {
        console.error("error", error);
      }
    })) {
      // console.log("Current message state:", uiMessage);
      this.setState({
        messages: updateMessages(this.state.messages, uiMessage),
        loading: this.state.loading
      });
    }
    this.setState({
      messages: this.state.messages,
      loading: false
    });
  }
}

function updateMessages(
  messages: UIMessage<typeof tools>[],
  newMessage: UIMessage<typeof tools>
) {
  const finalMessages = [];
  let updated = false;
  for (const message of messages) {
    if (message.id === newMessage.id) {
      finalMessages.push(newMessage);
      updated = true;
    } else {
      finalMessages.push(message);
    }
  }
  if (!updated) {
    finalMessages.push(newMessage);
  }

  return finalMessages;
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
