import { AsyncLocalStorage } from "node:async_hooks";
import type { WSMessage } from "../lifecycle";
import type { BridgedConnectionLink } from "../websockets/bridged";
import type { AgentPathStep } from "../sub-routing";
import { RootDynamicAgentConnectionBridge } from "./bridges";
import type { DynamicAgentRouteMessage } from "./protocol";
import type {
  DynamicAgentBridgeInvocationContext,
  DynamicAgentConnectionBridgeLike,
  DynamicAgentConnectionOperationName
} from "./types";

type ChildConnectionRouterDeps = {
  /** Extend the current invocation until detached work settles. */
  readonly waitUntil: (work: Promise<unknown>) => void;
  /** Send one message to the root that owns the sockets. */
  readonly sendToRoot: (message: DynamicAgentRouteMessage) => Promise<unknown>;
};

/**
 * Child-side routing of connection operations. A frame forwarded from the
 * parent carries a live bridge, valid until that frame completes;
 * operations issued later travel to the root as fresh messages. All
 * operations on one connection share a queue, broadcasts wait for older
 * queued operations, and failures do not block later work.
 */
export class ChildConnectionRouter {
  readonly #deps: ChildConnectionRouterDeps;
  readonly #bridgeContext =
    new AsyncLocalStorage<DynamicAgentBridgeInvocationContext>();
  readonly #connectionOperationTails = new Map<string, Promise<void>>();
  #broadcastOperationTail?: Promise<void>;

  constructor(deps: ChildConnectionRouterDeps) {
    this.#deps = deps;
  }

  /** Run `fn` with a forwarded frame's bridge as the live route for `connectionId`. */
  async runWithBridge<T>(
    bridge: DynamicAgentConnectionBridgeLike,
    connectionId: string,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const context: DynamicAgentBridgeInvocationContext = {
      bridge,
      connectionId
    };
    try {
      return await this.#bridgeContext.run(context, fn);
    } finally {
      // Detached work inherits this context, but a forwarded RPC bridge is
      // only valid until its originating connect, message, or close call
      // completes.
      context.bridge = undefined;
    }
  }

  activeBridge(
    connectionId?: string
  ): DynamicAgentConnectionBridgeLike | undefined {
    const context = this.#bridgeContext.getStore();
    if (connectionId !== undefined && context?.connectionId !== connectionId) {
      return undefined;
    }
    return context?.bridge;
  }

  /** The pending operation tail for a connection, if any. */
  operationTail(connectionId: string): Promise<void> | undefined {
    return this.#connectionOperationTails.get(connectionId);
  }

  /** The link WebSockets uses for a bridged connection with this id. */
  link(connectionId: string): BridgedConnectionLink {
    return {
      send: (message: WSMessage) =>
        this.routeConnectionOperation(connectionId, "send", (bridge) =>
          bridge.send(message)
        ),
      close: (code?: number, reason?: string) =>
        this.routeConnectionOperation(connectionId, "close", (bridge) =>
          bridge.close(code, reason)
        ),
      setState: (state: unknown) =>
        this.routeConnectionOperation(connectionId, "setState", (bridge) =>
          bridge.setState(state)
        ),
      setTags: (tags: readonly string[]) =>
        this.routeConnectionOperation(connectionId, "setTags", (bridge) =>
          bridge.setTags(tags)
        )
    };
  }

  routeConnectionOperation(
    connectionId: string,
    operationName: DynamicAgentConnectionOperationName,
    operation: (bridge: DynamicAgentConnectionBridgeLike) => unknown
  ): void {
    const activeBridge = this.activeBridge(connectionId);
    const previousConnectionOperation =
      this.#connectionOperationTails.get(connectionId);
    let pending: Promise<void>;
    if (activeBridge && !previousConnectionOperation) {
      try {
        pending = Promise.resolve(operation(activeBridge)).then(() => {});
      } catch (error) {
        pending = Promise.reject(error);
      }
    } else {
      pending = (previousConnectionOperation ?? Promise.resolve()).then(
        async () => {
          await operation(
            new RootDynamicAgentConnectionBridge(
              this.#deps.sendToRoot,
              connectionId
            )
          );
        }
      );
    }
    const completion = pending.catch((error: unknown) => {
      console.error("[Agent] Sub-agent connection operation failed:", {
        connectionId,
        operation: operationName,
        error
      });
    });

    this.#connectionOperationTails.set(connectionId, completion);
    this.#deps.waitUntil(completion);
    void completion.then(() => {
      if (this.#connectionOperationTails.get(connectionId) === completion) {
        this.#connectionOperationTails.delete(connectionId);
      }
    });
  }

  /**
   * Route a broadcast after every older connection operation.
   *
   * This barrier is intentionally one-way: startup can broadcast before a
   * connection has finished initializing its tags and protocol flags.
   * Making those later connection operations wait would let the next frame
   * observe stale root-owned metadata.
   */
  async routeBroadcast(
    ownerPath: ReadonlyArray<AgentPathStep>,
    message: WSMessage,
    without?: string[],
    upstreamBridge?: DynamicAgentConnectionBridgeLike
  ): Promise<void> {
    const activeBridge = upstreamBridge ?? this.activeBridge();
    const previousOperations = new Set([
      ...(this.#broadcastOperationTail ? [this.#broadcastOperationTail] : []),
      ...this.#connectionOperationTails.values()
    ]);
    let pending: Promise<void>;
    if (activeBridge && previousOperations.size === 0) {
      try {
        pending = Promise.resolve(
          activeBridge.broadcast(ownerPath, message, without)
        );
      } catch (error) {
        pending = Promise.reject(error);
      }
    } else {
      pending = Promise.all(previousOperations).then(async () => {
        await this.#deps.sendToRoot({
          type: "connection:broadcast",
          owner: ownerPath,
          message,
          without
        });
      });
    }
    const completion = pending.catch((error: unknown) => {
      console.error("[Agent] Sub-agent broadcast operation failed:", {
        operation: "broadcast",
        error
      });
    });

    this.#broadcastOperationTail = completion;
    this.#deps.waitUntil(completion);
    void completion.then(() => {
      if (this.#broadcastOperationTail === completion) {
        this.#broadcastOperationTail = undefined;
      }
    });
    await completion;
  }
}
