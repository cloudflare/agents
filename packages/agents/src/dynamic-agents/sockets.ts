import type { LifecycleSockets, WSMessage } from "../lifecycle";

/**
 * Internal keys the previous release stored inside a child-targeted
 * socket's `__user` attachment, when the WebSockets capability accepted
 * those sockets on the parent's behalf.
 *
 * Storage-frozen — never rename.
 */
export const CF_SUB_AGENT_OUTER_URL_KEY = "_cf_subAgentOuterUrl";
export const CF_SUB_AGENT_TAGS_KEY = "_cf_subAgentTags";

/**
 * Wire-frozen internal header carrying the outer `/sub/...` URL on an
 * upgrade that was rewritten before reaching the parent's socket path.
 */
export const SUB_AGENT_OUTER_URL_HEADER = "x-cf-agents-subagent-url";

/** The hibernation attachment DynamicAgents writes on sockets it accepts. */
const ATTACHMENT_KEY = "__cf_da";

type OwnedAttachment = {
  readonly id: string;
  readonly outer: string;
  readonly tags: string[];
  readonly state: unknown;
};

type LegacyAttachment = {
  __pk: { id: string; tags?: string[]; uri?: string };
  __user?: unknown;
};

/**
 * One root-owned socket addressed to a child: the parent's durable view
 * (outer URL, the child's tags and state) and the operations the child
 * bridges back to it.
 */
export type RootSocketRecord = {
  readonly ws: WebSocket;
  readonly id: string;
  /** The original `/sub/...` URL the client connected to. */
  readonly outer: string;
  readonly tags: readonly string[];
  readonly state: unknown;
  send(message: WSMessage): void;
  close(code?: number, reason?: string): void;
  setState(state: unknown): unknown;
  setTags(tags: readonly string[]): void;
};

function readAttachment(ws: WebSocket): unknown {
  try {
    return WebSocket.prototype.deserializeAttachment.call(ws) as unknown;
  } catch {
    return undefined;
  }
}

function writeAttachment(ws: WebSocket, attachment: unknown): void {
  WebSocket.prototype.serializeAttachment.call(ws, attachment);
}

function ownedRecord(ws: WebSocket, owned: OwnedAttachment): RootSocketRecord {
  let current = owned;
  const write = (next: OwnedAttachment) => {
    current = next;
    writeAttachment(ws, { [ATTACHMENT_KEY]: next });
  };
  return {
    ws,
    id: owned.id,
    outer: owned.outer,
    get tags() {
      return current.tags;
    },
    get state() {
      return current.state;
    },
    send: (message) => ws.send(message),
    close: (code, reason) => ws.close(code, reason),
    setState(state) {
      write({ ...current, state: state ?? null });
      return current.state;
    },
    setTags(tags) {
      write({ ...current, tags: [...tags] });
    }
  };
}

/**
 * A socket the previous release accepted through the WebSockets
 * capability: identity under `__pk`, the child's tags and state mixed
 * into `__user` beside the outer URL flag. Reads and writes keep that
 * shape so the socket stays valid across the upgrade.
 */
function legacyRecord(
  ws: WebSocket,
  attachment: LegacyAttachment,
  outer: string
): RootSocketRecord {
  let current = attachment;
  const user = () =>
    current.__user && typeof current.__user === "object"
      ? (current.__user as Record<string, unknown>)
      : {};
  const write = (nextUser: Record<string, unknown>) => {
    current = { ...current, __user: nextUser };
    writeAttachment(ws, current);
  };
  return {
    ws,
    id: attachment.__pk.id,
    outer,
    get tags() {
      const stored = user()[CF_SUB_AGENT_TAGS_KEY];
      return Array.isArray(stored)
        ? stored.filter((tag): tag is string => typeof tag === "string")
        : (current.__pk.tags ?? []);
    },
    get state() {
      const {
        [CF_SUB_AGENT_OUTER_URL_KEY]: _outer,
        [CF_SUB_AGENT_TAGS_KEY]: _tags,
        ...rest
      } = user();
      return Object.keys(rest).length > 0 ? rest : null;
    },
    send: (message) => ws.send(message),
    close: (code, reason) => ws.close(code, reason),
    setState(state) {
      const {
        [CF_SUB_AGENT_OUTER_URL_KEY]: storedOuter,
        [CF_SUB_AGENT_TAGS_KEY]: storedTags
      } = user();
      write({
        ...(state && typeof state === "object"
          ? (state as Record<string, unknown>)
          : {}),
        [CF_SUB_AGENT_OUTER_URL_KEY]: storedOuter,
        ...(storedTags !== undefined
          ? { [CF_SUB_AGENT_TAGS_KEY]: storedTags }
          : {})
      });
      return this.state;
    },
    setTags(tags) {
      write({ ...user(), [CF_SUB_AGENT_TAGS_KEY]: [...tags] });
    }
  };
}

/** The record for a socket DynamicAgents owns, or null for any other socket. */
export function ownedSocket(ws: WebSocket): RootSocketRecord | null {
  const attachment = readAttachment(ws);
  if (!attachment || typeof attachment !== "object") return null;
  const owned = (attachment as { [ATTACHMENT_KEY]?: unknown })[ATTACHMENT_KEY];
  if (owned && typeof owned === "object") {
    const { id, outer } = owned as Partial<OwnedAttachment>;
    if (typeof id === "string" && typeof outer === "string") {
      return ownedRecord(ws, owned as OwnedAttachment);
    }
    return null;
  }
  const legacy = attachment as Partial<LegacyAttachment>;
  const outer =
    legacy.__user && typeof legacy.__user === "object"
      ? (legacy.__user as Record<string, unknown>)[CF_SUB_AGENT_OUTER_URL_KEY]
      : undefined;
  if (
    legacy.__pk &&
    typeof legacy.__pk === "object" &&
    typeof legacy.__pk.id === "string" &&
    typeof outer === "string"
  ) {
    return legacyRecord(ws, legacy as LegacyAttachment, outer);
  }
  return null;
}

/** Whether a socket carries the legacy `__user` outer-URL flag. */
export function isLegacyChildSocket(ws: WebSocket): boolean {
  const attachment = readAttachment(ws) as
    | Partial<LegacyAttachment>
    | undefined;
  const user = attachment?.__user;
  return (
    !!user &&
    typeof user === "object" &&
    typeof (user as Record<string, unknown>)[CF_SUB_AGENT_OUTER_URL_KEY] ===
      "string"
  );
}

/** Accept a child-targeted socket into hibernation under DynamicAgents' namespace. */
export function acceptOwnedSocket(
  sockets: LifecycleSockets,
  ws: WebSocket,
  attachment: OwnedAttachment
): RootSocketRecord {
  sockets.accept(ws, [attachment.id]);
  writeAttachment(ws, { [ATTACHMENT_KEY]: attachment });
  return ownedRecord(ws, attachment);
}

/** Every open socket DynamicAgents owns on this object. */
export function* ownedSockets(
  sockets: LifecycleSockets
): IterableIterator<RootSocketRecord> {
  for (const ws of sockets.get()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const record = ownedSocket(ws);
    if (record) yield record;
  }
}

/** One owned socket by connection id, if open. */
export function ownedSocketById(
  sockets: LifecycleSockets,
  id: string
): RootSocketRecord | undefined {
  for (const ws of sockets.get(id)) {
    const record = ownedSocket(ws);
    if (record?.id === id) return record;
  }
  return undefined;
}
