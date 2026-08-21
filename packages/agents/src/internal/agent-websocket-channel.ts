import type {
  Connection,
  ConnectionContext,
  WSMessage
} from "../lifecycle/durable-object-lifecycle";
import {
  isRPCRequest,
  isStateUpdateMessage,
  sendRpcResponseIfOpen,
  StreamingResponse,
  type CallableMetadata,
  type RPCResponse
} from "./rpc";
import { MessageType } from "../types";

const identityWarningClasses = new WeakSet<Function>();

/** @internal A callable Agent method resolved for the browser protocol. */
export type ResolvedAgentCallable = {
  metadata: CallableMetadata;
  invoke(args: unknown[]): unknown | Promise<unknown>;
};

/** @internal Identity sent when an Agent browser connection opens. */
export type AgentWebSocketIdentity = {
  agent: string;
  agentClass: Function;
  explicitSetting: boolean;
  isFacet: boolean;
  name: string;
  sendOnConnect: boolean;
};

/** @internal Operations the built-in Agent WebSocket channel needs from Agent. */
export interface AgentWebSocketChannelHost<State> {
  ensureConnectionWrapped(connection: Connection): void;
  setConnectionFlag(connection: Connection, key: string, value: unknown): void;
  forwardSubAgentConnect(
    connection: Connection,
    request: Request
  ): Promise<boolean>;
  forwardSubAgentMessage(
    connection: Connection,
    message: WSMessage
  ): Promise<boolean>;
  forwardSubAgentClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean>;
  runInConnectionContext<T>(
    connection: Connection,
    request: Request | undefined,
    operation: () => T
  ): T;
  withErrorBoundary<T>(operation: () => T | Promise<T>): Promise<T>;
  shouldConnectionBeReadonly(
    connection: Connection,
    context: ConnectionContext
  ): boolean;
  setConnectionReadonly(connection: Connection, readonly?: boolean): void;
  isConnectionReadonly(connection: Connection): boolean;
  shouldSendProtocolMessages(
    connection: Connection,
    context: ConnectionContext
  ): boolean;
  disableProtocolMessages(connection: Connection): void;
  isConnectionProtocolEnabled(connection: Connection): boolean;
  getConnections(): Iterable<Connection>;
  broadcast(message: string, without?: string[]): void;
  getIdentity(): AgentWebSocketIdentity;
  getState(): State;
  setStateFromClient(state: State, connection: Connection): void;
  getMcpServers(): unknown;
  resolveCallable(method: string): ResolvedAgentCallable;
  emit(
    type: "connect" | "disconnect" | "rpc" | "rpc:error",
    payload: Record<string, unknown>
  ): void;
  replayAgentToolRuns(connection: Connection): Promise<void>;
}

/** @internal Legacy connection callbacks retained while channels remain private. */
export type AgentWebSocketChannelHooks = {
  onConnect(
    connection: Connection,
    context: ConnectionContext
  ): void | Promise<void>;
  onMessage(connection: Connection, message: WSMessage): void | Promise<void>;
  onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): void | Promise<void>;
};

/**
 * Internal built-in channel for the Agents browser WebSocket protocol.
 *
 * This module deliberately has no package export. It separates protocol
 * ownership from the Agent class while preserving the existing connection
 * hooks as compatibility callbacks until the public channel API is designed.
 *
 * @internal
 */
export class AgentWebSocketChannel<State> {
  readonly #host: AgentWebSocketChannelHost<State>;
  readonly #hooks: AgentWebSocketChannelHooks;
  readonly #protocolBroadcastExcludeIds = new Set<string>();
  readonly #subAgentOuterUrlHeader: string;
  readonly #subAgentOuterUrlKey: string;

