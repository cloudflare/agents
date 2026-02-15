import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import { withVoice, type VoiceTurnContext } from "agents/experimental/voice";
import { streamText, tool, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { ElevenLabsTTS } from "@cloudflare/agents-voice-elevenlabs";

const VoiceAgent = withVoice(Agent);

const SYSTEM_PROMPT = `You are a helpful voice assistant running on Cloudflare Workers. Keep your responses concise and conversational — you're being spoken aloud, not read. Aim for 1-3 sentences unless the user asks for more detail. Be warm and natural.

You have tools available:
- get_current_time: Tell the user the current date and time
- set_reminder: Set a spoken reminder after a delay (e.g. "remind me in 5 minutes to check the oven")
- get_weather: Check the weather for a location

Use tools when the user's request matches. After calling a tool, incorporate the result naturally into your spoken response.`;

export class MyVoiceAgent extends VoiceAgent<Env> {
  // Disable hibernation — voice agents must stay alive during active calls
  // to preserve audio buffers and in-flight pipeline state.
  static options = { hibernate: false };

  /**
   * Custom TTS: uses ElevenLabs when ELEVENLABS_API_KEY is set,
   * otherwise falls back to the default Workers AI TTS.
   *
   * Demonstrates the provider package pattern — the same ElevenLabsTTS
   * class can be used in any VoiceAgent subclass.
   */
  #tts: ElevenLabsTTS | null = null;

  #getTTS(): ElevenLabsTTS | null {
    if (this.#tts) return this.#tts;
    const apiKey = (this.env as unknown as Record<string, string>)
      .ELEVENLABS_API_KEY;
    if (!apiKey) return null;
    this.#tts = new ElevenLabsTTS({ apiKey });
    return this.#tts;
  }

  async synthesize(text: string): Promise<ArrayBuffer | null> {
    const tts = this.#getTTS();
    if (!tts) return super.synthesize(text);
    return tts.synthesize(text);
  }

  // Enable streaming TTS when using ElevenLabs
  async *synthesizeStream(text: string) {
    const tts = this.#getTTS();
    if (!tts) return;
    yield* tts.synthesizeStream(text);
  }

  // --- Single-speaker enforcement ---
  //
  // Only one connection can be the active speaker at a time. This prevents
  // two browser tabs from capturing audio simultaneously. Other connections
  // can still observe transcripts and send text messages.

  #activeSpeakerId: string | null = null;

  beforeCallStart(connection: Connection): boolean {
    if (this.#activeSpeakerId && this.#activeSpeakerId !== connection.id) {
      connection.send(
        JSON.stringify({
          type: "speaker_conflict",
          message:
            "Another session is currently the active speaker. You can kick them to take over."
        })
      );
      return false;
    }
    this.#activeSpeakerId = connection.id;
    return true;
  }

  onCallEnd(connection: Connection) {
    if (this.#activeSpeakerId === connection.id) {
      this.#activeSpeakerId = null;
    }
  }

  onClose(connection: Connection) {
    if (this.#activeSpeakerId === connection.id) {
      this.#activeSpeakerId = null;
    }
    super.onClose(connection);
  }

  onMessage(connection: Connection, message: WSMessage) {
    // Intercept kick_speaker before the voice protocol handles it
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "kick_speaker") {
          this.#handleKick(connection);
          return;
        }
      } catch {
        // not JSON — fall through
      }
    }
    super.onMessage(connection, message);
  }

  #handleKick(requester: Connection) {
    if (!this.#activeSpeakerId) {
      // No active speaker — nothing to kick
      return;
    }

    const activeConn = [...this.getConnections()].find(
      (c) => c.id === this.#activeSpeakerId
    );

    if (activeConn) {
      // Notify the kicked connection
      activeConn.send(
        JSON.stringify({
          type: "kicked",
          message: "Another session has taken over as the active speaker."
        })
      );
      // Force end their call (sends end_call internally)
      activeConn.send(JSON.stringify({ type: "end_call" }));
    }

    this.#activeSpeakerId = null;

    // Notify the requester they can now start
    requester.send(
      JSON.stringify({
        type: "speaker_available",
        message: "Previous speaker has been disconnected. You can start a call."
      })
    );
  }

  // --- Voice agent logic ---

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersAi(
        "@cf/moonshotai/kimi-k2.5" as Parameters<typeof workersAi>[0]
      ),
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
      abortSignal: context.signal
    });

    return result.textStream;
  }

  async onCallStart(connection: Connection) {
    const messageCount =
      this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_voice_messages
    `[0]?.count ?? 0;

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
