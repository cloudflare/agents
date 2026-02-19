import { WorkerEntrypoint } from "cloudflare:workers";
import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import {
  MessageType,
  type WorkspaceInfo,
  type ThreadInfo,
  type ThinkMessage,
  type ClientMessage,
  type ServerMessage
} from "./shared";
import type { ChatFacet } from "./chat";
import type { WorkspaceFacet } from "./workspace";
import { buildSystemPrompt } from "./prompts";

export { Chat } from "./chat";
export { Workspace } from "./workspace";

// ── WorkspaceLoopback ─────────────────────────────────────────────────────────
//
// A WorkerEntrypoint that lets the Chat facet reach a Workspace facet without
// crossing the ThinkAgent RPC boundary during streaming. Follows the same
// pattern as GatekeeperLoopback in the Minions codebase:
//
//   Chat tool execute → WorkspaceLoopback (ServiceStub, clean boundary)
//     → ThinkAgent.getWorkspaceFacet(id) → Workspace facet
//
// The Chat facet gets a ServiceStub to WorkspaceLoopback via ctx.exports.
// ServiceStubs are serializable and create a clean RPC channel, unlike passing
// tool closures that capture RPC stubs (which caused the WritableStream
// disconnect errors).

type WorkspaceLoopbackProps = {
  /** ThinkAgent DO id as a hex string — used to reach back to the parent. */
  agentId: string;
  /** Workspace registry ID — identifies which workspace facet to access. */
  workspaceId: string;
};

export class WorkspaceLoopback extends WorkerEntrypoint<
  Env,
  WorkspaceLoopbackProps
> {
  private _agent: DurableObjectStub<ThinkAgent>;
  private _workspaceId: string;

  constructor(ctx: ExecutionContext<WorkspaceLoopbackProps>, env: Env) {
    super(ctx, env);

    // @ts-expect-error — ctx.exports is experimental
    const ns = ctx.exports.ThinkAgent as DurableObjectNamespace<ThinkAgent>;
    this._agent = ns.get(ns.idFromString(ctx.props.agentId));
    this._workspaceId = ctx.props.workspaceId;
  }

  // Each method calls a corresponding `ws_*` method on ThinkAgent which
  // accesses the facet locally and returns plain data. This avoids passing
  // facet stubs across RPC (they're not serializable across boundaries).

  async readFile(path: string) {
    return this._agent.wsReadFile(this._workspaceId, path);
  }
  async writeFile(path: string, content: string, mimeType?: string) {
    return this._agent.wsWriteFile(this._workspaceId, path, content, mimeType);
  }
  async deleteFile(path: string) {
    return this._agent.wsDeleteFile(this._workspaceId, path);
  }
  async fileExists(path: string) {
    return this._agent.wsFileExists(this._workspaceId, path);
  }
  async stat(path: string) {
    return this._agent.wsStat(this._workspaceId, path);
  }
  async listFiles(dir?: string, options?: { limit?: number; offset?: number }) {
    return this._agent.wsListFiles(this._workspaceId, dir, options);
  }
  async mkdir(path: string, options?: { recursive?: boolean }) {
    return this._agent.wsMkdir(this._workspaceId, path, options);
  }
  async rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
    return this._agent.wsRm(this._workspaceId, path, options);
  }
  async bash(command: string) {
    return this._agent.wsBash(this._workspaceId, command);
  }
  async getInfo() {
    return this._agent.wsGetInfo(this._workspaceId);
  }
}

/** Max bytes returned by READ_FILE to avoid sending huge files over WebSocket. */
const READ_FILE_MAX_BYTES = 100_000; // 100 KB

/**
 * ThinkAgent — the session orchestrator.
 *
 * Owns WebSocket connections to the browser. Maintains a thread registry
 * and workspace registry in its own SQLite. Routes messages to per-thread
 * Chat facets and provides file tools backed by Workspace facets.
 *
 * Chat reaches Workspace via the WorkspaceLoopback entrypoint — a clean
 * RPC channel that avoids the bidirectional streaming conflicts that occur
 * when tool closures are passed across the facet RPC boundary.
 */
export class ThinkAgent extends Agent<Env> {
  /**
   * Threads with an active agent run. Guards against concurrent execution
   * for the same thread, which would clobber Chat's streaming message slot.
   */
  private _runningThreads = new Set<string>();

  /**
   * Threads that have a queued run waiting. Capped at one per thread — if
   * multiple RUN messages arrive while a thread is running, only one follow-up
   * run is needed: it will see all messages that were added in the meantime.
   */
  private _pendingRuns = new Set<string>();

