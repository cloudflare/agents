import { Agent, routeAgentRequest, type Connection } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  type TTSProvider,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { PlivoAdapter } from "@cloudflare/voice-plivo";
import { streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const SYSTEM_PROMPT = `You are a helpful voice assistant powered by Cloudflare Workers and Plivo. Keep responses concise and conversational — suitable for a phone call.

You have tools available:
- get_current_time: Tell the user the current date and time

Use tools when the user's request matches. After calling a tool, incorporate the result naturally into your spoken response.`;

/**
 * Workers AI TTS with raw linear16 PCM output — required for the mulaw
 * encoder in the Plivo adapter. WorkersAITTS defaults to MP3; we call
 * @cf/deepgram/aura-2-en directly with encoding + container params.
 */
class PlivoPCMTTS implements TTSProvider {
  constructor(private ai: Ai) {}

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const response = (await this.ai.run(
      "@cf/deepgram/aura-2-en",
      {
        text,
        speaker: "asteria",
        encoding: "linear16",
        sample_rate: 16000,
        container: "none"
      },
      { returnRawResponse: true, ...(signal ? { signal } : {}) }
    )) as Response;
    if (!response.ok) {
      // Returning the error body would ship JSON down the audio pipeline
      // and play as silence — fail loud and skip the audio instead.
      console.error("[PlivoPCMTTS] TTS failed:", await response.text());
      return null;
    }
    return response.arrayBuffer();
  }
}

const VoiceAgent = withVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new PlivoPCMTTS(this.env.AI);

  async onCallStart(connection: Connection) {
    await this.speak(connection, "Hello! How can I help you today?");
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersAi("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      tools: {
        get_current_time: tool({
          description: "Get the current date and time.",
          inputSchema: z.object({}),
          execute: async () => {
            const now = new Date();
            return {
              time: now.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                timeZoneName: "short"
              }),
              date: now.toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric"
              })
            };
          }
        })
      }
    });

    return result.textStream;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/answer") {
      // The Plivo application and number are provisioned at deploy time
      // (pnpm run deploy / pnpm run dev), so this just hands Plivo the audio
      // stream URL to open.
      const wsUrl = `wss://${url.host}/plivo`;
      const xml = `<Response><Stream keepCallAlive="true" bidirectional="true" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream></Response>`;
      return new Response(xml, {
        headers: { "Content-Type": "application/xml" }
      });
    }

    if (url.pathname === "/plivo") {
      return PlivoAdapter.handleRequest(
        request,
        env as unknown as Record<string, unknown>,
        "MyVoiceAgent"
      );
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