  /**
   * Create the built-in Agent browser channel.
   *
   * @param host - Agent operations needed by the protocol.
   * @param hooks - Existing user connection hooks used as compatibility exits.
   * @param subAgentRouting - Internal sub-agent routing metadata.
   */
  constructor(
    host: AgentWebSocketChannelHost<State>,
    hooks: AgentWebSocketChannelHooks,
    subAgentRouting: { outerUrlHeader: string; outerUrlKey: string }
  ) {
    this.#host = host;
    this.#hooks = hooks;
    this.#subAgentOuterUrlHeader = subAgentRouting.outerUrlHeader;
    this.#subAgentOuterUrlKey = subAgentRouting.outerUrlKey;
  }

  /** Handle a newly accepted lifecycle WebSocket. */
  async onConnect(
    connection: Connection,
    context: ConnectionContext
  ): Promise<void> {
    this.#host.ensureConnectionWrapped(connection);

    const subAgentOuterUrl = context.request.headers.get(
      this.#subAgentOuterUrlHeader
    );
    if (subAgentOuterUrl) {
      this.#host.setConnectionFlag(
        connection,
        this.#subAgentOuterUrlKey,
        subAgentOuterUrl
      );
    }

    if (await this.#host.forwardSubAgentConnect(connection, context.request)) {
      return;
    }

