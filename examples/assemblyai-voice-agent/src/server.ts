import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import {
  withVoice,
  type StreamingTTSProvider,
  type Transcriber,
  type TTSProvider,
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

const CARTESIA_VERSION = "2026-03-01";
const CARTESIA_MODEL = "sonic-3.5";
const CARTESIA_SAMPLE_RATE = 44100;
/** Reply considered finished this long after its last sentence arrives. */
const CONTEXT_IDLE_MS = 500;

/** Wrap raw pcm_s16le mono audio in a standalone WAV header so the browser's
 * `decodeAudioData` can play it. PCM decodes exactly (unlike MP3), so chunk
 * seams stay clean. */
function pcmToWav(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const write = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  write(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  write(8, "WAVEfmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  write(36, "data");
  v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out.buffer;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** One reply's continuation context on the Cartesia WebSocket. */
interface CartesiaContext {
  id: string;
  /** WAV-wrapped audio ready for the owning generator to yield. */
  queue: ArrayBuffer[];
  notify: (() => void) | null;
  done: boolean;
  /** No longer accepting sentences (finalize sent). */
  closing: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Odd trailing byte carried between chunks to keep samples aligned. */
  remainder: Uint8Array;
}

/**
 * Cartesia Sonic text-to-speech — a natural, low-latency voice for the host.
 *
 * There's no dedicated voice-provider package for Cartesia, so this adapter
 * shows how to bring any TTS vendor to the pipeline. It speaks two dialects:
 *
 * - `synthesize()` (one-shot utterances like the greeting): the REST
 *   `/tts/bytes` endpoint, returning a complete MP3.
 * - `synthesizeStream()` (streamed replies): the WebSocket API with
 *   **continuations**. The pipeline synthesizes each sentence as a separate
 *   call; generated independently, each sentence is a fresh generation and
 *   the voice's prosody audibly jumps between them. With continuations, all
 *   sentences of one reply share a `context_id`, so the model extends one
 *   generation instead of restarting.
 *
 * The continuation mapping relies on the pipeline starting sentence
 * syntheses eagerly: the first sentence of a reply opens the context and its
 * generator yields ALL of the context's audio; later sentences are pushed
 * into the open context and yield nothing, so playback order is unchanged.
 * A short idle timer finalizes the context after the reply's last sentence,
 * and barge-in cancels it.
 */
class CartesiaTTS implements TTSProvider, StreamingTTSProvider {
  #apiKey: string;
  #voiceId: string;
  #ws: WebSocket | null = null;
  /** Contexts still draining audio, keyed by context_id. */
  #contexts = new Map<string, CartesiaContext>();
  /** The context currently accepting new sentences, if any. */
  #openCtx: CartesiaContext | null = null;

  constructor(apiKey: string, options?: { voiceId?: string }) {
    this.#apiKey = apiKey;
    // "Katie" — a warm en-US voice from Cartesia's voice-agent picks.
    this.#voiceId = options?.voiceId ?? "f786b574-daa5-4673-aa0c-cbe3e8534c02";
  }

  // --- Streamed replies: WebSocket + continuations ---

  async *synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer> {
    if (signal?.aborted) return;
    let ws: WebSocket;
    try {
      ws = await this.#socket();
    } catch (err) {
      console.error("[CartesiaTTS] WebSocket connect failed:", err);
      return;
    }

    // A reply is already streaming — add this sentence to its context. The
    // context owner (the reply's first sentence) yields the audio.
    if (this.#openCtx && !this.#openCtx.closing) {
      this.#sendInput(ws, this.#openCtx.id, text, true);
      this.#armIdleTimer(this.#openCtx);
      return;
    }

    // First sentence of a reply: open a context and own its audio stream.
    const ctx: CartesiaContext = {
      id: crypto.randomUUID(),
      queue: [],
      notify: null,
      done: false,
      closing: false,
      idleTimer: null,
      remainder: new Uint8Array(0)
    };
    this.#contexts.set(ctx.id, ctx);
    this.#openCtx = ctx;
    this.#sendInput(ws, ctx.id, text, true);
    this.#armIdleTimer(ctx);

    const onAbort = () => {
      try {
        this.#ws?.send(JSON.stringify({ context_id: ctx.id, cancel: true }));
      } catch {
        // socket already gone
      }
      this.#finishContext(ctx);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        while (ctx.queue.length > 0) yield ctx.queue.shift()!;
        if (ctx.done) return;
        await new Promise<void>((resolve) => {
          ctx.notify = resolve;
        });
        ctx.notify = null;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #socket(): Promise<WebSocket> {
    if (this.#ws) return this.#ws;
    const resp = await fetch(
      `https://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_VERSION}`,
      { headers: { Upgrade: "websocket", "X-API-Key": this.#apiKey } }
    );
    const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
    if (!ws) {
      throw new Error(`upgrade rejected: HTTP ${resp.status}`);
    }
    ws.accept();
    ws.addEventListener("message", (event: MessageEvent) => {
      this.#onMessage(event);
    });
    const dropAll = () => {
      this.#ws = null;
      for (const ctx of this.#contexts.values()) this.#finishContext(ctx);
    };
    ws.addEventListener("close", dropAll);
    ws.addEventListener("error", dropAll);
    this.#ws = ws;
    return ws;
  }

  #sendInput(ws: WebSocket, contextId: string, text: string, more: boolean) {
    ws.send(
      JSON.stringify({
        model_id: CARTESIA_MODEL,
        transcript: text,
        voice: { mode: "id", id: this.#voiceId },
        language: "en",
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: CARTESIA_SAMPLE_RATE
        },
        context_id: contextId,
        continue: more
      })
    );
  }

  #onMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    let msg: {
      type?: string;
      context_id?: string;
      data?: string;
      message?: string;
      error_code?: string;
    };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const ctx = msg.context_id ? this.#contexts.get(msg.context_id) : undefined;
    if (!ctx) return;

    if (msg.type === "chunk" && typeof msg.data === "string") {
      const bytes = base64ToBytes(msg.data);
      // Keep 16-bit samples aligned across arbitrary chunk boundaries.
      const combined = new Uint8Array(ctx.remainder.length + bytes.length);
      combined.set(ctx.remainder, 0);
      combined.set(bytes, ctx.remainder.length);
      const even = combined.length & ~1;
      ctx.remainder = combined.slice(even);
      if (even > 0) {
        ctx.queue.push(pcmToWav(combined.slice(0, even), CARTESIA_SAMPLE_RATE));
        ctx.notify?.();
      }
    } else if (msg.type === "error") {
      console.error(
        `[CartesiaTTS] ${msg.error_code ?? "error"}: ${msg.message ?? ""}`
      );
      this.#finishContext(ctx);
    } else if (msg.type === "done") {
      this.#finishContext(ctx);
    }
  }

  #armIdleTimer(ctx: CartesiaContext) {
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    ctx.idleTimer = setTimeout(() => {
      // No new sentence for a while — the reply is finished. Close the
      // context (empty transcript, continue: false) so Cartesia flushes the
      // tail audio and sends `done`; a safety timer guards a lost socket.
      ctx.closing = true;
      if (this.#openCtx === ctx) this.#openCtx = null;
      if (this.#ws) this.#sendInput(this.#ws, ctx.id, "", false);
      ctx.idleTimer = setTimeout(() => this.#finishContext(ctx), 5000);
    }, CONTEXT_IDLE_MS);
  }

  #finishContext(ctx: CartesiaContext) {
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    ctx.idleTimer = null;
    ctx.closing = true;
    ctx.done = true;
    ctx.notify?.();
    this.#contexts.delete(ctx.id);
    if (this.#openCtx === ctx) this.#openCtx = null;
  }

  // --- One-shot utterances (greeting): REST bytes endpoint ---

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    if (signal?.aborted) return null;
    const resp = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model_id: CARTESIA_MODEL,
        transcript: text,
        voice: { mode: "id", id: this.#voiceId },
        language: "en",
        output_format: {
          container: "mp3",
          sample_rate: 44100,
          bit_rate: 128000
        }
      })
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`[CartesiaTTS] HTTP ${resp.status}: ${body.slice(0, 200)}`);
      return null;
    }
    return await resp.arrayBuffer();
  }
}

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
  tts = new CartesiaTTS(this.env.CARTESIA_API_KEY);

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
      // Workers AI's default output cap (~256 tokens) can cut replies off
      // mid-sentence — and starves reasoning models of text entirely.
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
