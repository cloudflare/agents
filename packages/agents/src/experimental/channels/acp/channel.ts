import type {
  Connection,
  ConnectionContext,
  WSMessage
} from "../../../lifecycle";
import {
  getConnectionFlag,
  registerInternalConnectionKeys,
  setConnectionFlag
} from "../../../websockets/connection-flags";
import { WebSockets } from "../../../websockets";
import type {
  ChannelsHost,
  ConversationChannel,
  ConversationUpdate
} from "../conversations";
import type {
  EventOrigin,
  Json,
  MessagePart,
  Participant,
  ResponseChunk,
  ToolPart,
  TranscriptMessage,
  TurnStatus
} from "../protocol";
import { WEB_IDENTITY_HEADER, type WebIdentity } from "../web/protocol";
import {
  ACP_PROTOCOL_VERSION,
  failure,
  isRecord,
  isRequest,
  parseRpcMessage,
  result,
  RpcError,
  type AgentInfo,
  type ContentBlock,
  type InitializeResponse,
  type RequestPermissionParams,
  type RpcId,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
  type SessionInfo,
  type SessionUpdate,
  type ToolCallStatus
} from "./protocol";

/** Where an ACP connection's identity lives in its connection state. */
const IDENTITY_KEY = "_cf_channels_acp";
registerInternalConnectionKeys(IDENTITY_KEY);

const ALLOW = "allow";
const REJECT = "reject";

export type AcpChannelOptions = {
  /**
   * The connections to serve ACP on, for an agent sharing its own.
   * Default: the WebSockets Channels shares, created on first use.
   */
  websockets?: WebSockets;
  /** What `initialize` reports as `agentInfo`. */
  agentInfo?: AgentInfo;
};

/** One ACP connection: who it is, and the sessions it follows. */
type Identity = {
  channelKey: string;
  participant: Participant;
  sessions: string[];
};

/** A `session/prompt` waiting for its turn to settle. */
type PendingPrompt = { turnId: string; connectionId: string; rpcId: RpcId };

/** A `session/request_permission` waiting for the client's answer. */
type PendingPermission = {
  rpcId: string;
  connectionId: string;
  turnId: string;
  approvalId: string;
};

/** What the channel keeps about one session, in the agent's storage. */
type SessionRecord = {
  cwd?: string;
  prompts: PendingPrompt[];
  permissions: PendingPermission[];
};

/** One response being forwarded to one connection. */
type Read = { controller: AbortController; done: Promise<void> };

/**
 * Serves conversations to Agent Client Protocol clients, such as Zed or T3
 * Code, over the agent's WebSockets connections. Each text frame is one
 * JSON-RPC message. An ACP session is a Channels conversation (a harness
 * session) with the same id, and a `session/prompt` is a turn: it is
 * answered with a stop reason when the turn settles.
 *
 * The gateway's `acp()` Channel takes the upgrades and resolves who is
 * connecting. Mount this channel under the same key: the gateway names it
 * in the connection identity (`channel`), and other connections are left
 * to the agent's other channels.
 *
 * Speaks stable ACP v1 (`protocolVersion: 1`): `session/new`, `load`,
 * `resume`, `list`, `close` and `fork`, prompts of text and embedded or
 * linked resources, and permissions for tool approvals. Client file system,
 * terminals and MCP servers are not used: the agent runs in a Worker, not
 * beside the client.
 */
