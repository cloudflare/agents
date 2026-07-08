import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import {
  withVoice,
  WorkersAITTS,
  type Transcriber,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { AssemblyAISTT } from "@cloudflare/voice-assemblyai";
import { streamText, tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

const VoiceAgent = withVoice(Agent);

/**
 * Luna Rossa — a phone reservation desk for a (fictional) Italian restaurant.
 *
 * This is the kind of call flow conversational STT is hardest on: the agent
 * asks a question and the caller answers tersely — "four", "Friday", "seven
 * thirty", a spelled-out name. Two things in this example help AssemblyAI get
 * those right:
 *
 * - `agent_context` carryover: after each spoken reply, `withVoice` feeds the
 *   agent's words back to AssemblyAI automatically, so the model knows the
 *   question the caller is answering ("table for four at seven", not "for
 *   Four at Seven").
 * - `prompt` + `keyterms`: connection-time hints about the call domain and
 *   the venue's unusual vocabulary (menu items), boosting their recognition.
 */

// --- Restaurant configuration ---

const SEATINGS = [
  "17:00",
  "17:30",
  "18:00",
  "18:30",
  "19:00",
  "19:30",
  "20:00",
  "20:30",
  "21:00",
  "21:30"
];
const TABLES_PER_SEATING = 4;
const MAX_PARTY_SIZE = 8;

const MENU_HIGHLIGHTS = [
  { dish: "cacio e pepe", note: "tonnarelli, pecorino, black pepper" },
  { dish: "burrata", note: "with datterini tomatoes and basil" },
  { dish: "branzino al forno", note: "whole roasted sea bass" },
  { dish: "tiramisu", note: "made to order, twenty minutes" }
];

function systemPrompt(): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  return `You are the host at Luna Rossa, a cozy Italian restaurant, taking reservations over the phone. Today is ${today}.

You are being spoken aloud, so keep replies to one or two short, warm sentences.

Reservation flow:
- Collect: date, time, party size, and a name. Ask for ONE missing detail at a time — never several in one breath.
- Seatings run five to nine-thirty in the evening, every half hour. Always check availability before promising a table; if a slot is full, offer the alternatives you are given.
- Read the full reservation back (date, time, party size, name) and get a yes before booking.
- After booking, give the confirmation code clearly, reading the letters and digits one by one.
- You can also share tonight's menu highlights, look up a caller's reservation by name, or cancel one by confirmation code.
- If a caller asks for something outside reservations or the menu, politely steer back.`;
}

/**
 * Real-time voice reservation desk: browser mic → WebSocket → AssemblyAI STT
 * → LLM with reservation tools → Workers AI TTS, all inside one Durable
 * Object. Reservations live in the DO's SQLite, so they survive across calls
 * — call back and it remembers you.
 */
export class AssemblyAIVoiceAgent extends VoiceAgent<Env> {
  transcriber = this.#observableTranscriber();
  tts = new WorkersAITTS(this.env.AI);

  // --- "Under the hood" events for the demo UI ---
  //
  // The client renders these in a debug panel so you can watch the machinery:
  // agent_context updates flowing to AssemblyAI, and tool calls/results
  // flowing between the LLM and the reservation database.

  #debugEvent(event: Record<string, unknown>) {
    this.broadcast(
      JSON.stringify({ type: "debug_event", t: Date.now(), ...event })
    );
  }

  /**
   * The real AssemblyAI transcriber, wrapped so the exact `agent_context`
   * values the pipeline sends (via `UpdateConfiguration`) are also surfaced
   * to the UI at the moment they go out.
   */
  #observableTranscriber(): Transcriber {
    const stt = new AssemblyAISTT({
      apiKey: this.env.ASSEMBLYAI_API_KEY,
      // Natural-language context about the audio (who is calling and why).
      prompt:
        "Phone reservations for Luna Rossa, an Italian restaurant. Callers give dates, times, party sizes, names, and phone numbers, and ask about menu dishes.",
      // Boost the venue's unusual vocabulary.
      keyterms: [
        "Luna Rossa",
        "cacio e pepe",
        "burrata",
        "branzino",
        "tiramisu"
      ]
    });
    return {
      createSession: (opts) => {
        const session = stt.createSession(opts);
        const send = session.updateAgentContext?.bind(session);
        if (send) {
          session.updateAgentContext = (text: string) => {
            this.#debugEvent({ kind: "agent_context", text });
            send(text);
          };
        }
        return session;
      }
    };
  }

  // --- Reservation storage (Durable Object SQLite) ---

  #tableReady = false;

  #ensureTable() {
    if (this.#tableReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        party_size INTEGER NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        created_at INTEGER NOT NULL
      )
    `;
    this.#tableReady = true;
  }

  #bookedCount(date: string, time: string): number {
    this.#ensureTable();
    return (
      this.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM reservations
        WHERE date = ${date} AND time = ${time}
      `[0]?.count ?? 0
    );
  }

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
    console.log("[VoiceAgent] onTurn:", transcript);
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });

    const result = streamText({
      model: openai("gpt-4.1-mini"),
      system: systemPrompt(),
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      tools: {
        check_availability: tool({
          description:
            "Check whether a table is free for a given date, time, and party size. Returns alternatives when the slot is full.",
          inputSchema: z.object({
            date: z.string().describe("Reservation date as YYYY-MM-DD"),
            time: z.string().describe("Seating time as HH:MM, 24-hour"),
            party_size: z.number().describe("Number of guests")
          }),
          execute: async ({ date, time, party_size }) => {
            if (party_size < 1 || party_size > MAX_PARTY_SIZE) {
              return {
                available: false,
                reason: `We seat parties of 1 to ${MAX_PARTY_SIZE}. For larger groups, suggest calling during the day to arrange a private event.`
              };
            }
            if (!SEATINGS.includes(time)) {
              return {
                available: false,
                reason: "Not a seating time",
                seatings: SEATINGS
              };
            }
            if (this.#bookedCount(date, time) < TABLES_PER_SEATING) {
              return { available: true, date, time, party_size };
            }
            const alternatives = SEATINGS.filter(
              (t) =>
                t !== time && this.#bookedCount(date, t) < TABLES_PER_SEATING
            ).slice(0, 3);
            return { available: false, reason: "Slot is full", alternatives };
          }
        }),

        create_reservation: tool({
          description:
            "Create the reservation once the caller has confirmed date, time, party size, and name. Returns a confirmation code.",
          inputSchema: z.object({
            date: z.string().describe("Reservation date as YYYY-MM-DD"),
            time: z.string().describe("Seating time as HH:MM, 24-hour"),
            party_size: z.number(),
            name: z.string().describe("Name for the reservation"),
            phone: z
              .string()
              .optional()
              .describe("Contact phone number, if the caller offered one")
          }),
          execute: async ({ date, time, party_size, name, phone }) => {
            this.#ensureTable();
            if (
              !SEATINGS.includes(time) ||
              this.#bookedCount(date, time) >= TABLES_PER_SEATING
            ) {
              return {
                created: false,
                reason: "Slot no longer available — re-check availability."
              };
            }
            const row = this.sql<{ id: number }>`
              INSERT INTO reservations (code, date, time, party_size, name, phone, created_at)
              VALUES ('pending', ${date}, ${time}, ${party_size}, ${name}, ${phone ?? null}, ${Date.now()})
              RETURNING id
            `[0];
            const code = `LR-${1000 + (row?.id ?? 0)}`;
            this
              .sql`UPDATE reservations SET code = ${code} WHERE id = ${row?.id ?? -1}`;
            return { created: true, confirmation_code: code };
          }
        }),

        find_reservation: tool({
          description:
            "Look up existing reservations, optionally filtered by the caller's name.",
          inputSchema: z.object({
            name: z.string().optional().describe("Name on the reservation")
          }),
          execute: async ({ name }) => {
            this.#ensureTable();
            const rows = name
              ? this.sql<Record<string, unknown>>`
                  SELECT code, date, time, party_size, name FROM reservations
                  WHERE lower(name) LIKE ${`%${name.toLowerCase()}%`}
                  ORDER BY date, time LIMIT 5
                `
              : this.sql<Record<string, unknown>>`
                  SELECT code, date, time, party_size, name FROM reservations
                  ORDER BY created_at DESC LIMIT 5
                `;
            return { reservations: rows };
          }
        }),

        cancel_reservation: tool({
          description: "Cancel a reservation by its confirmation code.",
          inputSchema: z.object({
            confirmation_code: z.string().describe("Code like LR-1042")
          }),
          execute: async ({ confirmation_code }) => {
            this.#ensureTable();
            const code = confirmation_code.toUpperCase().replace(/\s+/g, "");
            const existing = this.sql<{ id: number }>`
              SELECT id FROM reservations WHERE code = ${code}
            `;
            if (existing.length === 0) {
              return { cancelled: false, reason: "No reservation found" };
            }
            this.sql`DELETE FROM reservations WHERE code = ${code}`;
            return { cancelled: true, confirmation_code: code };
          }
        }),

        get_menu_highlights: tool({
          description:
            "Tonight's menu highlights, for callers who ask what to expect.",
          inputSchema: z.object({}),
          execute: async () => ({ highlights: MENU_HIGHLIGHTS })
        })
      },
      stopWhen: stepCountIs(3),
      // Generous output cap. Some providers default much lower (Workers AI:
      // ~256 tokens), which cuts replies mid-sentence — and starves reasoning
      // models of speakable text entirely.
      maxOutputTokens: 2048,
      abortSignal: context.signal,
      // streamText swallows stream errors by default — log them so LLM
      // failures are visible instead of surfacing as an empty reply.
      onError: ({ error }) => console.error("[VoiceAgent] LLM error:", error),
      onFinish: ({ finishReason, text, reasoningText }) =>
        console.log(
          `[VoiceAgent] LLM finish: reason=${finishReason} textLen=${text.length} reasoningLen=${reasoningText?.length ?? 0}`
        ),
      onStepFinish: ({ toolCalls, toolResults }) => {
        for (const call of toolCalls) {
          this.#debugEvent({
            kind: "tool_call",
            tool: call.toolName,
            input: call.input
          });
        }
        for (const result of toolResults) {
          this.#debugEvent({
            kind: "tool_result",
            tool: result.toolName,
            output: result.output
          });
        }
      }
    });

    return result.fullStream;
  }

  async onCallStart(connection: Connection) {
    this.#ensureTable();
    const upcoming =
      this.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM reservations
      `[0]?.count ?? 0;

    const greeting =
      upcoming > 0
        ? "Luna Rossa, welcome back! Are you calling about your reservation, or to book a new table?"
        : "Thank you for calling Luna Rossa! Would you like to book a table?";

    await this.speak(connection, greeting);
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
