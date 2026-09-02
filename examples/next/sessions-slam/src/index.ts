import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import {
  Sessions,
  attachmentResponse,
  attachmentUrl,
  type ReconstructMode,
  type SessionMessage,
  type SessionMessagePart
} from "agents/sessions";

const MIB = 1024 * 1024;
const POINTER_PREFIX = "attachment:sha256:";
const FILLER = "The quick brown fox jumps over the lazy dog. ";

const USAGE = `agents-sessions-slam

Routes are scoped per named Durable Object: /<sessionName>/<route>

  POST /upload?bytes=N&declared=true|false&mediaType=..&filename=..  (body = payload)
  POST /append?count=N&textBytes=M&file=<hash>
  POST /append-large?bytes=M
  POST /append-tool?bytes=M
  GET  /hydrate?budget=B&minRecent=K&mode=inline|pointer
  GET  /history?mode=inline|pointer                                  (NDJSON)
  GET  /attachment/<hash>
  POST /fork
  POST /compact
  POST /clear
  GET  /stats
`;

/**
 * Sums `rowsWritten` over every cursor returned by `sql.exec`.
 *
 * Installed on the SqlStorage object before Lifecycle so capability and
 * migration writes are counted too. `rowsWritten` is a live getter, so a
 * cursor is retained until later statements have run (by which time it has
 * been consumed) and only then folded into the settled total.
 */
class RowsWrittenCounter {
  readonly installed: boolean;
  #settled = 0;
  #pending: { rowsWritten: number }[] = [];

  constructor(sql: SqlStorage) {
    const exec = sql.exec.bind(sql);
    const wrapped = (query: string, ...bindings: unknown[]) => {
      if (this.#pending.length >= 32) this.#drain(8);
      const cursor = exec(query, ...bindings);
      this.#pending.push(cursor);
      return cursor;
    };
    Object.defineProperty(sql, "exec", {
      value: wrapped,
      configurable: true,
      writable: true
    });
    this.installed = sql.exec === wrapped;
  }

  #drain(keep: number): void {
    const settle = this.#pending.length - keep;
    if (settle <= 0) return;
    for (const cursor of this.#pending.splice(0, settle)) {
      this.#settled += cursor.rowsWritten;
    }
  }

  /** Rows written since the object was constructed. */
  total(): number {
    this.#drain(0);
    return this.#settled;
  }
}

/** Deterministic ASCII text of exactly `bytes` bytes, starting with `header`. */
function fillerText(bytes: number, header: string): string {
  const body = bytes - header.length;
  if (body <= 0) return header;
  return header + FILLER.repeat(Math.ceil(body / FILLER.length)).slice(0, body);
}

function isPointer(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(POINTER_PREFIX);
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new SlamRequestError(`bad ${name}`);
  return Math.floor(value);
}

function modeParam(url: URL): ReconstructMode {
  const mode = url.searchParams.get("mode") ?? "inline";
  if (mode !== "inline" && mode !== "pointer") {
    throw new SlamRequestError("mode must be inline or pointer");
  }
  return mode;
}

class SlamRequestError extends Error {
  readonly status = 400;
}

function ndjsonResponse(
  history: AsyncGenerator<SessionMessage, void, undefined>,
  summary: (count: number) => Record<string, unknown>
): Response {
  const encoder = new TextEncoder();
  let count = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await history.next();
          if (next.done) {
            controller.enqueue(
              encoder.encode(`${JSON.stringify(summary(count))}\n`)
            );
            controller.close();
            return;
          }
          count++;
          controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await history.return();
      }
    }),
    { headers: { "content-type": "application/x-ndjson" } }
  );
}

/**
 * One slam target: a plain Durable Object whose only capability is Sessions
 * with a real R2 tier. Every route reports its own duration and the billed
 * SQLite rows it wrote.
 */
export class SlamSession extends DurableObject<Env> {
  // Field order matters: the counter wraps `sql.exec` before Lifecycle and
  // Sessions capture the SqlStorage object.
  readonly #rows = new RowsWrittenCounter(this.ctx.storage.sql);

