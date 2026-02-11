import { VoiceAgent, type VoiceTurnContext } from "agents/voice";
import type { Connection } from "agents";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export class PlaygroundVoiceAgent extends VoiceAgent<Env> {
  async onTurn(transcript: string, context: VoiceTurnContext) {
    const ai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: ai("@cf/moonshotai/kimi-k2.5" as Parameters<typeof ai>[0]),
      system:
        "You are a friendly voice assistant in a demo playground. Keep responses concise — 1-2 sentences. Be warm and helpful.",
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      abortSignal: context.signal
    });

    return result.textStream;
  }

  async onCallStart(connection: Connection) {
    await this.speak(
      connection,
      "Hi! I'm a voice agent running in the playground. What would you like to talk about?"
    );
  }
}
