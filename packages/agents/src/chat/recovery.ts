import type { UIMessage } from "ai";
import type { ClientToolSchema } from "./client-tools";

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
  messages: UIMessage[];
  lastBody?: Record<string, unknown>;
  lastClientTools?: ClientToolSchema[];
}): ChatFiberSnapshot<Kind> {
  const latestMessage =
    messages.length > 0 ? messages[messages.length - 1] : undefined;
  let latestUser: UIMessage | undefined;

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