export class AcpChannel implements ConversationChannel {
  readonly #options: AcpChannelOptions;
  #websockets: WebSockets | undefined;
  #host: ChannelsHost | undefined;
  /** Responses being forwarded, by connection, then response. */
  readonly #reads = new Map<string, Map<string, Read>>();
  /** Responses already forwarded, by connection, so none is sent twice. */
  readonly #ended = new Map<string, Set<string>>();
  /** User messages a connection has seen, so none is shown twice. */
  readonly #shown = new Map<string, Set<string>>();
  /** The response a running turn writes, by conversation and turn. */
  readonly #turnResponses = new Map<string, string>();
  /** Turn work per conversation, in order. */
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: AcpChannelOptions = {}) {
    this.#options = options;
  }

  mount(host: ChannelsHost): void {
    if (this.#host) throw new Error("An AcpChannel can be mounted only once");
    this.#host = host;
    this.#websockets =
      this.#options.websockets ?? host.websockets(() => new WebSockets());
    this.#websockets.use({
      onConnect: (connection, ctx) => this.#connect(connection, ctx),
      onMessage: (connection, message) => this.#message(connection, message),
      onClose: (connection) => this.#close(connection)
    });
  }

  publish(conversationId: string, update: ConversationUpdate): void {
    switch (update.type) {
      case "turn":
        this.#onTurn(conversationId, update.turn);
        return;
      case "messages":
        this.#onMessages(conversationId, update.messages);
        return;
      case "reset":
        // ACP has no reset: turns it aborted settle as cancelled, and later
        // output follows on.
        return;
      case "response-end":
        // Reads end on their own.
        return;
    }
  }

  // ── Connections ────────────────────────────────────────────────────────

  #connect(connection: Connection, { request }: ConnectionContext): void {
    const header = request.headers.get(WEB_IDENTITY_HEADER);
    if (header === null) return;
    // The gateway is the trust boundary: it resolves who is connecting and
    // sets this header, as for the Web Channel.
    // SAFETY: only the gateway sets this header, with a WebIdentity.
    const resolved = JSON.parse(header) as WebIdentity;
    const host = this.#mounted();
    if (resolved.channel !== host.channelKey) return;
    const identity: Identity = {
      channelKey: host.channelKey,
      participant: resolved.participant,
      sessions: []
    };
    setConnectionFlag(connection, IDENTITY_KEY, identity);
  }

  async #message(connection: Connection, message: WSMessage): Promise<boolean> {
    const identity = this.#identityOf(connection);
    if (!identity) return false;
    if (typeof message !== "string") return true;
    const parsed = parseRpcMessage(message);
    if (!parsed) {
      send(connection, failure(null, RpcError.parse, "Not a JSON-RPC message"));
      return true;
    }
    try {
      await this.#rpc(connection, identity, parsed);
    } catch (error) {
      console.error("ACP request failed", error);
      if (isRequest(parsed)) {
        send(
          connection,
          failure(parsed.id, RpcError.internal, "The agent failed")
        );
      }
    }
    return true;
  }

  #close(connection: Connection): void {
    const identity = this.#identityOf(connection);
    this.#stopReads(connection.id);
    this.#ended.delete(connection.id);
    this.#shown.delete(connection.id);
    if (!identity) return;
    // Prompts on this connection can no longer be answered. Their turns run
    // on; a client that loads the session again sees how they went.
    for (const sessionId of identity.sessions) {
      this.#update(sessionId, (record) => {
        for (const p of record.permissions) {
          if (p.connectionId === connection.id) {
            this.#mounted().state.delete(permissionKey(p.rpcId));
          }
        }
        record.prompts = record.prompts.filter(
          (p) => p.connectionId !== connection.id
        );
        record.permissions = record.permissions.filter(
          (p) => p.connectionId !== connection.id
        );
      });
    }
  }

  // ── JSON-RPC ───────────────────────────────────────────────────────────

  async #rpc(
    connection: Connection,
    identity: Identity,
    message: RpcMessage
  ): Promise<void> {
    if (!("method" in message)) {
      await this.#permissionAnswer(connection, identity, message);
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    if (!("id" in message)) {
      if (message.method === "session/cancel") {
        const sessionId = stringField(params, "sessionId");
        if (sessionId) await this.#cancel(connection, identity, sessionId);
      }
      // Other notifications need no answer.
      return;
    }
    const { id } = message;
    const reply = (value: Json) => send(connection, result(id, value));
    const fail = (code: number, text: string) =>
      send(connection, failure(id, code, text));

    switch (message.method) {
      case "initialize":
        reply(this.#initialize());
        return;
      case "authenticate":
        reply({});
        return;
      case "session/new": {
        const sessionId = await this.#operate(connection, identity, {
          type: "conversation-create"
        });
        if (sessionId === undefined) {
          fail(RpcError.internal, "The agent did not create a session");
          return;
        }
        this.#remember(sessionId, params);
        this.#follow(connection, identity, sessionId);
        reply({ sessionId });
        return;
      }
      case "session/fork": {
        const from = await this.#existing(params);
        if (from === undefined) return fail(...notFound());
        const sessionId = await this.#operate(
          connection,
          identity,
          { type: "conversation-fork" },
          from
        );
        if (sessionId === undefined) {
          fail(RpcError.internal, "The agent did not fork the session");
          return;
        }
        this.#remember(sessionId, params);
        this.#follow(connection, identity, sessionId);
        reply({ sessionId });
        return;
      }
      case "session/load": {
        const sessionId = await this.#existing(params);
        if (sessionId === undefined) return fail(...notFound());
        this.#remember(sessionId, params);
        this.#follow(connection, identity, sessionId);
        await this.#replay(connection, sessionId);
        reply({});
        return;
      }
      case "session/resume": {
        const sessionId = await this.#existing(params);
        if (sessionId === undefined) return fail(...notFound());
        this.#remember(sessionId, params);
        this.#follow(connection, identity, sessionId);
        reply({});
        return;
      }
      case "session/list":
        reply({ sessions: await this.#list(stringField(params, "cwd")) });
        return;
      case "session/close": {
        const sessionId = stringField(params, "sessionId");
        if (sessionId === undefined) {
          return fail(RpcError.invalidParams, "sessionId is required");
        }
        await this.#cancel(connection, identity, sessionId);
        this.#unfollow(connection, sessionId);
        reply({});
        return;
      }
      case "session/prompt":
        await this.#prompt(connection, identity, message, params);
        return;
      default:
        fail(RpcError.methodNotFound, `Method not found: ${message.method}`);
    }
  }

  #initialize(): InitializeResponse {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: true
        },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} }
      },
      authMethods: [],
      ...(this.#options.agentInfo && { agentInfo: this.#options.agentInfo })
    };
  }

  /** Create or fork a conversation; resolves with its id. */
  async #operate(
    connection: Connection,
    identity: Identity,
    event: { type: "conversation-create" } | { type: "conversation-fork" },
    from?: string
  ): Promise<string | undefined> {
    const host = this.#mounted();
    const conversationId = from ?? host.defaultConversation();
    const dispatched = await host.dispatch(
      { ...event, eventId: crypto.randomUUID() },
      this.#origin(connection, identity, conversationId)
    );
    return dispatched.conversationId;
  }

  /** The session a request names, when the agent has it. */
  async #existing(
    params: Record<string, unknown>
  ): Promise<string | undefined> {
    const sessionId = stringField(params, "sessionId");
    if (sessionId === undefined) return undefined;
    const conversations = await this.#mounted().listConversations();
    return conversations.some((c) => c.id === sessionId)
      ? sessionId
      : undefined;
  }

  async #list(cwd: string | undefined): Promise<SessionInfo[]> {
    const conversations = await this.#mounted().listConversations();
    const sessions: SessionInfo[] = [];
    for (const { id } of conversations) {
      const recorded = this.#record(id).cwd;
      // A session opened from elsewhere is not one of this directory's.
      if (cwd !== undefined && recorded !== undefined && recorded !== cwd) {
        continue;
      }
      // ACP requires a directory; sessions no client opened have none.
      sessions.push({ sessionId: id, cwd: recorded ?? cwd ?? "/" });
    }
    return sessions;
  }

  // ── Prompts and turns ──────────────────────────────────────────────────

  async #prompt(
    connection: Connection,
    identity: Identity,
    request: RpcRequest,
    params: Record<string, unknown>
  ): Promise<void> {
    const sessionId = stringField(params, "sessionId");
    if (sessionId === undefined || !identity.sessions.includes(sessionId)) {
      send(connection, failure(request.id, ...notFound()));
      return;
    }
    const parts = Array.isArray(params.prompt)
      ? toParts(params.prompt)
      : undefined;
    if (parts === undefined) {
      send(
        connection,
        failure(
          request.id,
          RpcError.invalidParams,
          "Prompts take text, resource and resource_link content"
        )
      );
      return;
    }
    // The message's event id is its turn's id.
    const turnId = crypto.randomUUID();
    this.#update(sessionId, (record) => {
      record.prompts.push({
        turnId,
        connectionId: connection.id,
        rpcId: request.id
      });
    });
    this.#seen(connection.id).add(turnId);
    try {
      await this.#mounted().dispatch(
        {
          type: "message",
          eventId: turnId,
          message: { id: turnId, role: "user", parts }
        },
        this.#origin(connection, identity, sessionId)
      );
    } catch (error) {
      console.error("The agent rejected an ACP prompt", error);
      this.#answer(sessionId, turnId, (prompt) =>
        failure(
          prompt.rpcId,
          RpcError.internal,
          "The agent rejected the prompt"
        )
      );
    }
  }

  /**
   * Cancel this connection's turns in a session. A turn waiting on a
   * permission does not run again, so its prompt is answered here.
   */
  async #cancel(
    connection: Connection,
    identity: Identity,
    sessionId: string
  ): Promise<void> {
    const prompts = this.#record(sessionId).prompts.filter(
      (p) => p.connectionId === connection.id
    );
    if (prompts.length === 0) return;
    const host = this.#mounted();
    for (const { turnId } of prompts) {
      await host.dispatch(
        { type: "cancel", eventId: crypto.randomUUID(), turnId },
        this.#origin(connection, identity, sessionId)
      );
    }
    const { turns } = await host.snapshot(sessionId);
    for (const { turnId } of prompts) {
      const turn = turns.find((t) => t.turnId === turnId);
      if (turn?.status === "settled" && turn.outcome === "awaiting-input") {
        this.#answer(sessionId, turnId, (prompt) =>
          result(prompt.rpcId, { stopReason: "cancelled" })
        );
      }
    }
  }

  #onTurn(conversationId: string, turn: TurnStatus): void {
    const key = turnKey(conversationId, turn.turnId);
    if (turn.status === "running") {
      this.#turnResponses.set(key, turn.responseId);
      for (const connection of this.#followers(conversationId)) {
        this.#read(connection, conversationId, turn.responseId);
      }
      return;
    }
    if (turn.status === "settled") {
      this.#enqueue(conversationId, () => this.#settled(conversationId, turn));
    }
  }

  async #settled(
    conversationId: string,
    turn: Extract<TurnStatus, { status: "settled" }>
  ): Promise<void> {
    const key = turnKey(conversationId, turn.turnId);
    const prompts = this.#record(conversationId).prompts.filter(
      (p) => p.turnId === turn.turnId
    );
    if (prompts.length === 0) {
      if (turn.outcome !== "awaiting-input") this.#turnResponses.delete(key);
      return;
    }
    // The turn settles before its response ends: send the rest first.
    const responseId = this.#turnResponses.get(key);
    if (responseId !== undefined) {
      await Promise.all(
        prompts.map(
          (p) => this.#reads.get(p.connectionId)?.get(responseId)?.done
        )
      );
    }
    if (turn.outcome === "awaiting-input") {
      await this.#askPermissions(conversationId, turn);
      return;
    }
    this.#turnResponses.delete(key);
    const reply = (rpcId: RpcId): RpcResponse =>
      turn.outcome === "failed"
        ? failure(rpcId, RpcError.internal, turn.error ?? "The turn failed")
        : result(rpcId, {
            stopReason: turn.outcome === "aborted" ? "cancelled" : "end_turn"
          });
    this.#answer(conversationId, turn.turnId, (prompt) => reply(prompt.rpcId));
  }

  /**
   * Ask for the approvals a settled turn waits on. A turn waiting on
   * something else, such as a client tool ACP cannot run, ends here.
   */
  async #askPermissions(
    conversationId: string,
    turn: Extract<TurnStatus, { status: "settled" }>
  ): Promise<void> {
    const host = this.#mounted();
    const { messages } = await host.snapshot(conversationId);
    const requested = messages
      .filter((m) => turn.messageIds.includes(m.id))
      .flatMap((m) => m.parts)
      .filter(
        (part): part is ToolPart & { approval: { id: string } } =>
          part.type === "tool" &&
          part.state === "approval-requested" &&
          part.approval !== undefined
      );
    let asking = false;
    this.#update(conversationId, (record) => {
      for (const prompt of record.prompts) {
        if (prompt.turnId !== turn.turnId) continue;
        const connection = this.#websockets?.getConnection(prompt.connectionId);
        if (!connection) continue;
        for (const part of requested) {
          const outstanding = record.permissions.some(
            (p) =>
              p.connectionId === prompt.connectionId &&
              p.approvalId === part.approval.id
          );
          if (outstanding) {
            asking = true;
            continue;
          }
          const rpcId = `permission:${crypto.randomUUID()}`;
          record.permissions.push({
            rpcId,
            connectionId: prompt.connectionId,
            turnId: turn.turnId,
            approvalId: part.approval.id
          });
          host.state.put(permissionKey(rpcId), conversationId);
          const params: RequestPermissionParams = {
            sessionId: conversationId,
            toolCall: {
              toolCallId: part.toolCallId,
              title: part.title ?? part.toolName,
              kind: "other",
              status: "pending",
              ...(part.input !== undefined && { rawInput: part.input })
            },
            options: [
              { optionId: ALLOW, name: "Allow", kind: "allow_once" },
              { optionId: REJECT, name: "Reject", kind: "reject_once" }
            ]
          };
          send(connection, {
            jsonrpc: "2.0",
            id: rpcId,
            method: "session/request_permission",
            // SAFETY: built from JSON values.
            params: params as unknown as Json
          });
          asking = true;
        }
      }
    });
    if (!asking) {
      this.#turnResponses.delete(turnKey(conversationId, turn.turnId));
      this.#answer(conversationId, turn.turnId, (prompt) =>
        result(prompt.rpcId, { stopReason: "end_turn" })
      );
    }
  }

  /** The client's answer to a permission request. */
  async #permissionAnswer(
    connection: Connection,
    identity: Identity,
    response: RpcResponse
  ): Promise<void> {
    if (typeof response.id !== "string") return;
    const host = this.#mounted();
    const sessionId = host.state.get<string>(permissionKey(response.id));
    if (sessionId === undefined) return;
    const pending = this.#record(sessionId).permissions.find(
      (p) => p.rpcId === response.id && p.connectionId === connection.id
    );
    if (!pending) return;
    host.state.delete(permissionKey(response.id));
    this.#update(sessionId, (record) => {
      record.permissions = record.permissions.filter(
        (p) => p.rpcId !== response.id
      );
    });
    const choice = "result" in response ? selectedOption(response.result) : "";
    const origin = this.#origin(connection, identity, sessionId);
    if (choice === ALLOW || choice === REJECT) {
      await host.dispatch(
        {
          type: "approval-response",
          eventId: crypto.randomUUID(),
          turnId: pending.turnId,
          approvalId: pending.approvalId,
          approved: choice === ALLOW
        },
        origin
      );
      return;
    }
    // Cancelled, or an error: the client is ending the turn.
    await host.dispatch(
      { type: "cancel", eventId: crypto.randomUUID(), turnId: pending.turnId },
      origin
    );
    this.#answer(sessionId, pending.turnId, (prompt) =>
      result(prompt.rpcId, { stopReason: "cancelled" })
    );
  }

  /** Answer a turn's prompts, forgetting them and their permissions. */
  #answer(
    sessionId: string,
    turnId: string,
    reply: (prompt: PendingPrompt) => RpcResponse
  ): void {
    let answered: PendingPrompt[] = [];
    this.#update(sessionId, (record) => {
      answered = record.prompts.filter((p) => p.turnId === turnId);
      record.prompts = record.prompts.filter((p) => p.turnId !== turnId);
      for (const p of record.permissions) {
        if (p.turnId === turnId) {
          this.#mounted().state.delete(permissionKey(p.rpcId));
        }
      }
      record.permissions = record.permissions.filter(
        (p) => p.turnId !== turnId
      );
    });
    for (const prompt of answered) {
      const connection = this.#websockets?.getConnection(prompt.connectionId);
      if (connection) send(connection, reply(prompt));
    }
  }

  #enqueue(conversationId: string, work: () => Promise<void>): void {
    const previous = this.#queues.get(conversationId) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
      console.error("ACP turn update failed", error);
    });
    this.#queues.set(conversationId, next);
    void next.then(() => {
      if (this.#queues.get(conversationId) === next) {
        this.#queues.delete(conversationId);
      }
    });
  }

  // ── Output ─────────────────────────────────────────────────────────────

  /** Show user messages from the conversation's other surfaces. */
  #onMessages(conversationId: string, messages: TranscriptMessage[]): void {
    for (const connection of this.#followers(conversationId)) {
      const seen = this.#seen(connection.id);
      for (const message of messages) {
        if (message.role !== "user" || seen.has(message.id)) continue;
        seen.add(message.id);
        for (const update of transcriptUpdates(message)) {
          notify(connection, conversationId, update);
        }
      }
    }
  }

  /** Send the transcript, then follow any turn still running. */
  async #replay(connection: Connection, sessionId: string): Promise<void> {
    const { messages, turns } = await this.#mounted().snapshot(sessionId);
    const seen = this.#seen(connection.id);
    for (const message of messages) {
      if (message.role === "user") seen.add(message.id);
      for (const update of transcriptUpdates(message)) {
        notify(connection, sessionId, update);
      }
    }
    for (const turn of turns) {
      if (turn.status !== "running") continue;
      this.#turnResponses.set(turnKey(sessionId, turn.turnId), turn.responseId);
      this.#read(connection, sessionId, turn.responseId);
    }
  }

  /** Forward one response to one connection, once. */
  #read(connection: Connection, conversationId: string, responseId: string) {
    let reads = this.#reads.get(connection.id);
    if (!reads) this.#reads.set(connection.id, (reads = new Map()));
    let ended = this.#ended.get(connection.id);
    if (!ended) this.#ended.set(connection.id, (ended = new Set()));
    if (reads.has(responseId) || ended.has(responseId)) return;
    const controller = new AbortController();
    const announced = new Set<string>();
    const done = this.#mounted()
      .readResponse(conversationId, responseId, {
        signal: controller.signal,
        onChunks: (_from, chunks) => {
          for (const chunk of chunks) {
            const update = chunkUpdate(chunk, announced);
            if (update) notify(connection, conversationId, update);
          }
        },
        onCaughtUp: () => {}
      })
      .then(
        () => {},
        (error: unknown) => {
          if (!controller.signal.aborted) {
            console.error(`Failed to read response "${responseId}"`, error);
          }
        }
      )
      .finally(() => {
        reads.delete(responseId);
        ended.add(responseId);
      });
    reads.set(responseId, { controller, done });
  }

  #stopReads(connectionId: string): void {
    for (const read of this.#reads.get(connectionId)?.values() ?? []) {
      read.controller.abort();
    }
    this.#reads.delete(connectionId);
  }

  // ── Following ──────────────────────────────────────────────────────────

  #follow(connection: Connection, identity: Identity, sessionId: string) {
    if (identity.sessions.includes(sessionId)) return;
    identity.sessions = [...identity.sessions, sessionId];
    setConnectionFlag(connection, IDENTITY_KEY, identity);
  }

  #unfollow(connection: Connection, sessionId: string): void {
    const identity = this.#identityOf(connection);
    if (!identity) return;
    identity.sessions = identity.sessions.filter((id) => id !== sessionId);
    setConnectionFlag(connection, IDENTITY_KEY, identity);
  }

  *#followers(conversationId: string): Iterable<Connection> {
    for (const connection of this.#websockets?.getConnections() ?? []) {
      if (this.#identityOf(connection)?.sessions.includes(conversationId)) {
        yield connection;
      }
    }
  }

  #identityOf(connection: Connection): Identity | undefined {
    // SAFETY: only this channel writes this key, with an Identity.
    const identity = getConnectionFlag(connection, IDENTITY_KEY) as
      | Identity
      | undefined;
    return identity?.channelKey === this.#host?.channelKey
      ? identity
      : undefined;
  }

  #seen(connectionId: string): Set<string> {
    let seen = this.#shown.get(connectionId);
    if (!seen) this.#shown.set(connectionId, (seen = new Set()));
    return seen;
  }

  #origin(
    connection: Connection,
    identity: Identity,
    conversationId: string
  ): EventOrigin {
    return {
      conversationId,
      participant: identity.participant,
      surface: {
        channelKey: identity.channelKey,
        version: 1,
        address: { conversationId, connectionId: connection.id },
        label: "ACP"
      }
    };
  }

  // ── Session records ────────────────────────────────────────────────────

  #record(sessionId: string): SessionRecord {
    return (
      this.#mounted().state.get<SessionRecord>(sessionKey(sessionId)) ?? {
        prompts: [],
        permissions: []
      }
    );
  }

  #update(sessionId: string, change: (record: SessionRecord) => void): void {
    const record = this.#record(sessionId);
    change(record);
    this.#mounted().state.put(sessionKey(sessionId), record);
  }

  /** Keep the directory a client opened the session in, for `session/list`. */
  #remember(sessionId: string, params: Record<string, unknown>): void {
    const cwd = stringField(params, "cwd");
    if (cwd === undefined) return;
    this.#update(sessionId, (record) => {
      record.cwd ??= cwd;
    });
  }

  #mounted(): ChannelsHost {
    if (!this.#host) throw new Error("AcpChannel is not mounted");
    return this.#host;
  }
}

