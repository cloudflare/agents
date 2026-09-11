import type {
  LifecycleRouteAddress,
  LifecycleRouteEnvelope,
  WSMessage
} from "../lifecycle";
import type { AgentPathStep } from "../sub-routing";
import type { DynamicAgentConnectionBridge } from "./bridges";
import type { DynamicAgentConnectionMeta, DynamicAgentRef } from "./types";

/** The capability id every dynamic-agents envelope is addressed to. */
export const DYNAMIC_AGENTS_CAPABILITY_ID = "dynamic-agents";

/**
 * Messages the DynamicAgents capability exchanges between a parent and
 * its children over the host's `_cf_lifecycle` aperture. Bridges ride by
 * reference: envelopes travel over native RPC, which serializes
 * `RpcTarget` members as stubs.
 */
export type DynamicAgentRouteMessage =
  /** Continue a routed envelope one hop toward its target. */
  | {
      readonly type: "forward";
      readonly target: LifecycleRouteAddress;
      readonly envelope: LifecycleRouteEnvelope;
    }
  /** Establish a fresh child's identity (sent with `bootstrap: true`). */
  | {
      readonly type: "init";
      readonly name: string;
      readonly parentPath: ReadonlyArray<AgentPathStep>;
      readonly identityName: string;
    }
  /** Invoke a host method at an absolute, root-first path. */
  | {
      readonly type: "invoke";
      readonly path: ReadonlyArray<AgentPathStep>;
      readonly method: string;
      readonly args: unknown[];
    }
  /** Invoke a method on an immediate child (from outside the tree). */
  | {
      readonly type: "invoke:child";
      readonly child: DynamicAgentRef;
      readonly method: string;
      readonly args: unknown[];
    }
  /**
   * Invoke a stub method along a path relative to the receiver; the last
   * hop is a real RPC on the target's stub.
   */
  | {
      readonly type: "invoke:path";
      readonly path: ReadonlyArray<AgentPathStep>;
      readonly method: string;
      readonly args: unknown[];
    }
  /** Tear down a strict descendant. */
  | { readonly type: "destroy"; readonly target: ReadonlyArray<AgentPathStep> }
  /** Retire a subtree's root-owned mirrors. */
  | { readonly type: "retire"; readonly prefix: ReadonlyArray<AgentPathStep> }
  | {
      readonly type: "keepalive:acquire";
      readonly owner: ReadonlyArray<AgentPathStep>;
    }
  | { readonly type: "keepalive:release"; readonly token: string }
  | {
      readonly type: "lease:register";
      readonly owner: ReadonlyArray<AgentPathStep>;
      readonly id: string;
    }
  | {
      readonly type: "lease:unregister";
      readonly owner: ReadonlyArray<AgentPathStep>;
      readonly id: string;
    }
  /** Ask the object at `owner` to recover its leases; returns how many remain. */
  | {
      readonly type: "lease:check";
      readonly owner: ReadonlyArray<AgentPathStep>;
    }
  | {
      readonly type: "connection:send";
      readonly id: string;
      readonly message: WSMessage;
    }
  | {
      readonly type: "connection:close";
      readonly id: string;
      readonly code?: number;
      readonly reason?: string;
    }
  | {
      readonly type: "connection:setState";
      readonly id: string;
      readonly state: unknown;
    }
  | {
      readonly type: "connection:setTags";
      readonly id: string;
      readonly tags: readonly string[];
    }
  /** Every root-owned connection addressed to `owner`. */
  | {
      readonly type: "connection:metas";
      readonly owner: ReadonlyArray<AgentPathStep>;
    }
  | {
      readonly type: "connection:broadcast";
      readonly owner: ReadonlyArray<AgentPathStep>;
      readonly message: WSMessage;
      readonly without?: string[];
    }
  | {
      readonly type: "ws:connect";
      readonly meta: DynamicAgentConnectionMeta;
      readonly bridge: DynamicAgentConnectionBridge;
    }
  | {
      readonly type: "ws:message";
      readonly meta: DynamicAgentConnectionMeta;
      readonly message: WSMessage;
      readonly bridge: DynamicAgentConnectionBridge;
      readonly replyBridge?: DynamicAgentConnectionBridge;
    }
  | {
      readonly type: "ws:close";
      readonly meta: DynamicAgentConnectionMeta;
      readonly code: number;
      readonly reason: string;
      readonly wasClean: boolean;
      readonly bridge: DynamicAgentConnectionBridge;
    };

export type DynamicAgentRouteMessageType = DynamicAgentRouteMessage["type"];

const MESSAGE_TYPES: ReadonlySet<string> =
  new Set<DynamicAgentRouteMessageType>([
    "forward",
    "init",
    "invoke",
    "invoke:child",
    "invoke:path",
    "destroy",
    "retire",
    "keepalive:acquire",
    "keepalive:release",
    "lease:register",
    "lease:unregister",
    "lease:check",
    "connection:send",
    "connection:close",
    "connection:setState",
    "connection:setTags",
    "connection:metas",
    "connection:broadcast",
    "ws:connect",
    "ws:message",
    "ws:close"
  ]);

export function isDynamicAgentRouteMessage(
  payload: unknown
): payload is DynamicAgentRouteMessage {
  if (!payload || typeof payload !== "object") return false;
  const type = (payload as { type?: unknown }).type;
  return typeof type === "string" && MESSAGE_TYPES.has(type);
}
