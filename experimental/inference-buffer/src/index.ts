/**
 * Inference Buffer — durable response buffer for long-running inference calls.
 *
 * Prototype for RFC #1257: AI Gateway as durable response buffer.
 * See README.md for the full architecture and how this maps to AI Gateway.
 *
 * ## Core concept
 *
 * A separate Worker + Durable Object that proxies streaming inference requests
 * and buffers the response in SQLite. If the calling DO (an AIChatAgent) is
 * evicted mid-stream, the buffer keeps consuming from the provider. The
 * restarted agent reconnects via /resume and gets the remaining chunks —
 * zero wasted tokens, zero duplicate provider calls.
 *
 * ## Why this works
 *
 * The buffer Worker is a SEPARATE deployment from the agent Worker. When
 * the user deploys new agent code, their agent DOs are evicted but the
 * buffer DOs are not. The provider connection lives in the buffer's
 * execution context (via ctx.waitUntil), so it survives the agent's eviction.
 *
 * ## Provider support
 *
 * - HTTP providers (OpenAI, Anthropic): transparent fetch proxy
 * - Workers AI: direct AI.run() via the buffer's own AI binding
 *
 * ## Endpoints
 *
 *   POST /proxy    — forward to provider, buffer response, stream to caller
 *   GET  /resume   — tail buffered chunks from ?from=<N> (blocks on live stream)
 *   GET  /drain    — snapshot read from ?from=<N> (returns immediately)
 *   GET  /status   — { status, chunkCount }
 *   POST /ack      — acknowledge receipt, trigger early cleanup
 */
import { DurableObject } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  INFERENCE_BUFFER: DurableObjectNamespace<InferenceBuffer>;
  AI: Ai;
}

type BufferStatus =
  | "idle"
  | "streaming"
  | "completed"
  | "interrupted"
  | "error";

// ---------------------------------------------------------------------------
// InferenceBuffer Durable Object
// ---------------------------------------------------------------------------

export class InferenceBuffer extends DurableObject<Env> {
  private _status: BufferStatus = "idle";
  private _chunkCount = 0;