// ── Mapping ──────────────────────────────────────────────────────────────

function sessionKey(sessionId: string): string {
  return `acp:session:${sessionId}`;
}

function permissionKey(rpcId: string): string {
  return `acp:permission:${rpcId}`;
}

function turnKey(conversationId: string, turnId: string): string {
  return JSON.stringify([conversationId, turnId]);
}

function notFound(): [number, string] {
  return [RpcError.resourceNotFound, "Session not found"];
}

function stringField(
  params: Record<string, unknown>,
  key: string
): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function selectedOption(value: Json): string {
  if (!isRecord(value) || !isRecord(value.outcome)) return "";
  const { outcome, optionId } = value.outcome;
  return outcome === "selected" && typeof optionId === "string" ? optionId : "";
}

/** Prompt content as message parts, or undefined if any is unsupported. */
function toParts(blocks: unknown[]): MessagePart[] | undefined {
  const parts: MessagePart[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) return undefined;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (
      block.type === "resource_link" &&
      typeof block.uri === "string"
    ) {
      const name = typeof block.name === "string" ? block.name : block.uri;
      parts.push({ type: "text", text: `[${name}](${block.uri})` });
    } else if (block.type === "resource" && isRecord(block.resource)) {
      const { uri, text } = block.resource;
      // Only text resources: binary ones need a file part the agent can read.
      if (typeof uri !== "string" || typeof text !== "string") {
        return undefined;
      }
      parts.push({
        type: "text",
        text: `<resource uri="${uri}">\n${text}\n</resource>`
      });
    } else {
      return undefined;
    }
  }
  return parts;
}