  readonly sessions = new Sessions({
    attachments: {
      r2: this.env.ATTACHMENTS,
      maxAttachmentBytes: 64 * MIB
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.sessions);

  readonly session = this.sessions.session().onCompaction(async (messages) => {
    // Keep the two most recent messages; summarize everything before them.
    if (messages.length < 3) return null;
    return {
      fromMessageId: messages[0].id,
      toMessageId: messages[messages.length - 3].id,
      summary: "Slam compaction: earlier messages replaced by this summary."
    };
  });

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // /<sessionName>/<route...> — the Worker keeps the session prefix.
    const [, , ...rest] = url.pathname.split("/");
    const route = `/${rest.join("/")}`;
    const method = request.method;

    const attachment = route.match(/^\/attachment\/([0-9a-f]{64})$/);
    if (method === "GET" && attachment) {
      return attachmentResponse(this.sessions, attachment[1]);
    }
    if (method === "GET" && route === "/history") {
      return this.#history(modeParam(url));
    }

    const rowsBefore = this.#rows.total();
    const started = performance.now();
    try {
      const result = await this.#dispatch(method, route, url, request);
      if (!result) return new Response(USAGE, { status: 404 });
      return Response.json({
        ms: Math.round(performance.now() - started),
        rowsWritten: this.#rows.total() - rowsBefore,
        ...result
      });
    } catch (error) {
      const status = error instanceof SlamRequestError ? error.status : 500;
      return Response.json(
        {
          ms: Math.round(performance.now() - started),
          rowsWritten: this.#rows.total() - rowsBefore,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error)
          }
        },
        { status }
      );
    }
  }

