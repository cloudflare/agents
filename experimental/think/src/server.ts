import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import {
  MessageType,
  type ThreadInfo,
  type ThinkMessage,
  type ClientMessage,
  type ServerMessage
} from "./shared";
import type { ChatFacet } from "./chat";

export { Chat } from "./chat";

/**
 * ThinkAgent — the orchestrator.
 *
 * Owns WebSocket connections to the browser. Maintains a thread
 * registry in its own SQLite and routes messages to per-thread
 * Chat facets, each with isolated SQLite for message history.
 */
export class ThinkAgent extends Agent<Env> {
  constructor(ctx: import("agents").AgentContext, env: Env) {
    super(ctx, env);
    this.sql`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
  }

  // ── Facet access ───────────────────────────────────────────────────

  private _thread(threadId: string): ChatFacet {
    // @ts-expect-error — ctx.facets and ctx.exports are experimental
    return this.ctx.facets.get(`thread-${threadId}`, () => ({
      // @ts-expect-error — ctx.exports is experimental
      class: this.ctx.exports.Chat
    })) as ChatFacet;
  }

  // ── Thread registry (parent's own SQLite) ──────────────────────────

  private _listThreads(): ThreadInfo[] {
    return (
      this.sql<ThreadInfo>`
        SELECT id, name,
          created_at AS createdAt,
          last_active_at AS lastActiveAt
        FROM threads
        ORDER BY last_active_at DESC
      ` ?? []
    );
  }

  private _touchThread(threadId: string) {
    this.sql`
      UPDATE threads SET last_active_at = CURRENT_TIMESTAMP
      WHERE id = ${threadId}
    `;
  }

  private _ensureThread(threadId: string) {
    const exists =
      this.sql<{ cnt: number }>`
        SELECT COUNT(*) AS cnt FROM threads WHERE id = ${threadId}
      `?.[0]?.cnt ?? 0;

    if (exists === 0) {
      this.sql`
        INSERT INTO threads (id, name) VALUES (${threadId}, ${threadId})
      `;
    }
  }

  createThread(name?: string): ThreadInfo {
    const id = crypto.randomUUID().slice(0, 8);
    const threadName = name || `Thread ${id}`;
    this.sql`INSERT INTO threads (id, name) VALUES (${id}, ${threadName})`;
    return this._listThreads().find((t) => t.id === id)!;
  }

  deleteThread(threadId: string): void {
    this.sql`DELETE FROM threads WHERE id = ${threadId}`;
    // @ts-expect-error — ctx.facets.delete is experimental
    this.ctx.facets.delete(`thread-${threadId}`);
  }

  renameThread(threadId: string, name: string): void {
    this.sql`UPDATE threads SET name = ${name} WHERE id = ${threadId}`;
  }

  getThreads(): ThreadInfo[] {
    return this._listThreads();
  }

  // ── WebSocket transport ────────────────────────────────────────────

  override async onConnect(connection: Connection) {
    connection.send(
      JSON.stringify({
        type: MessageType.THREADS,
        threads: this._listThreads()
      })
    );
  }

  override async onMessage(connection: Connection, raw: WSMessage) {
    if (typeof raw !== "string") return;

    let data: ClientMessage<ThinkMessage>;
    try {
      data = JSON.parse(raw) as ClientMessage<ThinkMessage>;
    } catch {
      return;
    }

    switch (data.type) {
      case MessageType.ADD: {
        if (!data.threadId) return;
        this._ensureThread(data.threadId);
        const messages = await this._thread(data.threadId).addMessage(
          data.message
        );
        this._touchThread(data.threadId);
        this._broadcastSync(data.threadId, messages, [connection.id]);
        this._broadcastThreads();
        break;
      }

      case MessageType.DELETE: {
        if (!data.threadId) return;
        const messages = await this._thread(data.threadId).deleteMessage(
          data.id
        );
        this._broadcastSync(data.threadId, messages);
        break;
      }

      case MessageType.CLEAR_REQUEST: {
        if (!data.threadId) return;
        await this._thread(data.threadId).clearMessages();
        this._broadcastAll({
          type: MessageType.CLEAR,
          threadId: data.threadId
        });
        break;
      }

      case MessageType.CREATE_THREAD: {
        this.createThread(data.name);
        this._broadcastThreads();
        break;
      }

      case MessageType.DELETE_THREAD: {
        this.deleteThread(data.threadId);
        this._broadcastThreads();
        break;
      }

      case MessageType.RENAME_THREAD: {
        this.renameThread(data.threadId, data.name);
        this._broadcastThreads();
        break;
      }

      case MessageType.GET_MESSAGES: {
        if (!data.threadId) return;
        const messages = await this._thread(data.threadId).getMessages();
        this._sendTo(connection, {
          type: MessageType.SYNC,
          threadId: data.threadId,
          messages
        });
        break;
      }

      case MessageType.RUN: {
        if (!data.threadId) return;
        this._ensureThread(data.threadId);
        const threadId = data.threadId;
        console.log(`[ThinkAgent] RUN thread=${threadId}`);

        // ThinkAgent owns the TransformStream — creates writable + readable,
        // passes writable to Chat (which writes chunks into it), reads
        // readable and broadcasts deltas. The RPC call stays alive while
        // Chat writes, then resolves when Chat finishes and persists.
        // Workers RPC serializes streams as byte streams, so we use
        // Uint8Array and TextDecoder around the RPC boundary.
        const { readable, writable } = new TransformStream<
          Uint8Array,
          Uint8Array
        >();

        // Start the Chat stream (don't await — we read concurrently)
        const streamDone = this._thread(threadId).streamInto(writable, {
          system: "You are a helpful coding assistant. Be concise and helpful.",
          maxSteps: 5
        });

        // Read NDJSON byte chunks, decode, parse, broadcast appropriately.
        // Each line is {"t":"text","d":"..."} or {"t":"think","d":"..."}.
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        let textDeltas = 0;
        let reasoningDeltas = 0;
        // oxlint-disable-next-line prefer-const
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const chunk = JSON.parse(line) as {
                  t: "text" | "think";
                  d: string;
                };
                if (chunk.t === "text") {
                  textDeltas++;
                  this._broadcastAll({
                    type: MessageType.STREAM_DELTA,
                    threadId,
                    delta: chunk.d
                  });
                } else if (chunk.t === "think") {
                  reasoningDeltas++;
                  this._broadcastAll({
                    type: MessageType.REASONING_DELTA,
                    threadId,
                    delta: chunk.d
                  });
                }
              } catch {
                // skip malformed lines
              }
            }
          }
          // flush remaining buffer
          if (buf.trim()) {
            try {
              const chunk = JSON.parse(buf) as {
                t: "text" | "think";
                d: string;
              };
              if (chunk.t === "text") {
                textDeltas++;
                this._broadcastAll({
                  type: MessageType.STREAM_DELTA,
                  threadId,
                  delta: chunk.d
                });
              } else if (chunk.t === "think") {
                reasoningDeltas++;
                this._broadcastAll({
                  type: MessageType.REASONING_DELTA,
                  threadId,
                  delta: chunk.d
                });
              }
            } catch {
              /* ignore */
            }
          }
          console.log(
            `[ThinkAgent] stream done: ${textDeltas} text, ${reasoningDeltas} reasoning deltas`
          );
        } catch (err) {
          console.error(`[ThinkAgent] stream read error:`, err);
        } finally {
          reader.releaseLock();
        }

        // Wait for Chat to finish persisting
        await streamDone;

        this._broadcastAll({
          type: MessageType.STREAM_END,
          threadId
        });

        this._touchThread(threadId);
        const updatedMessages = await this._thread(threadId).getMessages();
        this._broadcastSync(threadId, updatedMessages);
        this._broadcastThreads();
        break;
      }
    }
  }

  // ── Broadcast helpers ──────────────────────────────────────────────

  private _broadcastThreads(exclude?: string[]) {
    this.broadcast(
      JSON.stringify({
        type: MessageType.THREADS,
        threads: this._listThreads()
      }),
      exclude
    );
  }

  private _broadcastSync(
    threadId: string,
    messages: ThinkMessage[],
    exclude?: string[]
  ) {
    const payload: ServerMessage<ThinkMessage> = {
      type: MessageType.SYNC,
      threadId,
      messages
    };
    this.broadcast(JSON.stringify(payload), exclude);
  }

  private _broadcastAll(message: ServerMessage<ThinkMessage>) {
    this.broadcast(JSON.stringify(message));
  }

  private _sendTo(
    connection: Connection,
    message: ServerMessage<ThinkMessage>
  ) {
    connection.send(JSON.stringify(message));
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