function text(value: string): ContentBlock {
  return { type: "text", text: value };
}

function fileBlock(part: Extract<MessagePart, { type: "file" }>): ContentBlock {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(part.url);
  if (data && part.mediaType.startsWith("image/")) {
    return { type: "image", data: data[2], mimeType: part.mediaType };
  }
  return {
    type: "resource_link",
    uri: part.url,
    name: part.filename ?? part.url,
    mimeType: part.mediaType
  };
}

function outputText(output: Json): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

function toolStatus(part: ToolPart): ToolCallStatus {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
    case "approval-requested":
      return "pending";
    case "approval-responded":
      return "in_progress";
    case "output-available":
      return part.preliminary ? "in_progress" : "completed";
    case "output-error":
    case "output-denied":
      return "failed";
  }
}

/** A saved message as the updates a client replays it from. */
function transcriptUpdates(message: TranscriptMessage): SessionUpdate[] {
  if (message.role === "system") return [];
  const chunk =
    message.role === "user" ? "user_message_chunk" : "agent_message_chunk";
  const updates: SessionUpdate[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        updates.push({
          sessionUpdate: chunk,
          content: text(part.text),
          messageId: message.id
        });
        break;
      case "reasoning":
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          content: text(part.text),
          messageId: message.id
        });
        break;
      case "file":
        updates.push({
          sessionUpdate: chunk,
          content: fileBlock(part),
          messageId: message.id
        });
        break;
      case "source-url":
        updates.push({
          sessionUpdate: chunk,
          content: {
            type: "resource_link",
            uri: part.url,
            name: part.title ?? part.url
          },
          messageId: message.id
        });
        break;
      case "tool": {
        const detail =
          part.errorText ??
          (part.output !== undefined ? outputText(part.output) : undefined);
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: part.toolCallId,
          title: part.title ?? part.toolName,
          kind: "other",
          status: toolStatus(part),
          ...(part.input !== undefined && { rawInput: part.input }),
          ...(part.output !== undefined && { rawOutput: part.output }),
          ...(detail !== undefined && {
            content: [{ type: "content", content: text(detail) }]
          })
        });
        break;
      }
      default:
        break;
    }
  }
  return updates;
}

