import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs
} from "ai";
import { Workspace } from "agents/workspace";
import {
  AssistantAgent,
  createWorkspaceTools
} from "agents/experimental/assistant";
import type { ChatMessageOptions } from "agents/experimental/assistant";

/**
 * Assistant agent with workspace tools and session management.
 *
 * Extends AssistantAgent which handles the WebSocket chat protocol,
 * session lifecycle, and message persistence via SessionManager.
 * No dual persistence — SessionManager is the single source of truth.
 */
export class MyAssistant extends AssistantAgent {
  workspace = new Workspace(this);

  async onChatMessage(options?: ChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const tools = createWorkspaceTools(this.workspace);

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      abortSignal: options?.abortSignal,
      system: `You are a helpful coding assistant with access to a persistent workspace filesystem.

You can read, write, edit, find, and search files in the workspace. Use these tools to help the user with their tasks.

Guidelines:
- Always read a file before editing it
- When editing, provide enough context in old_string to make the match unique
- Use the find tool to discover project structure
- Use the grep tool to search for patterns across files
- Create parent directories automatically when writing files`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools,
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
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