  // Notification signal — lets resume tailers block until new chunks arrive
  // without polling. Resolved each time a chunk is stored; immediately
  // replaced with a fresh promise.
  private _signal!: { promise: Promise<void>; resolve: () => void };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this._resetSignal();
    this._initSchema();
    this._restore();
  }

  // -- Signal helpers -------------------------------------------------------

  private _resetSignal() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this._signal = { promise, resolve };
  }

  private _notify() {
    this._signal.resolve();
    this._resetSignal();
  }

  // -- Schema & restore -----------------------------------------------------

  private _initSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS buffer_chunks (
        chunk_index INTEGER PRIMARY KEY,
        data TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS buffer_meta (
        id INTEGER PRIMARY KEY DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at INTEGER NOT NULL DEFAULT 0,
        ttl_ms INTEGER NOT NULL DEFAULT 300000
      )
    `);
  }

  /**
   * On construction (after eviction/restart), restore in-memory state from
   * SQLite. If the previous incarnation was mid-stream, the provider
   * connection is gone — mark as "interrupted" so callers know they have
   * partial data and should fall back to continueLastTurn for the remainder.
   */
  private _restore() {
    const rows = this.ctx.storage.sql
      .exec<{ status: string }>("SELECT status FROM buffer_meta WHERE id = 1")
      .toArray();

    if (rows.length === 0) return;

    const persisted = rows[0].status;

    if (persisted === "streaming") {
      // Provider connection died with the old process
      this._status = "interrupted";
      this.ctx.storage.sql.exec(
        "UPDATE buffer_meta SET status = 'interrupted' WHERE id = 1"
      );
      // Schedule cleanup — without this, the partial buffer leaks forever
      // since _consumeProvider (which normally sets the alarm) died with
      // the old process.
      this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
    } else {
      this._status = persisted as BufferStatus;
    }

    const maxRow = this.ctx.storage.sql
      .exec<{ m: number | null }>(
        "SELECT MAX(chunk_index) AS m FROM buffer_chunks"
      )
      .toArray();
    this._chunkCount = ((maxRow[0]?.m as number) ?? -1) + 1;

    if (persisted === "streaming") {
      console.log(
        `[buffer] restored as interrupted, ${this._chunkCount} chunks from previous stream`
      );
    }
  }

  // -- Routing --------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/proxy":
        if (request.method !== "POST")
          return new Response("Method not allowed", { status: 405 });
        return this._handleProxy(request);

      case "/resume":
        if (request.method !== "GET")
          return new Response("Method not allowed", { status: 405 });
        return this._handleResume(
          parseInt(url.searchParams.get("from") ?? "0")
        );

      case "/status":
        return Response.json({
          status: this._status,
          chunkCount: this._chunkCount
        });

      case "/drain":
        if (request.method !== "GET")
          return new Response("Method not allowed", { status: 405 });
        return this._handleDrain(parseInt(url.searchParams.get("from") ?? "0"));

      case "/ack":
        if (request.method !== "POST")
          return new Response("Method not allowed", { status: 405 });
        return this._handleAck();

      default:
        return new Response("Not found", { status: 404 });
    }
  }

  // -- Proxy ----------------------------------------------------------------

  private async _handleProxy(request: Request): Promise<Response> {
    if (this._status === "streaming") {
      return Response.json(
        { error: "Buffer already streaming" },
        { status: 409 }
      );
    }

    const providerType = request.headers.get("X-Provider-Type") || "http";

    if (providerType === "workers-ai") {
      return this._handleWorkersAIProxy(request);
    }

    return this._handleHTTPProxy(request);
  }

  /**
   * HTTP provider proxy (OpenAI, Anthropic, etc.): forward the request,
   * buffer the SSE response, stream to caller.
   */
  private async _handleHTTPProxy(request: Request): Promise<Response> {
    const providerUrl = request.headers.get("X-Provider-URL");
    if (!providerUrl) {
      return Response.json(
        { error: "Missing X-Provider-URL header" },
        { status: 400 }
      );
    }

    const providerHeaders = new Headers();
    for (const [key, value] of request.headers) {
      const lk = key.toLowerCase();
      if (lk.startsWith("x-buffer-") || lk === "x-provider-url") continue;
      if (lk === "x-provider-type" || lk === "x-ai-model") continue;
      if (lk === "host" || lk === "cf-connecting-ip") continue;
      providerHeaders.set(key, value);
    }

    let providerResponse: Response;
    try {
      providerResponse = await fetch(providerUrl, {
        method: "POST",
        headers: providerHeaders,
        body: request.body
      });
    } catch {
      return Response.json({ error: "Provider fetch failed" }, { status: 502 });
    }

    if (!providerResponse.ok || !providerResponse.body) {
      return new Response(providerResponse.body, {
        status: providerResponse.status,
        headers: providerResponse.headers
      });
    }

    console.log(`[buffer] proxy → ${providerUrl} (${providerResponse.status})`);

    return this._startBuffering(
      providerResponse.body.getReader(),
      providerResponse.headers.get("Content-Type") ?? "text/event-stream"
    );
  }

  /**
   * Workers AI proxy: call the AI binding directly, buffer the SSE stream.
   * The caller passes the model name via X-AI-Model and the inputs as the
   * request body. This DO has its own AI binding, so no API token is needed.
   */
  private async _handleWorkersAIProxy(request: Request): Promise<Response> {
    const model = request.headers.get("X-AI-Model");
    if (!model) {
      return Response.json(
        { error: "Missing X-AI-Model header" },
        { status: 400 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    let stream: ReadableStream<Uint8Array>;
    try {
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- model name comes from caller
      const result = await (this.env.AI.run as any)(model, {
        ...body,
        stream: true
      });

      if (result instanceof ReadableStream) {
        stream = result;
      } else {
        // Model returned a non-streaming response — wrap it
        const text = JSON.stringify(result);
        stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`data: ${text}\n\ndata: [DONE]\n\n`)
            );
            controller.close();
          }
        });
      }
    } catch (e) {
      return Response.json({ error: `AI.run failed: ${e}` }, { status: 502 });
    }

    console.log(`[buffer] proxy → workers-ai/${model}`);

    return this._startBuffering(stream.getReader(), "text/event-stream");
  }

  /**
   * Shared: reset state, start background consumer, return tail stream.
   */
  private _startBuffering(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    contentType: string
  ): Response {
    this.ctx.storage.sql.exec("DELETE FROM buffer_chunks");
    this._status = "streaming";
    this._chunkCount = 0;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO buffer_meta (id, status, created_at) VALUES (1, 'streaming', ?)",
      Date.now()
    );

    // Consume the provider stream in the background. This is the key
    // architectural trick: ctx.waitUntil keeps this DO alive even after
    // the caller's response stream is cancelled (DO evicted). The provider
    // connection lives here, not in the caller.
    this.ctx.waitUntil(this._consumeProvider(reader));

    const stream = this._createTailStream(0);
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        "X-Buffer-Status": "streaming"
      }
    });
  }

  // -- Provider consumer (background) ---------------------------------------

  private async _consumeProvider(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ) {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const data = decoder.decode(value, { stream: true });

        // Sync SQL write + notify happen in the same microtask, so a
        // resume tailer that wakes on _notify() will always see the
        // chunk in SQLite.
        this.ctx.storage.sql.exec(
          "INSERT INTO buffer_chunks (chunk_index, data) VALUES (?, ?)",
          this._chunkCount,
          data
        );
        this._chunkCount++;
        this._notify();
      }

      // Flush any remaining bytes in the decoder's internal buffer
      const trailing = decoder.decode();
      if (trailing) {
        this.ctx.storage.sql.exec(
          "INSERT INTO buffer_chunks (chunk_index, data) VALUES (?, ?)",
          this._chunkCount,
          trailing
        );
        this._chunkCount++;
        this._notify();
      }

      this._status = "completed";
      this.ctx.storage.sql.exec(
        "UPDATE buffer_meta SET status = 'completed' WHERE id = 1"
      );
      console.log(
        `[buffer] provider stream completed, ${this._chunkCount} chunks stored`
      );
    } catch (e) {
      this._status = "error";
      this.ctx.storage.sql.exec(
        "UPDATE buffer_meta SET status = 'error' WHERE id = 1"
      );
      console.error(
        `[buffer] provider stream error after ${this._chunkCount} chunks:`,
        e
      );
    }

    this._notify();

    // Schedule cleanup after TTL (5 minutes)
    await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
  }

  // -- Tail stream ----------------------------------------------------------
  //
  // Creates a ReadableStream that serves chunks from SQLite starting at
  // `fromChunk`, then blocks on the notification signal waiting for new
  // chunks until the provider stream completes. Used by both /proxy (from 0)
  // and /resume (from the caller's last-received index).

  private _createTailStream(fromChunk: number): ReadableStream<Uint8Array> {
    let cursor = fromChunk;
    const encoder = new TextEncoder();
    const self = this;

    return new ReadableStream({
      async pull(controller) {
        const rows = self.ctx.storage.sql
          .exec<{ data: string }>(
            "SELECT data FROM buffer_chunks WHERE chunk_index >= ? ORDER BY chunk_index",
            cursor
          )
          .toArray();

        if (rows.length > 0) {
          for (const row of rows) {
            controller.enqueue(encoder.encode(row.data));
            cursor++;
          }
          return;
        }

        if (self._isTerminal()) {
          controller.close();
          return;
        }

        await self._signal.promise;

        const fresh = self.ctx.storage.sql
          .exec<{ data: string }>(
            "SELECT data FROM buffer_chunks WHERE chunk_index >= ? ORDER BY chunk_index",
            cursor
          )
          .toArray();

        for (const row of fresh) {
          controller.enqueue(encoder.encode(row.data));
          cursor++;
        }

        if (fresh.length === 0 && self._isTerminal()) {
          controller.close();
        }
      },

      cancel() {
        // Caller disconnected (e.g., agent DO evicted). This is expected
        // and harmless — _consumeProvider keeps running via waitUntil.
      }
    });
  }

  private _isTerminal(): boolean {
    return (
      this._status === "completed" ||
      this._status === "error" ||
      this._status === "interrupted"
    );
  }

  // -- Resume ---------------------------------------------------------------

  private _handleResume(fromChunk: number): Response {
    if (this._status === "idle") {
      return Response.json({ error: "No active buffer" }, { status: 404 });
    }

    console.log(
      `[buffer] resume from=${fromChunk}, status=${this._status}, total=${this._chunkCount}`
    );

    const stream = this._createTailStream(fromChunk);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Buffer-Status": this._status
      }
    });
  }

  // -- Drain (snapshot read, no tailing) ------------------------------------
  //
  // Unlike /resume which tails a live stream, /drain reads whatever chunks
  // are currently stored and returns immediately. Used by recovery when
  // the buffer is still streaming and we don't want to block forever.

  private _handleDrain(fromChunk: number): Response {
    if (this._status === "idle") {
      return Response.json({ error: "No active buffer" }, { status: 404 });
    }

    console.log(
      `[buffer] drain from=${fromChunk}, status=${this._status}, total=${this._chunkCount}`
    );

    const rows = this.ctx.storage.sql
      .exec<{ data: string }>(
        "SELECT data FROM buffer_chunks WHERE chunk_index >= ? ORDER BY chunk_index",
        fromChunk
      )
      .toArray();

    const encoder = new TextEncoder();
    const chunks = rows.map((r) => encoder.encode(r.data));
    const body = new Blob(chunks).stream();

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Buffer-Status": this._status,
        "X-Buffer-Chunk-Count": String(this._chunkCount)
      }
    });
  }

  // -- Ack (early cleanup) --------------------------------------------------

  private async _handleAck(): Promise<Response> {
    if (this._status === "streaming") {
      return Response.json(
        { error: "Cannot ack while still streaming" },
        { status: 409 }
      );
    }
    console.log(`[buffer] ack, cleaning up ${this._chunkCount} chunks`);
    this.ctx.storage.sql.exec("DELETE FROM buffer_chunks");
    this.ctx.storage.sql.exec("DELETE FROM buffer_meta");
    this._status = "idle";
    this._chunkCount = 0;
    await this.ctx.storage.deleteAlarm();
    return Response.json({ acknowledged: true });
  }

  // -- Alarm (TTL cleanup) --------------------------------------------------

  override async alarm() {
    if (this._status === "streaming") {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
      return;
    }
    console.log(
      `[buffer] TTL cleanup, status=${this._status}, ${this._chunkCount} chunks`
    );
    this.ctx.storage.sql.exec("DELETE FROM buffer_chunks");
    this.ctx.storage.sql.exec("DELETE FROM buffer_meta");
    this._status = "idle";
    this._chunkCount = 0;
  }
}

// ---------------------------------------------------------------------------
// Worker entry — routes requests to the correct InferenceBuffer DO instance
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ service: "inference-buffer", status: "ok" });
    }

    const bufferId =
      url.searchParams.get("id") ?? request.headers.get("X-Buffer-Id");

    if (!bufferId) {
      return Response.json(
        {
          error:
            "Missing buffer id — pass ?id=<id> query param or X-Buffer-Id header",
          endpoints: {
            proxy:
              "POST /proxy?id=<buffer-id> with X-Provider-URL header and provider request body",
            resume: "GET /resume?id=<buffer-id>&from=<chunk-index>",
            status: "GET /status?id=<buffer-id>",
            ack: "POST /ack?id=<buffer-id>"
          }
        },
        { status: 400 }
      );
    }

    const doId = env.INFERENCE_BUFFER.idFromName(bufferId);
    const stub = env.INFERENCE_BUFFER.get(doId);

    const doUrl = new URL(url.pathname, request.url);
    for (const [key, value] of url.searchParams) {
      if (key !== "id") doUrl.searchParams.set(key, value);
    }

    // "Network connection lost" errors are expected here when the caller
    // (agent DO) is evicted mid-stream. These are benign — the buffer DO's
    // _consumeProvider keeps running via waitUntil regardless.
    return stub.fetch(
      new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body
      })
    );
  }
} satisfies ExportedHandler<Env>;