/**
 * A response chunk as a session update, or undefined when ACP has nothing
 * for it. `announced` holds the tool calls this read has announced.
 */
function chunkUpdate(
  chunk: ResponseChunk,
  announced: Set<string>
): SessionUpdate | undefined {
  switch (chunk.type) {
    case "text-delta":
      return {
        sessionUpdate: "agent_message_chunk",
        content: text(chunk.delta)
      };
    case "reasoning-delta":
      return {
        sessionUpdate: "agent_thought_chunk",
        content: text(chunk.delta)
      };
    case "file":
      return {
        sessionUpdate: "agent_message_chunk",
        content: fileBlock(chunk)
      };
    case "source-url":
      return {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "resource_link",
          uri: chunk.url,
          name: chunk.title ?? chunk.url
        }
      };
    case "tool-input-start":
      announced.add(chunk.toolCallId);
      return {
        sessionUpdate: "tool_call",
        toolCallId: chunk.toolCallId,
        title: chunk.title ?? chunk.toolName,
        kind: "other",
        status: "pending"
      };
    case "tool-input-available":
    case "tool-input-error": {
      const failed = chunk.type === "tool-input-error";
      const fields = {
        toolCallId: chunk.toolCallId,
        rawInput: chunk.input,
        ...(failed && {
          status: "failed" as const,
          content: [
            { type: "content" as const, content: text(chunk.errorText) }
          ]
        })
      };
      if (announced.has(chunk.toolCallId)) {
        return { sessionUpdate: "tool_call_update", ...fields };
      }
      announced.add(chunk.toolCallId);
      return {
        sessionUpdate: "tool_call",
        title: chunk.title ?? chunk.toolName,
        kind: "other",
        status: "pending",
        ...fields
      };
    }
    case "tool-output-available":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: chunk.toolCallId,
        status: chunk.preliminary ? "in_progress" : "completed",
        rawOutput: chunk.output,
        content: [{ type: "content", content: text(outputText(chunk.output)) }]
      };
    case "tool-output-error":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: chunk.toolCallId,
        status: "failed",
        content: [{ type: "content", content: text(chunk.errorText) }]
      };
    case "tool-output-denied":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: chunk.toolCallId,
        status: "failed",
        content: [{ type: "content", content: text("Denied") }]
      };
    default:
      return undefined;
  }
}

function notify(
  connection: Connection,
  sessionId: string,
  update: SessionUpdate
): void {
  send(connection, {
    jsonrpc: "2.0",
    method: "session/update",
    // SAFETY: built from JSON values.
    params: { sessionId, update } as unknown as Json
  });
}

/** A failed send to one stale socket must not stop delivery to the rest. */
function send(connection: Connection, message: RpcMessage): void {
  try {
    connection.send(JSON.stringify(message));
  } catch {
    // The socket is closing; its close handler cleans up.
  }
}
