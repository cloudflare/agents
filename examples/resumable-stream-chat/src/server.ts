import { openai } from "@ai-sdk/openai";
import {
  Agent,
  type AgentNamespace,
  callable,
  routeAgentRequest,
  ResumableStreamManager,
  type GenerateAIResponseOptions,
  type QueueItem,
  type ResumableStreamState
} from "agents";
import { streamText } from "ai";

type Env = {
  OPENAI_API_KEY: string;
  ResumableStreamingChat: AgentNamespace<ResumableStreamingChat>;
};

export interface ResumableStreamingChatState extends ResumableStreamState {
  // Inherits: messages, activeStreamId
}

export class ResumableStreamingChat extends Agent<
  Env,
  ResumableStreamingChatState
> {
  private streams = new ResumableStreamManager(this, this.ctx);

  initialState: ResumableStreamingChatState = {
    messages: [],
    activeStreamId: null
  };

  async onStart() {
    await super.onStart();
    await this.streams.initializeTables();
    await this.streams.loadAndSyncMessages();
  }

  @callable()
  async sendMessage(
    content: string
  ): Promise<{ messageId: string; streamId: string }> {
    return this.streams.sendMessage(content);
  }

  /**
   * Generate AI response using streaming
   */
  async generateAIResponse(
    options: GenerateAIResponseOptions
  ): Promise<string> {
    const messages = options.messages.map((msg) => ({
      role: msg.role,
      content: msg.content
    }));

    const result = streamText({
      model: openai("gpt-4o"),
      messages
    });

    let fullContent = "";
    // Stream and broadcast each chunk
    for await (const chunk of result.textStream) {
      fullContent += chunk;
      await options.processChunk(chunk);
    }

    return fullContent;
  }

  /**
   * Queue callback for background processing
   */
  async _handleStreamGeneration(
    payload: { userMessageId: string; streamId: string },
    _queueItem?: QueueItem
  ) {
    await this.streams.generateResponseCallback(payload);
  }

  @callable()
  async getStreamHistory(streamId: string) {
    return this.streams.getStreamHistory(streamId);
  }

  @callable()
  async clearHistory() {
    await this.streams.clearHistory();
    this.setState(this.initialState);
  }

  @callable()
  async getActiveStream(): Promise<string | null> {
    return this.state.activeStreamId;
  }

  @callable()
  async cleanupOldStreams(olderThanDays = 7): Promise<number> {
    const olderThanMs = olderThanDays * 24 * 60 * 60 * 1000;
    return this.streams.cleanupOldStreams(olderThanMs);
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
