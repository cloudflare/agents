import PostalMime from "postal-mime";
import type {
  ChannelEmailIngress,
  ChannelEmailInput,
  ChannelInboundMessage
} from "./ingress";

export type InboundEmailOptions = {
  /** Only accept messages delivered to this address. */
  to?: string;
  /** Only accept these envelope senders. */
  from?: string | readonly string[];
};

function normalizeReference(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^<|>$/g, "");
  return normalized || undefined;
}

async function rawEmail(email: ChannelEmailInput): Promise<Uint8Array> {
  if (email.getRaw) return email.getRaw();
  if (email.raw) {
    return new Uint8Array(await new Response(email.raw).arrayBuffer());
  }
  throw new Error("Inbound email must provide raw or getRaw()");
}

async function contentReference(content: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(content.byteLength);
  bytes.set(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

/** Parse Workers Email events into normalized Channel ingress events. */
export function inboundEmail(
  options: InboundEmailOptions = {}
): ChannelEmailIngress {
  const recipient = options.to?.toLowerCase();
  const senders = new Set(
    (typeof options.from === "string"
      ? [options.from]
      : (options.from ?? [])
    ).map((sender) => sender.toLowerCase())
  );

  return {
    ...((recipient || senders.size > 0) && {
      accepts(email: ChannelEmailInput) {
        return (
          (!recipient || email.to.toLowerCase() === recipient) &&
          (senders.size === 0 || senders.has(email.from.toLowerCase()))
        );
      }
    }),
    async receive(email) {
      const content = await rawEmail(email);
      const parsed = await PostalMime.parse(content);
      const text = parsed.text?.trim() ?? "";
      const reference =
        normalizeReference(parsed.messageId) ??
        (await contentReference(content));
      const replyToReference = normalizeReference(parsed.inReplyTo);
      const senderAddress = parsed.from?.address ?? email.from;
      const sender = {
        id: senderAddress,
        ...(parsed.from?.name && { username: parsed.from.name })
      };

      const event: ChannelInboundMessage = {
        type: "message",
        text,
        reference,
        ...(replyToReference && {
          replyTo: { reference: replyToReference }
        }),
        sender
      };
      return { events: [event] };
    }
  };
}
