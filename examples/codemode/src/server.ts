import {
  routeAgentRequest,
  type Schedule,
  Agent,
  getAgentByName,
  type AgentNamespace
} from "agents";

import { getSchedulePrompt } from "agents/schedule";

import { codemode } from "agents/codemode/ai";
import {
  generateId,
  streamText,
  type UIMessage,
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type ToolSet
} from "ai";
import { openai } from "@ai-sdk/openai";
import { tools } from "./tools";
import { env } from "cloudflare:workers";

// export this WorkerEntryPoint that lets you
// reroute function calls back to a caller
export { CodeModeProxy } from "agents/codemode/ai";

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

export class Codemode extends Agent<
  Env,
  {
    messages: UIMessage<typeof tools>[];
  }
> {
  /**
   * Handles incoming chat messages and manages the response stream
   */
  tools: ToolSet = {};

  async onStart() {
    console.log("Chat onStart");
    void this.addMcpServer(
      "cloudflare-agents",
      "https://gitmcp.io/cloudflare/agents",
      "http://localhost:5173"
    )
      .then(() => {
        console.log("mcpServer added");
      })
      .catch((error) => {
        console.error("mcpServer addition failed", error);
      });
  }

  callTool(functionName: string, args: unknown[]) {
    return this.tools[functionName]?.execute?.(args, {
      abortSignal: new AbortController().signal,
      toolCallId: "123",
      messages: []
    });
  }

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: { abortSignal?: AbortSignal }
  ) {
    // const mcpConnection = await this.mcp.connect(
    //   "https://path-to-mcp-server/sse"
    // );

    // Collect all tools, including MCP tools
    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    this.tools = allTools;

    const { prompt, tools: wrappedTools } = await codemode({
      prompt: `You are a helpful assistant that can do various tasks... 

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.
`,
      tools: allTools,
      globalOutbound: env.globalOutbound,
      loader: env.LOADER,
      proxy: this.ctx.exports.CodeModeProxy({
        props: {
          binding: "Chat",
          name: this.name,
          callback: "callTool"
        }
      })
    });

    const stream = createUIMessageStream({
      onError: (error) => {
        console.error("error", error);
        return `Error: ${error}`;
      },
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        // const cleanedMessages = cleanupMessages(this.messages);

        // // Process any pending tool calls from previous messages
        // // This handles human-in-the-loop confirmations for tools
        // const processedMessages = await processToolCalls({
        //   messages: cleanedMessages,
        //   dataStream: writer,
        //   tools: wrappedTools,
        //   executions
        // });

        const result = streamText({
          system: prompt,

          messages: convertToModelMessages(this.state.messages),
          model,
          // tools: allTools,
          tools: wrappedTools,
          // Type boundary: streamText expects specific tool types, but base class uses ToolSet
          // This is safe because our tools satisfy ToolSet interface (verified by 'satisfies' in tools.ts)
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<
            typeof wrappedTools
          >,
          onError: (error) => {
            console.error("error", error);
          },

          stopWhen: stepCountIs(10)
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
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
