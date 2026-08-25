import PostalMime from "postal-mime";
import type {
  Attachment as PostalMimeAttachment,
  Email as PostalMimeEmail,
  Header as PostalMimeHeader
} from "postal-mime";
import type {
  EmailMessageSurfaceInput,
  EmailSurfaceAddress,
  EmailSurfaceRecipients
} from "./email-surface";
import { utf8ByteLength } from "../../internal";
import type {
  ChannelAttachment,
  ChannelEmailIngress,
  ChannelEmailInput,
  ChannelInboundMessageInput
} from "../../ingress";

/** Parsed, provider-specific email retained while selecting an application route. */
export type InboundEmailRaw = PostalMimeEmail;

const EMAIL_HEADER_VALUE_LIMIT = 2048;

export type InboundEmailOptions = {
  /** Only accept messages delivered to this address. */
  to?: string;
  /** Only accept these envelope senders. */
  from?: string | readonly string[];
  /** Outbound sender to retain in normalized reply surfaces. */
  replyFrom?: EmailSurfaceAddress;
};

function normalizeReference(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^<|>$/g, "");
  return normalized || undefined;
}

function emailReferences(value: string | undefined): string[] {
  const bracketed = value?.match(/<([^<>]+)>/g);
  const values = bracketed ?? value?.trim().split(/\s+/) ?? [];
  return values.flatMap((reference) => {
    const normalized = normalizeReference(reference);
    return normalized ? [normalized] : [];
  });
}

function firstReference(value: string | undefined): string | undefined {
  return emailReferences(value)[0];
}

function boundedReferences(references: readonly string[]): string[] {
  const unique = [...new Set(references.filter(Boolean))];
  if (unique.length < 2) return unique;
  const first = unique.at(0);
  if (!first) return [];
  const selected = [first];
  for (let index = unique.length - 1; index > 0; index -= 1) {
    const candidate = unique.at(index);
    if (!candidate) continue;
    const header = [...selected, candidate]
      .map((reference) => `<${reference}>`)
      .join(" ");
    if (utf8ByteLength(header) <= EMAIL_HEADER_VALUE_LIMIT) {
      selected.splice(1, 0, candidate);
    }
  }
  return selected;
}

function isAutoReply(headers: readonly PostalMimeHeader[]): boolean {
  return headers.some((header) => {
    const key = header.key.toLowerCase();
    const value = header.value.trim().toLowerCase();
    if (key === "auto-submitted") return value !== "no";
    if (key === "x-auto-response-suppress") return true;
    return (
      key === "precedence" &&
      (value === "bulk" || value === "junk" || value === "list")
    );
  });
}

function attachmentSize(content: PostalMimeAttachment["content"]): number {
  return typeof content === "string"
    ? utf8ByteLength(content)
    : content.byteLength;
}

function normalizedAttachment(
  attachment: PostalMimeAttachment
): ChannelAttachment {
  return {
    ...(normalizeReference(attachment.contentId) && {
      id: normalizeReference(attachment.contentId)
    }),
    mediaType: attachment.mimeType,
    ...(attachment.filename && { name: attachment.filename }),
    size: attachmentSize(attachment.content),
    ...(typeof attachment.content === "string" &&
      attachment.mimeType.startsWith("text/") && {
        text: attachment.content
      })
  };
}

function replyRecipients(
  replyTo: InboundEmailRaw["replyTo"]
): EmailSurfaceRecipients | undefined {
  const recipients = (replyTo ?? []).flatMap((entry) =>
    entry.address
      ? [{ email: entry.address, name: entry.name }]
      : (entry.group ?? []).map((mailbox) => ({
          email: mailbox.address,
          name: mailbox.name
        }))
  );
  return recipients.length > 0 ? recipients : undefined;
}

function recipientLabel(recipients: EmailSurfaceRecipients): string {
  const values = Array.isArray(recipients) ? recipients : [recipients];
  return values
    .map((recipient) =>
      typeof recipient === "string"
        ? recipient
        : recipient.name
          ? `${recipient.name} <${recipient.email}>`
          : recipient.email
    )
    .join(", ");
}

function normalizedDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
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
): ChannelEmailIngress<InboundEmailRaw> {
  const recipient = options.to?.toLowerCase();
  const senders = new Set(
    (typeof options.from === "string"
      ? [options.from]
      : (options.from ?? [])
    ).map((sender) => sender.toLowerCase())
  );

  return {
    async receive(email) {
      const accepted =
        (!recipient || email.to.toLowerCase() === recipient) &&
        (senders.size === 0 || senders.has(email.from.toLowerCase()));
      if (!accepted) return null;

      const content = await rawEmail(email);
      const parsed = await PostalMime.parse(content);
      const text = parsed.text?.trim() ?? "";
      const reference =
        normalizeReference(parsed.messageId) ??
        (await contentReference(content));
      const replyReference = normalizeReference(parsed.inReplyTo);
      const threadRoot =
        firstReference(parsed.references) ?? replyReference ?? reference;
      const senderAddress = parsed.from?.address ?? email.from;
      const sentAt = normalizedDate(parsed.date);
      const references = boundedReferences([
        ...emailReferences(parsed.references),
        reference
      ]);
      const replyTo = replyRecipients(parsed.replyTo) ?? senderAddress;
      const replySurface: EmailMessageSurfaceInput = {
        version: 1,
        address: {
          from: options.replyFrom ?? email.to,
          to: replyTo,
          ...(parsed.subject && { subject: parsed.subject }),
          inReplyTo: reference,
          references: [...new Set(references)]
        },
        label: `Email · ${recipientLabel(replyTo)}`
      };

      const event: ChannelInboundMessageInput = {
        type: "message",
        eventId: reference,
        thread: {
          id: threadRoot,
          isDirectMessage: "unknown"
        },
        replySurface,
        actor: {
          id: senderAddress,
          identity: {
            subject: senderAddress.toLowerCase()
          },
          ...(parsed.from?.name && { fullName: parsed.from.name })
        },
        message: {
          id: reference,
          text,
          ...(parsed.subject && { title: parsed.subject }),
          attachments: parsed.attachments.map(normalizedAttachment),
          ...(replyReference && { reply: { id: replyReference } }),
          metadata: {
            ...(sentAt && { sentAt }),
            autoReply: isAutoReply(parsed.headers)
          }
        }
      };
      return { events: [{ event, raw: parsed }] };
    }
  };
}
