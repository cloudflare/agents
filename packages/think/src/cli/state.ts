import type { UIMessage } from "ai";
import { CHAT_MESSAGE_TYPES } from "agents/chat";
import {
  type ConnectOptions,
  connectToThinkAgent,
  waitForClientReady
} from "./connect";

/** Minimal structural view of the socket the state snapshot needs. */
interface MessageSocket {
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void
  ): void;
}

export type StateCommandOptions = ConnectOptions & {
  /** Emit a single machine-readable JSON object. */
  json?: boolean;
  /** Number of recent messages to include. Defaults to 10. */
  limit?: number;
};

const SNAPSHOT_WAIT_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(message: UIMessage): string {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

export async function stateCommand(
  options: StateCommandOptions
): Promise<void> {
  const { client, target } = await connectToThinkAgent(options);
  const socket = client as unknown as MessageSocket;

  let messages: UIMessage[] = [];
  let gotSnapshot = false;
  const listener = (event: { data: unknown }) => {
    if (typeof event.data !== "string") return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (
      frame.type === CHAT_MESSAGE_TYPES.CHAT_MESSAGES &&
      Array.isArray(frame.messages)
    ) {
      messages = frame.messages as UIMessage[];
      gotSnapshot = true;
    }
  };
  socket.addEventListener("message", listener);

  try {
    await waitForClientReady(client);
  } catch (error) {
    socket.removeEventListener("message", listener);
    client.close();
    throw error;
  }

  // Identity arrives with `ready`; the history snapshot and state broadcast
  // follow shortly after. Wait a beat for them (no server changes needed —
  // we only read connect-time frames).
  const deadline = Date.now() + SNAPSHOT_WAIT_MS;
  while (!gotSnapshot && Date.now() < deadline) {
    await delay(50);
  }
  socket.removeEventListener("message", listener);

  const limit = options.limit ?? 10;
  const recent = limit > 0 ? messages.slice(-limit) : messages;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          agent: client.agent,
          name: client.name,
          state: client.state ?? null,
          messages: recent
        },
        null,
        2
      )
    );
    client.close();
    return;
  }

  const scheme = target.protocol === "wss" ? "https" : "http";
  const lines = [
    "Think state",
    `Endpoint: ${scheme}://${target.host}/${target.basePath}`,
    `Agent: ${client.agent}`,
    `Instance: ${client.name}`,
    "",
    "State:",
    client.state === undefined
      ? "- none"
      : indent(JSON.stringify(client.state, null, 2)),
    "",
    `Recent messages (${recent.length}):`,
    ...(recent.length === 0
      ? ["- none"]
      : recent.map((message) => {
          const text = messageText(message).trim();
          return `- ${message.role}: ${text || "(no text)"}`;
        }))
  ];
  console.log(lines.join("\n"));
  client.close();
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
