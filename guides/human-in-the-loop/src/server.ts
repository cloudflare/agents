/**
 * Human-in-the-Loop Chat Agent
 *
 * This agent demonstrates tool confirmation workflow:
 * 1. User sends a message
 * 2. LLM decides to call a tool
 * 3. Client shows confirmation UI (via useChat hook)
 * 4. User approves/denies
 * 5. Server executes tool (if server-side) or receives result (if client-side)
 * 6. LLM responds with tool result
 */

import { openai } from "@ai-sdk/openai";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  convertToModelMessages,
  type StreamTextOnFinishCallback,
  streamText,
  stepCountIs
} from "ai";
import { serverTools, getWeatherInformation } from "./tools";
import { processToolCalls, hasToolConfirmation } from "./utils";

type Env = {
  OPENAI_API_KEY: string;
};

export class HumanInTheLoop extends AIChatAgent<Env> {
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    const startTime = Date.now();
    const lastMessage = this.messages[this.messages.length - 1];

    // Check if this is a tool confirmation response
    if (hasToolConfirmation(lastMessage)) {
      // Process the confirmation - execute server-side tools if approved
      const updatedMessages = await processToolCalls(
        { messages: this.messages, tools: serverTools },
        { getWeatherInformation } // Server-side tool implementations
      );

      // Update and persist messages with tool results
      this.messages = updatedMessages;
      await this.persistMessages(this.messages);

      // Continue the conversation so LLM can respond to the tool result
      const result = streamText({
        messages: convertToModelMessages(this.messages),
        model: openai("gpt-4o"),
        onFinish,
        tools: serverTools,
        stopWhen: stepCountIs(5)
      });

      return result.toUIMessageStreamResponse({
        messageMetadata: this.createMetadata(startTime)
      });
    }

    // Normal message - let LLM respond (may trigger tool calls)
    const result = streamText({
      messages: convertToModelMessages(this.messages),
      model: openai("gpt-4o"),
      onFinish,
      tools: serverTools,
      stopWhen: stepCountIs(5)
    });

    return result.toUIMessageStreamResponse({
      messageMetadata: this.createMetadata(startTime)
    });
  }

  /**
   * Creates metadata callback for stream responses.
   * This is optional - purely for demo purposes.
   */
  private createMetadata(startTime: number) {
    return ({
      part
    }: {
      part: { type: string; totalUsage?: { totalTokens?: number } };
    }) => {
      if (part.type === "start") {
        return {
          model: "gpt-4o",
          createdAt: Date.now(),
          messageCount: this.messages.length
        };
      }
      if (part.type === "finish") {
        return {
          responseTime: Date.now() - startTime,
          totalTokens: part.totalUsage?.totalTokens
        };
      }
    };
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
