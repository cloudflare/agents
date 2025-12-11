import { openai } from "@ai-sdk/openai";
import { type AgentNamespace, routeAgentRequest } from "agents";
import {
  AIChatAgent,
  createToolsFromClientSchemas,
  type OnChatMessageOptions
} from "agents/ai-chat-agent";
import {
  streamText,
  convertToModelMessages,
  type StreamTextOnFinishCallback,
  type ToolSet
} from "ai";

type Env = {
  OPENAI_API_KEY: string;
  ClientToolsAgent: AgentNamespace<ClientToolsAgent>;
};

/**
 * Client Tools Bug Reproduction
 *
 * This example reproduces the duplicate message bug when using client-defined tools.
 *
 * BUG: When a client tool executes and returns a result, duplicate assistant
 * messages are persisted to the database, causing OpenAI to reject subsequent
 * requests with "Duplicate item found" error.
 *
 * Steps to reproduce:
 * 1. Start the app: npm run start
 * 2. Ask: "Change the background to red"
 * 3. The tool executes on the client
 * 4. Send a follow-up: "Thanks!"
 * 5. ERROR: "Duplicate item found with id rs_..."
 *
 * The fix is to pass `originalMessages: this.messages` to toUIMessageStreamResponse()
 */
export class ClientToolsAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ): Promise<Response> {
    // Log messages for debugging
    console.log("=== onChatMessage called ===");
    console.log("this.messages count:", this.messages.length);
    console.log("this.messages:", JSON.stringify(this.messages, null, 2));

    // Also log what convertToModelMessages produces
    const modelMessages = convertToModelMessages(this.messages);
    console.log("modelMessages:", JSON.stringify(modelMessages, null, 2));

    // Convert client tool schemas to server tools (without execute)
    // This allows OpenAI to call tools that will execute on the client
    const clientTools = createToolsFromClientSchemas(options?.clientTools);

    // Using gpt-4o-mini - change to "o3-mini" or other reasoning model to see itemId duplicates
    const result = streamText({
      model: openai("gpt-5-mini"),
      messages: convertToModelMessages(this.messages),
      tools: {
        ...clientTools // Tools WITHOUT execute - client will run them
      },
      onFinish
    });

    // BUG: Not passing originalMessages causes duplicate messages
    // FIX: Uncomment the line below to fix the bug
    //return result.toUIMessageStreamResponse();
    return result.toUIMessageStreamResponse({
      originalMessages: this.messages
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
