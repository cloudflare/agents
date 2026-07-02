import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import {
  withVoice,
  type TTSProvider,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { AssemblyAISTT } from "@cloudflare/voice-assemblyai";
import { streamText, tool, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const VoiceAgent = withVoice(Agent);

/**
 * Workers AI MeloTTS text-to-speech.
 *
 * MeloTTS runs entirely on the AI binding, so — like Aura — it needs no API
 * key beyond what Workers AI already provides. It takes `{ prompt, lang }` and
 * returns base64-encoded MP3 in an `audio` field, unlike Aura which streams
 * raw audio bytes, so it gets this small adapter rather than reusing the
 * built-in `WorkersAITTS` (which sends `{ text, speaker }` and reads raw bytes).
 *
 * It implements only `synthesize` (one MP3 per sentence) — no sub-sentence
 * streaming — but the voice pipeline still chunks the LLM output by sentence,
 * so audio comes back sentence-by-sentence and barge-in still works.
 */
class MeloTTS implements TTSProvider {
  #ai: Ai;
  #lang: string;

  constructor(ai: Ai, options?: { lang?: string }) {
    this.#ai = ai;
    this.#lang = options?.lang ?? "en";
  }

  async synthesize(text: string): Promise<ArrayBuffer | null> {
    const result = (await this.#ai.run("@cf/myshell-ai/melotts", {
      prompt: text,
      lang: this.#lang
    })) as { audio?: string };

    if (!result?.audio) return null;

    // MeloTTS returns base64-encoded MP3 — decode to raw bytes for playback.
    const binary = atob(result.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
}

const SYSTEM_PROMPT = `You are a helpful voice assistant running on Cloudflare Workers, transcribed by AssemblyAI Universal 3.5 Pro Realtime. Keep your responses concise and conversational — you're being spoken aloud, not read. Aim for 1-3 sentences unless the user asks for more detail. Be warm and natural.

You have tools available:
- get_current_time: Tell the user the current date and time
- set_reminder: Set a spoken reminder after a delay (e.g. "remind me in 5 minutes to check the oven")
- get_weather: Check the weather for a location

Use tools when the user's request matches. After calling a tool, incorporate the result naturally into your spoken response.`;

/**
 * Real-time voice agent: browser mic → WebSocket → AssemblyAI STT → LLM →
 * Workers AI TTS, all inside one Durable Object.
 *
 * STT is AssemblyAI Universal 3.5 Pro Realtime (`universal-3-5-pro`), which
 * handles turn detection and barge-in (`SpeechStarted`) server-side. After each
 * reply, `withVoice` feeds the agent's spoken text back to AssemblyAI as
 * `agent_context`, so the model knows the question the user is answering.
 * The only external credential needed is `ASSEMBLYAI_API_KEY`; the LLM and TTS
 * run on the Workers AI binding.
 */
export class AssemblyAIVoiceAgent extends VoiceAgent<Env> {
  transcriber = new AssemblyAISTT({ apiKey: this.env.ASSEMBLYAI_API_KEY });
  tts = new MeloTTS(this.env.AI);

  // --- Single-speaker enforcement ---
  //
  // Only one connection captures audio at a time, so two browser tabs don't
  // stream mic audio into the same agent simultaneously.

  #activeSpeakerId: string | null = null;

  beforeCallStart(connection: Connection): boolean {
    if (this.#activeSpeakerId && this.#activeSpeakerId !== connection.id) {
      connection.send(
        JSON.stringify({
          type: "speaker_conflict",
          message: "Another session is already the active speaker."
        })
      );
      return false;
    }
    this.#activeSpeakerId = connection.id;
    return true;
  }

  onCallEnd(connection: Connection) {
    if (this.#activeSpeakerId === connection.id) this.#activeSpeakerId = null;
  }

  onClose(connection: Connection) {
    if (this.#activeSpeakerId === connection.id) this.#activeSpeakerId = null;
  }

  onMessage(_connection: Connection, _message: WSMessage) {
    // Voice-protocol messages are intercepted by the mixin; nothing else to do.
  }

  // --- Voice agent logic ---

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersAi("@cf/zai-org/glm-4.7-flash", {
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
          description:
            "Get the current date and time. Use when the user asks what time it is.",
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
        }),

        set_reminder: tool({
          description:
            "Set a reminder that will be spoken aloud after a delay.",
          inputSchema: z.object({
            message: z
              .string()
              .describe("The reminder message to speak to the user"),
            delay_seconds: z
              .number()
              .describe("How many seconds from now to trigger the reminder")
          }),
          execute: async ({
            message,
            delay_seconds
          }: {
            message: string;
            delay_seconds: number;
          }) => {
            await this.schedule(delay_seconds, "speakReminder", { message });
            const minutes = Math.round(delay_seconds / 60);
            const timeLabel =
              minutes >= 1
                ? `${minutes} minute${minutes > 1 ? "s" : ""}`
                : `${delay_seconds} seconds`;
            return { confirmed: true, message, delay: timeLabel };
          }
        }),

        get_weather: tool({
          description:
            "Get the current weather for a location. Use when the user asks about the weather.",
          inputSchema: z.object({
            location: z
              .string()
              .describe("The city or location to check weather for")
          }),
          execute: async ({ location }: { location: string }) => {
            const conditions = [
              "sunny",
              "partly cloudy",
              "overcast",
              "light rain"
            ];
            const condition =
              conditions[Math.floor(Math.random() * conditions.length)];
            const temp = Math.floor(55 + Math.random() * 35);
            return {
              location,
              temperature: `${temp}°F`,
              condition,
              note: "Mock data — connect a weather MCP server for real forecasts."
            };
          }
        })
      },
      stopWhen: stepCountIs(3),
      abortSignal: context.signal,
      // streamText swallows stream errors by default — log them so LLM
      // failures are visible instead of surfacing as an empty reply.
      onError: ({ error }) => console.error("[VoiceAgent] LLM error:", error)
    });

    return result.textStream;
  }

  async onCallStart(connection: Connection) {
    // getConversationHistory() (not raw SQL) — it creates the messages table
    // on first use, so this works on a brand-new agent instance.
    const messageCount = this.getConversationHistory().length;

    const greeting =
      messageCount > 0
        ? "Welcome back! How can I help you today?"
        : "Hi there! I'm your voice assistant. I can answer questions, set reminders, or check the weather. What can I do for you?";

    await this.speak(connection, greeting);
  }

  async speakReminder(payload: { message: string }) {
    await this.speakAll(`Reminder: ${payload.message}`);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