    return this.#host.runInConnectionContext(
      connection,
      context.request,
      async () => {
        if (this.#host.shouldConnectionBeReadonly(connection, context)) {
          this.#host.setConnectionReadonly(connection, true);
        }

        if (this.#host.shouldSendProtocolMessages(connection, context)) {
          this.#sendInitialProtocolState(connection, context.request);
        } else {
          this.#host.disableProtocolMessages(connection);
        }

        this.#host.emit("connect", { connectionId: connection.id });
        await this.#host.replayAgentToolRuns(connection);
        await this.#host.withErrorBoundary(() =>
          this.#hooks.onConnect(connection, context)
        );
      }
    );
  }

  /** Handle one raw frame from a lifecycle WebSocket. */
  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (await this.#host.forwardSubAgentMessage(connection, message)) {
      return;
    }

    this.#host.ensureConnectionWrapped(connection);
    return this.#host.runInConnectionContext(
      connection,
      undefined,
      async () => {
        if (typeof message !== "string") {
          await this.#forwardUnhandledMessage(connection, message);
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          await this.#forwardUnhandledMessage(connection, message);
          return;
        }

        if (isStateUpdateMessage(parsed)) {
          // SAFETY: State is the Agent owner's declared wire-state type. The
          // channel preserves the existing protocol boundary and the Agent's
          // validateStateChange hook rejects invalid values before persistence.
          this.#handleStateUpdate(connection, parsed.state as State);
          return;
        }

        if (isRPCRequest(parsed)) {
          await this.#handleRpc(connection, parsed);
          return;
        }

        await this.#forwardUnhandledMessage(connection, message);
      }
    );
  }

  /** Handle a lifecycle WebSocket closing. */
  async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    if (
      await this.#host.forwardSubAgentClose(connection, code, reason, wasClean)
    ) {
      return;
    }

    return this.#host.runInConnectionContext(
      connection,
      undefined,
      async () => {
        this.#host.emit("disconnect", {
          connectionId: connection.id,
          code,
          reason
        });
        await this.#hooks.onClose(connection, code, reason, wasClean);
      }
    );
  }

  /** Broadcast an Agents protocol frame to protocol-enabled connections. */
  broadcastProtocol(message: string, excludeIds: string[] = []): void {
    const exclude = [...excludeIds, ...this.#protocolBroadcastExcludeIds];
    for (const connection of this.#host.getConnections()) {
      if (!this.#host.isConnectionProtocolEnabled(connection)) {
        exclude.push(connection.id);
      }
    }
    this.#host.broadcast(message, exclude);
  }

  /** Broadcast a state change, excluding the client that originated it. */
  broadcastState(state: State, source: Connection | "server"): void {
    this.broadcastProtocol(
      JSON.stringify({
        state,
        type: MessageType.CF_AGENT_STATE
      }),
      source === "server" ? [] : [source.id]
    );
  }

  #sendInitialProtocolState(connection: Connection, request: Request): void {
    const identity = this.#host.getIdentity();
    if (identity.sendOnConnect) {
      this.#warnIfCustomRouteRevealsIdentity(identity, request);
      connection.send(
        JSON.stringify({
          name: identity.name,
          agent: identity.agent,
          type: MessageType.CF_AGENT_IDENTITY
        })
      );
    }

    const wasExcluded = this.#protocolBroadcastExcludeIds.has(connection.id);
    this.#protocolBroadcastExcludeIds.add(connection.id);
    let currentState: State;
    try {
      currentState = this.#host.getState();
    } finally {
      if (!wasExcluded) {
        this.#protocolBroadcastExcludeIds.delete(connection.id);
      }
    }

    if (currentState !== undefined) {
      connection.send(
        JSON.stringify({
          state: currentState,
          type: MessageType.CF_AGENT_STATE
        })
      );
    }

    connection.send(
      JSON.stringify({
        mcp: this.#host.getMcpServers(),
        type: MessageType.CF_AGENT_MCP_SERVERS
      })
    );
  }

  #warnIfCustomRouteRevealsIdentity(
    identity: AgentWebSocketIdentity,
    request: Request
  ): void {
    if (
      identity.explicitSetting ||
      identity.isFacet ||
      identityWarningClasses.has(identity.agentClass) ||
      new URL(request.url).pathname.includes(identity.name)
    ) {
      return;
    }

    identityWarningClasses.add(identity.agentClass);
    console.warn(
      `[Agent] ${identity.agentClass.name}: sending instance name "${identity.name}" to clients ` +
        `via sendIdentityOnConnect (the name is not visible in the URL with ` +
        `custom routing). If this name is sensitive, add ` +
        `\`static options = { sendIdentityOnConnect: false }\` to opt out. ` +
        `Set it to true to silence this message.`
    );
  }

  #handleStateUpdate(connection: Connection, state: State): void {
    if (this.#host.isConnectionReadonly(connection)) {
      connection.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE_ERROR,
          error: "Connection is readonly"
        })
      );
      return;
    }

    try {
      this.#host.setStateFromClient(state, connection);
    } catch (error) {
      console.error("[Agent] State update rejected:", error);
      connection.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STATE_ERROR,
          error: "State update rejected"
        })
      );
    }
  }

  async #handleRpc(
    connection: Connection,
    request: { id: string; method: string; args: unknown[] }
  ): Promise<void> {
    try {
      const callable = this.#host.resolveCallable(request.method);

      if (callable.metadata.streaming) {
        const stream = new StreamingResponse(connection, request.id);
        this.#host.emit("rpc", {
          method: request.method,
          streaming: true
        });

        try {
          await callable.invoke([stream, ...request.args]);
        } catch (error) {
          console.error(
            `Error in streaming method "${request.method}":`,
            error
          );
          this.#host.emit("rpc:error", {
            method: request.method,
            error: error instanceof Error ? error.message : String(error)
          });
          if (!stream.isClosed) {
            stream.error(
              error instanceof Error ? error.message : String(error)
            );
          }
        }
        return;
      }

      const result = await callable.invoke(request.args);
      this.#host.emit("rpc", {
        method: request.method,
        streaming: callable.metadata.streaming
      });

      const response: RPCResponse = {
        done: true,
        id: request.id,
        result,
        success: true,
        type: MessageType.RPC
      };
      sendRpcResponseIfOpen(connection, response);
    } catch (error) {
      const response: RPCResponse = {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
        id: request.id,
        success: false,
        type: MessageType.RPC
      };
      sendRpcResponseIfOpen(connection, response);
      console.error("RPC error:", error);
      this.#host.emit("rpc:error", {
        method: request.method,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #forwardUnhandledMessage(
    connection: Connection,
    message: WSMessage
  ): Promise<void> {
    await this.#host.withErrorBoundary(() =>
      this.#hooks.onMessage(connection, message)
    );
  }
}