  constructor(ctx: import("agents").AgentContext, env: Env) {
    super(ctx, env);
    this.sql`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this._ensureDefaultWorkspace();
  }

  /** Ensure a "default" workspace always exists for this agent. */
  private _ensureDefaultWorkspace() {
    const exists =
      this.sql<{ cnt: number }>`
        SELECT COUNT(*) AS cnt FROM workspaces WHERE id = 'default'
      `?.[0]?.cnt ?? 0;
    if (exists === 0) {
      this.sql`INSERT INTO workspaces (id, name) VALUES ('default', 'Default')`;
    }
  }

  // ── Facet access ───────────────────────────────────────────────────

  private _thread(threadId: string): ChatFacet {
    // @ts-expect-error — ctx.facets and ctx.exports are experimental
    return this.ctx.facets.get(`thread-${threadId}`, () => ({
      // @ts-expect-error — ctx.exports is experimental
      class: this.ctx.exports.Chat
    })) as ChatFacet;
  }

  private _workspace(workspaceId: string): WorkspaceFacet {
    // @ts-expect-error — ctx.facets and ctx.exports are experimental
    return this.ctx.facets.get(`workspace-${workspaceId}`, () => ({
      // @ts-expect-error — ctx.exports is experimental
      class: this.ctx.exports.Workspace
    })) as WorkspaceFacet;
  }

  // ── Workspace proxy methods (called by WorkspaceLoopback) ─────────
  //
  // Each method accesses the workspace facet locally and returns plain data.
  // Facet stubs can't survive being returned across RPC boundaries, so the
  // loopback calls these methods instead of getting the facet directly.
  // All methods validate workspace ownership before accessing the facet.

  private _ownedWorkspace(workspaceId: string): WorkspaceFacet {
    if (!this._ownsWorkspace(workspaceId)) {
      throw new Error(
        `Workspace ${workspaceId} not found in this agent's registry`
      );
    }
    return this._workspace(workspaceId);
  }

  async wsReadFile(workspaceId: string, path: string) {
    return this._ownedWorkspace(workspaceId).readFile(path);
  }
  async wsWriteFile(
    workspaceId: string,
    path: string,
    content: string,
    mimeType?: string
  ) {
    return this._ownedWorkspace(workspaceId).writeFile(path, content, mimeType);
  }
  async wsDeleteFile(workspaceId: string, path: string) {
    return this._ownedWorkspace(workspaceId).deleteFile(path);
  }
  async wsFileExists(workspaceId: string, path: string) {
    return this._ownedWorkspace(workspaceId).fileExists(path);
  }
  async wsStat(workspaceId: string, path: string) {
    return this._ownedWorkspace(workspaceId).stat(path);
  }
  async wsListFiles(
    workspaceId: string,
    dir?: string,
    options?: { limit?: number; offset?: number }
  ) {
    return this._ownedWorkspace(workspaceId).listFiles(dir, options);
  }
  async wsMkdir(
    workspaceId: string,
    path: string,
    options?: { recursive?: boolean }
  ) {
    return this._ownedWorkspace(workspaceId).mkdir(path, options);
  }
  async wsRm(
    workspaceId: string,
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ) {
    return this._ownedWorkspace(workspaceId).rm(path, options);
  }
  async wsBash(workspaceId: string, command: string) {
    return this._ownedWorkspace(workspaceId).bash(command);
  }
  async wsGetInfo(workspaceId: string) {
    return this._ownedWorkspace(workspaceId).getInfo();
  }

  // ── Thread registry ────────────────────────────────────────────────

  private _listThreads(): ThreadInfo[] {
    return (
      this.sql<{
        id: string;
        name: string;
        workspace_id: string | null;
        created_at: string;
        last_active_at: string;
      }>`
        SELECT id, name, workspace_id,
          created_at, last_active_at
        FROM threads
        ORDER BY last_active_at DESC
      `?.map((r) => ({
        id: r.id,
        name: r.name,
        workspaceId: r.workspace_id,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at
      })) ?? []
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
        INSERT INTO threads (id, name, workspace_id)
        VALUES (${threadId}, ${threadId}, 'default')
      `;
    }
  }

  createThread(name?: string): ThreadInfo {
    const id = crypto.randomUUID().slice(0, 8);
    const threadName = name || `Thread ${id}`;
    this
      .sql`INSERT INTO threads (id, name, workspace_id) VALUES (${id}, ${threadName}, 'default')`;
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

  // ── Workspace registry ───────────────────────────────────────────────

  private _listWorkspaces(): WorkspaceInfo[] {
    return (
      this.sql<{ id: string; name: string; created_at: string }>`
        SELECT id, name, created_at FROM workspaces ORDER BY created_at DESC
      `?.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at
      })) ?? []
    );
  }

  createWorkspace(name?: string): WorkspaceInfo {
    const id = crypto.randomUUID().slice(0, 8);
    const workspaceName = name || `Workspace ${id}`;
    this
      .sql`INSERT INTO workspaces (id, name) VALUES (${id}, ${workspaceName})`;
    return this._listWorkspaces().find((s) => s.id === id)!;
  }

  deleteWorkspace(workspaceId: string): void {
    this.sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    // detach from all threads
    this
      .sql`UPDATE threads SET workspace_id = NULL WHERE workspace_id = ${workspaceId}`;
    // @ts-expect-error — ctx.facets.delete is experimental
    this.ctx.facets.delete(`workspace-${workspaceId}`);
  }

  renameWorkspace(workspaceId: string, name: string): void {
    this.sql`UPDATE workspaces SET name = ${name} WHERE id = ${workspaceId}`;
  }

  getWorkspaces(): WorkspaceInfo[] {
    return this._listWorkspaces();
  }

  attachWorkspace(threadId: string, workspaceId: string): void {
    this._ensureThread(threadId);
    this
      .sql`UPDATE threads SET workspace_id = ${workspaceId} WHERE id = ${threadId}`;
  }

  detachWorkspace(threadId: string): void {
    this.sql`UPDATE threads SET workspace_id = NULL WHERE id = ${threadId}`;
  }

  private _getThreadWorkspaceId(threadId: string): string | null {
    return (
      this.sql<{ workspace_id: string | null }>`
        SELECT workspace_id FROM threads WHERE id = ${threadId}
      `?.[0]?.workspace_id ?? null
    );
  }

  // ── WebSocket transport ────────────────────────────────────────────

  override async onConnect(connection: Connection) {
    connection.send(
      JSON.stringify({
        type: MessageType.THREADS,
        threads: this._listThreads()
      })
    );
    connection.send(
      JSON.stringify({
        type: MessageType.WORKSPACES,
        workspaces: this._listWorkspaces()
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

      // ── Workspace management ─────────────────────────────────────

      case MessageType.CREATE_WORKSPACE: {
        this.createWorkspace(data.name);
        this._broadcastWorkspaces();
        break;
      }

      case MessageType.DELETE_WORKSPACE: {
        this.deleteWorkspace(data.workspaceId);
        this._broadcastWorkspaces();
        this._broadcastThreads(); // workspace_id may have changed
        break;
      }

      case MessageType.RENAME_WORKSPACE: {
        this.renameWorkspace(data.workspaceId, data.name);
        this._broadcastWorkspaces();
        break;
      }

      case MessageType.ATTACH_WORKSPACE: {
        this.attachWorkspace(data.threadId, data.workspaceId);
        this._broadcastThreads();
        break;
      }

      case MessageType.DETACH_WORKSPACE: {
        this.detachWorkspace(data.threadId);
        this._broadcastThreads();
        break;
      }

      // ── File browser ──────────────────────────────────────────────

      case MessageType.LIST_FILES: {
        // Ownership check: only allow access to workspaces that belong
        // to this ThinkAgent instance.
        if (!this._ownsWorkspace(data.workspaceId)) break;
        const entries = await this._workspace(data.workspaceId).listFiles(
          data.dir
        );
        this._sendTo(connection, {
          type: MessageType.FILE_LIST,
          workspaceId: data.workspaceId,
          dir: data.dir,
          entries
        });
        break;
      }

      case MessageType.READ_FILE: {
        if (!this._ownsWorkspace(data.workspaceId)) break;
        const raw = await this._workspace(data.workspaceId).readFile(data.path);
        // Truncate oversized files so we don't send MBs over WebSocket.
        let content = raw;
        if (raw && raw.length > READ_FILE_MAX_BYTES) {
          content =
            raw.slice(0, READ_FILE_MAX_BYTES) +
            `\n\n… [truncated — showing first ${(READ_FILE_MAX_BYTES / 1024).toFixed(0)} KB of ${(raw.length / 1024).toFixed(1)} KB]`;
        }
        this._sendTo(connection, {
          type: MessageType.FILE_CONTENT,
          workspaceId: data.workspaceId,
          path: data.path,
          content
        });
        break;
      }

      // ── Agent loop ─────────────────────────────────────────────

      case MessageType.RUN: {
        if (!data.threadId) return;
        this._ensureThread(data.threadId);
        const threadId = data.threadId;

        if (this._runningThreads.has(threadId)) {
          // A run is already in progress. Queue one follow-up run so the agent
          // processes any messages that arrived during the current run. We cap
          // the queue at one entry — running again after the current run will
          // see all messages that were added, regardless of how many RUN
          // messages arrived while it was busy.
          if (!this._pendingRuns.has(threadId)) {
            this._pendingRuns.add(threadId);
            console.log(`[ThinkAgent] RUN queued for thread=${threadId}`);
          } else {
            console.log(
              `[ThinkAgent] RUN already queued for thread=${threadId}, ignoring`
            );
          }
          break;
        }

        await this._executeRun(threadId);
        break;
      }
    }
  }

  /**
   * Execute a single agent run for the given thread, then process any queued
   * run that arrived while this one was in flight.
   *
   * Callers must NOT hold the `_runningThreads` lock before calling this —
   * `_executeRun` acquires and releases it itself.
   */
  private async _executeRun(threadId: string): Promise<void> {
    this._runningThreads.add(threadId);
    console.log(`[ThinkAgent] RUN thread=${threadId}`);

    // Build system prompt injecting a live workspace snapshot.
    // Best-effort: if the snapshot fails (e.g. workspace not yet initialized)
    // the agent runs without the directory listing but is otherwise functional.
    const workspaceId = this._getThreadWorkspaceId(threadId);
    let workspaceSnapshot = null;
    if (workspaceId) {
      try {
        workspaceSnapshot = await this._workspace(workspaceId).listFiles("/");
      } catch (err) {
        console.error(`[ThinkAgent] workspace snapshot failed:`, err);
      }
    }

    const system = buildSystemPrompt(workspaceSnapshot);

    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();

    // Pass workspaceId and the parent agent's DO id as plain strings.
    // Chat uses ctx.exports.WorkspaceLoopback to reach the workspace facet
    // via a clean ServiceStub boundary — no bi-directional RPC.
    const streamDone = this._thread(threadId).streamInto(writable, {
      system,
      workspaceId: workspaceId ?? undefined,
      agentId: this.ctx.id.toString(),
      maxSteps: 10
    });

    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let textDeltas = 0;
    let reasoningDeltas = 0;
    let toolCallCount = 0;
    let buf = "";
    let streamErr: unknown;

    const flushLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const chunk = JSON.parse(line) as
          | { t: "text"; d: string }
          | { t: "think"; d: string }
          | { t: "tool"; n: string; a: Record<string, unknown> };

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
        } else if (chunk.t === "tool") {
          toolCallCount++;
          this._broadcastAll({
            type: MessageType.TOOL_CALL,
            threadId,
            toolName: chunk.n,
            args: chunk.a
          });
        }
      } catch {
        // skip malformed NDJSON line
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) flushLine(line);
      }
      flushLine(buf);
      buf = "";
      console.log(
        `[ThinkAgent] stream done: ${textDeltas} text, ${reasoningDeltas} reasoning, ${toolCallCount} tool calls`
      );
    } catch (err) {
      console.error(`[ThinkAgent] stream read error:`, err);
      streamErr = err;
      flushLine(buf);
      buf = "";
    } finally {
      reader.releaseLock();
    }

    try {
      await streamDone;
    } catch (err) {
      if (!streamErr) console.error(`[ThinkAgent] streamDone error:`, err);
    }

    // Release the lock before broadcasting so clients see a consistent state.
    this._runningThreads.delete(threadId);
    this._broadcastAll({ type: MessageType.STREAM_END, threadId });
    this._touchThread(threadId);
    const updatedMessages = await this._thread(threadId).getMessages();
    this._broadcastSync(threadId, updatedMessages);
    this._broadcastThreads();

    // If another RUN arrived while we were busy, execute it now.
    // We re-derive all state (tools, system prompt, messages) from scratch so
    // the follow-up run picks up any messages or workspace changes that occurred
    // during the run that just completed.
    if (this._pendingRuns.has(threadId)) {
      this._pendingRuns.delete(threadId);
      console.log(`[ThinkAgent] running queued RUN for thread=${threadId}`);
      await this._executeRun(threadId);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Returns true if `workspaceId` exists in this agent's workspace registry.
   * Used to prevent cross-agent workspace access via forged client messages.
   */
  private _ownsWorkspace(workspaceId: string): boolean {
    const found =
      this.sql<{ cnt: number }>`
        SELECT COUNT(*) AS cnt FROM workspaces WHERE id = ${workspaceId}
      `?.[0]?.cnt ?? 0;
    return found > 0;
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

  private _broadcastWorkspaces(exclude?: string[]) {
    this.broadcast(
      JSON.stringify({
        type: MessageType.WORKSPACES,
        workspaces: this._listWorkspaces()
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
