import { usePartySocket } from "partysocket/react";
import { useEffect, useMemo, useRef } from "react";
import { CapnWebAgentClient } from "./capnweb-client";

/**
 * WebSocket transport carrying all Agent traffic for `useAgent`.
 *
 * - `"hibernating"` (default): the existing PartySocket protocol socket.
 *   Server-side connections use the Hibernation API, so idle Agents can
 *   be evicted from memory without dropping clients.
 * - `"capnweb"`: the same Agent protocol frames travel over a single
 *   Cap'n Web RPC socket. The server connection is non-hibernating: the
 *   Agent stays pinned in memory while clients are connected.
 */
export type AgentTransport = "hibernating" | "capnweb";

type SocketProtocols = Parameters<typeof usePartySocket>[0]["protocols"];

/** Mirrors PartySocket's plain-`ws` heuristic for private/local hosts. */
function isLocalHost(host: string): boolean {
  if (
    host.startsWith("localhost:") ||
    host.startsWith("127.0.0.1:") ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    host.startsWith("[::ffff:7f00:1]:")
  ) {
    return true;
  }
  if (!host.startsWith("172.")) return false;
  // Numeric comparison, deliberately diverging from PartySocket's
  // string comparison, which misclassifies hosts like 172.3.x and
  // 172.200.x as private and downgrades them to ws://.
  const second = Number(host.split(".")[1]);
  return second >= 16 && second <= 31;
}

/** The addressing pieces `useAgent` resolves for a socket URL. */
export type AgentUrlParts = {
  host: string | undefined;
  protocol: "ws" | "wss" | undefined;
  basePath: string | undefined;
  agentNamespace: string;
  room: string;
  path: string | undefined;
  query: Record<string, string | null> | undefined;
};

/**
 * Build the same socket URL PartySocket would — including query
 * parameters and the `_pk` connection id — so both transports address
 * the identical server route.
 */
function buildAgentSocketUrl(parts: AgentUrlParts, id: string): string {
  let host =
    parts.host ||
    (typeof window !== "undefined" ? window.location.host : "dummy-domain.com");
  host = host.replace(/^(http|https|ws|wss):\/\//, "");
  if (host.endsWith("/")) host = host.slice(0, -1);
  if (parts.path?.startsWith("/")) {
    throw new Error("path must not start with a slash");
  }
  const protocol = parts.protocol || (isLocalHost(host) ? "ws" : "wss");
  const path = parts.path ? `/${parts.path}` : "";
  const baseUrl = `${protocol}://${host}/${
    parts.basePath || `agents/${parts.agentNamespace}/${parts.room}`
  }${path}`;
  const params = new URLSearchParams([
    ["_pk", id],
    ...Object.entries(parts.query ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== null && entry[1] !== undefined
    )
  ]);
  return `${baseUrl}?${params}`;
}

function generateConnectionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/** Connection options and handlers for {@link useCapnWebAgentSocket}. */
export type CapnWebSocketConfig = {
  enabled: boolean;
  urlParts: AgentUrlParts;
  protocols: SocketProtocols;
  minReconnectionDelay: number | undefined;
  maxReconnectionDelay: number | undefined;
  shouldReconnectOnClose(event: CloseEvent): boolean;
  onOpen(event: Event): void;
  onMessage(event: MessageEvent): void;
  onClose(event: CloseEvent): void;
  onError(event: Event): void;
};

/**
 * Owns a `CapnWebAgentClient` with `useStableSocket`-like semantics: the
 * client is replaced when connection options change and connects/closes
 * with `enabled`. Handlers are read through a ref so the latest render's
 * callbacks always run without recreating the client.
 */
export function useCapnWebAgentSocket(
  config: CapnWebSocketConfig
): CapnWebAgentClient {
  const { enabled, urlParts } = config;
  const configRef = useRef(config);
  configRef.current = config;

  const memoKey = JSON.stringify([
    urlParts.host ?? null,
    urlParts.protocol ?? null,
    urlParts.basePath ?? null,
    urlParts.agentNamespace,
    urlParts.room,
    urlParts.path ?? null,
    urlParts.query ?? null,
    typeof config.protocols === "function" ? "fn" : (config.protocols ?? null),
    config.minReconnectionDelay ?? null,
    config.maxReconnectionDelay ?? null
  ]);

  const client = useMemo(() => {
    const id = generateConnectionId();
    const current = configRef.current;
    return new CapnWebAgentClient({
      id,
      url: buildAgentSocketUrl(current.urlParts, id),
      protocols: async () => {
        const provided = configRef.current.protocols;
        const value =
          typeof provided === "function" ? await provided() : provided;
        return value ?? null;
      },
      shouldReconnectOnClose: (event) =>
        configRef.current.shouldReconnectOnClose(event),
      minReconnectionDelay: current.minReconnectionDelay,
      maxReconnectionDelay: current.maxReconnectionDelay
    });
    // The memo key is the serialized connection options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoKey]);

  useEffect(() => {
    const onOpen = (event: Event) => configRef.current.onOpen(event);
    const onMessage = (event: Event) =>
      configRef.current.onMessage(event as MessageEvent);
    const onClose = (event: Event) =>
      configRef.current.onClose(event as CloseEvent);
    const onError = (event: Event) => configRef.current.onError(event);
    client.addEventListener("open", onOpen);
    client.addEventListener("message", onMessage);
    client.addEventListener("close", onClose);
    client.addEventListener("error", onError);
    return () => {
      client.removeEventListener("open", onOpen);
      client.removeEventListener("message", onMessage);
      client.removeEventListener("close", onClose);
      client.removeEventListener("error", onError);
    };
  }, [client]);

  useEffect(() => {
    if (!enabled) return;
    client.connect();
    return () => client.close(1000, "Connection replaced");
  }, [client, enabled]);

  return client;
}