  async #dispatch(
    method: string,
    route: string,
    url: URL,
    request: Request
  ): Promise<Record<string, unknown> | null> {
    if (method === "POST" && route === "/upload") {
      return this.#upload(url, request);
    }
    if (method === "POST" && route === "/append") return this.#append(url);
    if (method === "POST" && route === "/append-large") {
      return this.#appendLarge(url);
    }
    if (method === "POST" && route === "/append-tool") {
      return this.#appendTool(url);
    }
    if (method === "GET" && route === "/hydrate") return this.#hydrate(url);
    if (method === "POST" && route === "/fork") return this.#fork();
    if (method === "POST" && route === "/compact") return this.#compact();
    if (method === "POST" && route === "/clear") {
      await this.session.clearMessages();
      return { cleared: true, stats: await this.session.stats() };
    }
    if (method === "GET" && route === "/stats") return this.#stats();
    return null;
  }

  // ── Uploads ──────────────────────────────────────────────────────────────

  async #upload(url: URL, request: Request): Promise<Record<string, unknown>> {
    if (!request.body) throw new SlamRequestError("missing body");
    const bytes = intParam(url, "bytes", 0);
    const declared = url.searchParams.get("declared") === "true";
    const mediaType =
      url.searchParams.get("mediaType") ??
      request.headers.get("content-type") ??
      "application/octet-stream";
    const filename = url.searchParams.get("filename");
    const { part, attachment } = await this.sessions.attachments.put(
      request.body,
      {
        mediaType,
        ...(filename ? { filename } : {}),
        ...(declared ? { bytes } : {})
      }
    );
    return {
      declared,
      part,
      ...("backend" in attachment ? { backend: attachment.backend } : {}),
      attachment
    };
  }

  // ── Appends ──────────────────────────────────────────────────────────────

  async #append(url: URL): Promise<Record<string, unknown>> {
    const count = intParam(url, "count", 1);
    const textBytes = intParam(url, "textBytes", 0);
    const file = url.searchParams.get("file");
    let filePart: SessionMessagePart | undefined;
    if (file) {
      const stored = await this.sessions.attachments.get(file);
      if (!stored) throw new SlamRequestError(`unknown attachment ${file}`);
      filePart = {
        type: "file",
        mediaType: stored.mediaType,
        ...(stored.filename ? { filename: stored.filename } : {}),
        url: attachmentUrl(stored.hash)
      };
    }
    const batch = crypto.randomUUID();
    let firstId = "";
    let lastId = "";
    for (let i = 0; i < count; i++) {
      const id = `${batch}-${i}`;
      if (i === 0) firstId = id;
      lastId = id;
      const parts: SessionMessagePart[] = [
        { type: "text", text: fillerText(textBytes, `${batch}:${i}:`) }
      ];
      if (filePart) parts.push(filePart);
      await this.session.appendMessage({
        id,
        role: i % 2 === 0 ? "user" : "assistant",
        parts
      });
    }
    return {
      appended: count,
      firstId,
      lastId,
      ...(filePart ? { file: filePart.url } : {}),
      stats: await this.session.stats()
    };
  }

  async #appendLarge(url: URL): Promise<Record<string, unknown>> {
    const bytes = intParam(url, "bytes", MIB);
    const id = crypto.randomUUID();
    const result = await this.session.appendMessage({
      id,
      role: "user",
      parts: [{ type: "text", text: fillerText(bytes, `${id}:`) }]
    });
    const stored = result.message.parts[0];
    return {
      requestedBytes: bytes,
      shape: isPointer(stored.text) ? "pointer" : "inline",
      storedPart: isPointer(stored.text) ? stored : { type: stored.type },
      storedPartBytes: JSON.stringify(stored).length,
      ...this.#rowShape(result.attachments, id)
    };
  }

  async #appendTool(url: URL): Promise<Record<string, unknown>> {
    const bytes = intParam(url, "bytes", MIB);
    const id = crypto.randomUUID();
    const toolCallId = `call-${id}`;
    const result = await this.session.appendMessage({
      id,
      role: "assistant",
      parts: [
        {
          type: "tool-echo",
          state: "output-available",
          toolCallId,
          input: { echo: true, bytes },
          output: { text: fillerText(bytes, `${id}:`) }
        }
      ]
    });
    const stored = result.message.parts[0];
    const output =
      typeof stored.output === "object" && stored.output !== null
        ? (stored.output as { text?: unknown })
        : {};
    return {
      requestedBytes: bytes,
      shape: isPointer(output.text) ? "pointer" : "inline",
      storedOutput: isPointer(output.text)
        ? output
        : { keys: Object.keys(output) },
      storedPartBytes: JSON.stringify(stored).length,
      ...this.#rowShape(result.attachments, id)
    };
  }

  #rowShape(
    attachments: { hash: string; bytes: number }[],
    messageId: string
  ): Record<string, unknown> {
    // Content-free: one row from the stored path stats.
    const row = this.ctx.storage.sql
      .exec<{ bytes: number }>(
        "SELECT length(content) AS bytes FROM cf_agents_session_messages WHERE session_id = ? AND id = ?",
        this.session.sessionId,
        messageId
      )
      .toArray()[0];
    return {
      rowBytes: row ? Number(row.bytes) : null,
      attachments: attachments.map((a) => ({ hash: a.hash, bytes: a.bytes }))
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async #hydrate(url: URL): Promise<Record<string, unknown>> {
    const budget = intParam(url, "budget", 32 * MIB);
    const minRecent = intParam(url, "minRecent", 1);
    const mode = modeParam(url);
    const result = await this.session.getRecentHistory(budget, minRecent, {
      reconstruct: mode
    });
    // Summed per message so the measurement never builds a second copy of
    // the whole window as one string.
    let hydratedBytes = 0;
    for (const message of result.messages) {
      hydratedBytes += JSON.stringify(message).length;
    }
    return {
      mode,
      budget,
      minRecent,
      messages: result.messages.length,
      truncated: result.truncated,
      totalContentBytes: result.totalContentBytes,
      hydratedBytes
    };
  }

  #history(mode: ReconstructMode): Response {
    const rowsBefore = this.#rows.total();
    const started = performance.now();
    return ndjsonResponse(this.session.history({ reconstruct: mode }), (n) => ({
      done: true,
      mode,
      messages: n,
      ms: Math.round(performance.now() - started),
      rowsWritten: this.#rows.total() - rowsBefore
    }));
  }

  // ── Tree and overlays ────────────────────────────────────────────────────

  async #fork(): Promise<Record<string, unknown>> {
    const fork = await this.session.fork({
      toSessionId: `fork-${Date.now().toString(36)}`
    });
    return {
      ...fork,
      forkStats: await this.sessions.session(fork.sessionId).stats()
    };
  }

  async #compact(): Promise<Record<string, unknown>> {
    const result = await this.session.compact();
    return {
      compacted: result !== null,
      ...(result
        ? {
            fromMessageId: result.fromMessageId,
            toMessageId: result.toMessageId
          }
        : {}),
      stats: await this.session.stats()
    };
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  async #stats(): Promise<Record<string, unknown>> {
    return {
      stats: await this.session.stats(),
      databaseSize: this.ctx.storage.sql.databaseSize,
      tables: {
        messages: this.#count("cf_agents_session_messages"),
        attachments: this.#count("cf_agents_session_attachments"),
        blobs: this.#count("cf_agents_session_attachment_blobs"),
        chunks: this.#count("cf_agents_session_attachment_chunks")
      },
      rowsWrittenTotal: this.#rows.total(),
      rowsWrittenTracked: this.#rows.installed
    };
  }

  /** Row count for one table, or null when the table does not exist yet. */
  #count(table: string): number | null {
    const sql = this.ctx.storage.sql;
    const exists = sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        table
      )
      .toArray().length;
    if (!exists) return null;
    return Number(sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, sessionName] = new URL(request.url).pathname.split("/");
    if (!sessionName) return new Response(USAGE, { status: 404 });
    const stub = env.SLAM.get(env.SLAM.idFromName(sessionName));
    return stub.fetch(request);
  }
} satisfies ExportedHandler<Env>;
