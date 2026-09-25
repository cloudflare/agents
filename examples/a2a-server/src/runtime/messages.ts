import { Artifact, Message, Role, type Part } from "@a2a-js/sdk";
import { canonicalJson } from "./canonical-json";
import { validateArtifactValue } from "./json-validation";
import type { A2AConversationTurn } from "./types";

/** Client messages may not use this namespace reserved for runtime messages. */
export const SERVER_MESSAGE_ID_PREFIX = "__a2a_server__:";

/** Builds an SDK text part with the protocol's required default fields. */
export function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    filename: "",
    mediaType: "text/plain",
    metadata: {}
  };
}

/** Builds an SDK data part containing JSON-compatible structured output. */
export function dataPart(value: unknown): Part {
  return {
    content: { $case: "data", value },
    filename: "",
    mediaType: "application/json",
    metadata: {}
  };
}

/** Wraps generated text as a complete A2A artifact. */
export function textArtifact(
  artifactId: string,
  name: string,
  description: string,
  text: string
): Artifact {
  return {
    artifactId,
    name,
    description,
    parts: [textPart(text)],
    metadata: {},
    extensions: []
  };
}

/** Builds a deterministic agent message so callback retries do not duplicate history. */
export function agentMessage(
  taskId: string,
  contextId: string,
  text: string,
  key = "response"
): Message {
  return {
    messageId: `${SERVER_MESSAGE_ID_PREFIX}${taskId}.${key}`,
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: []
  };
}

/** Rejects a client-controlled ID that could collide with a server message. */
export function validateClientMessageId(messageId: string): string {
  if (messageId.startsWith(SERVER_MESSAGE_ID_PREFIX)) {
    throw new Error(
      `messageId must not start with the reserved prefix ${SERVER_MESSAGE_ID_PREFIX}`
    );
  }
  return messageId;
}

/** Derives a stable identity for callbacks created before publication IDs existed. */
export async function deriveArtifactPublicationId(
  taskId: string,
  artifact: Artifact,
  turn: number
): Promise<string> {
  validateArtifactValue(artifact, "Artifact publication artifact");
  const serialized = canonicalJson({
    taskId,
    artifact: Artifact.toJSON(artifact),
    turn
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized)
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return `derived:${btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
}

/** Concatenates the text parts of an A2A message. */
export function messageText(message: Message): string {
  return message.parts
    .flatMap((part) =>
      part.content?.$case === "text" ? [part.content.value] : []
    )
    .join("\n")
    .trim();
}

/** Projects A2A history into the compact conversation passed to Workflows. */
export function conversationHistory(
  messages: Message[]
): A2AConversationTurn[] {
  const conversation: A2AConversationTurn[] = [];
  for (const message of messages) {
    const text = messageText(message);
    if (!text) continue;
    if (message.role === Role.ROLE_USER)
      conversation.push({ role: "user", text });
    if (message.role === Role.ROLE_AGENT)
      conversation.push({ role: "agent", text });
  }
  return conversation;
}

/** Canonicalizes accepted input for messageId replay and conflict detection. */
export function messageFingerprint(
  message: Message,
  contextId: string,
  taskId: string
): string {
  return canonicalJson(Message.toJSON({ ...message, contextId, taskId }));
}
