import type { ClientToolSchema } from "./client-tools";

/**
 * The minimal transcript-tail shape {@link createChatFiberSnapshot} reads to
 * derive the snapshot's `latest*Id` markers. Deliberately NOT `UIMessage`: the
 * snapshot only ever needs each message's `id` + `role`, so any host transcript
 * (AI SDK `UIMessage[]`, `Think`'s session leaves, or the pi adapter's plain
 * `AgentMessage[]`) satisfies it structurally. Keeping this off `UIMessage` is
 * the Phase-5 genericity seam — the snapshot builder must not couple to the AI
 * SDK message shape.
 */
export interface SnapshotMessage {
  id?: string;
  role: string;
}

export type ChatFiberSnapshot<Kind extends string = string> = {
  kind: Kind;
  version: 1;
  requestId: string;
  recoveryRootRequestId?: string;
  continuation: boolean;
  latestMessageId?: string;
  latestMessageRole?: string;
  latestUserMessageId?: string;
  startedAt: number;
  lastBody?: Record<string, unknown>;
  lastClientTools?: ClientToolSchema[];
};

export function createChatFiberSnapshot<Kind extends string>({
  kind,
  requestId,
  recoveryRootRequestId,
  continuation,
  messages,
  lastBody,
  lastClientTools
}: {
  kind: Kind;
  requestId: string;
  recoveryRootRequestId?: string;
  continuation: boolean;
  messages: ReadonlyArray<SnapshotMessage>;
  lastBody?: Record<string, unknown>;
  lastClientTools?: ClientToolSchema[];
}): ChatFiberSnapshot<Kind> {
  const latestMessage =
    messages.length > 0 ? messages[messages.length - 1] : undefined;
  let latestUser: SnapshotMessage | undefined;

  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      latestUser = messages[index];
      break;
    }
  }

  return {
    kind,
    version: 1,
    requestId,
    recoveryRootRequestId,
    continuation,
    latestMessageId: latestMessage?.id,
    latestMessageRole: latestMessage?.role,
    latestUserMessageId: latestUser?.id,
    startedAt: Date.now(),
    lastBody,
    lastClientTools
  };
}

export function wrapChatFiberSnapshot<Kind extends string>(
  key: string,
  snapshot: ChatFiberSnapshot<Kind>,
  user: unknown | null
): Record<string, unknown> {
  return { [key]: snapshot, user };
}

export function unwrapChatFiberSnapshot<Kind extends string>(
  key: string,
  value: unknown,
  expectedKind?: Kind
): {
  snapshot: ChatFiberSnapshot<Kind> | null;
  user: unknown | null;
} {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return { snapshot: null, user: value };
  }

  const envelope = value as Record<string, unknown>;
  const snapshot = envelope[key];
  if (typeof snapshot !== "object" || snapshot === null) {
    return { snapshot: null, user: value };
  }
  const candidate = snapshot as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    (expectedKind !== undefined && candidate.kind !== expectedKind) ||
    typeof candidate.requestId !== "string" ||
    typeof candidate.continuation !== "boolean"
  ) {
    return { snapshot: null, user: value };
  }

  return {
    snapshot: snapshot as ChatFiberSnapshot<Kind>,
    user: envelope.user ?? null
  };
}
