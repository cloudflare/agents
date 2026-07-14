import { createMimeMessage } from "mimetext/browser";

import type {
  EmailMessage as PortEmailMessage,
  EmailTransport
} from "../../ports/email.js";

export type CloudflareEmailMessageFactory = (
  from: string,
  to: string,
  raw: string
) => unknown | Promise<unknown>;

export interface EmailTransportOptions {
  from?: string;
  messageFactory?: CloudflareEmailMessageFactory;
  idSource?: () => string;
}

export interface BuiltEmailMessage {
  from: string;
  to: string;
  raw: string;
  messageId: string;
}

const DEFAULT_FROM = "demo@example.com";

async function defaultMessageFactory(
  from: string,
  to: string,
  raw: string
): Promise<unknown> {
  const { EmailMessage: CloudflareEmailMessage } = await import(
    "cloudflare:email"
  );
  return new CloudflareEmailMessage(from, to, raw);
}

function defaultIdSource(): string {
  return crypto.randomUUID();
}

export function buildMimeEmail(
  message: PortEmailMessage,
  defaults: { from?: string; idSource?: () => string } = {}
): BuiltEmailMessage {
  const from = message.from || defaults.from || DEFAULT_FROM;
  const to = message.to;
  const messageId = `<${defaults.idSource?.() ?? defaultIdSource()}@agents-rebuild.local>`;
  const mime = createMimeMessage();

  mime.setSender(from);
  mime.setRecipients(to);
  mime.setHeader("Message-ID", messageId);
  if (message.subject !== undefined) mime.setSubject(message.subject);
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (name.toLowerCase() === "message-id") continue;
    mime.setHeader(name, value);
  }
  if (message.text !== undefined) {
    mime.addMessage({ contentType: "text/plain", data: message.text });
  }
  if (message.html !== undefined) {
    mime.addMessage({ contentType: "text/html", data: message.html });
  }

  return { from, to, raw: mime.asRaw(), messageId };
}

export function createEmailTransport(
  binding: { send(message: unknown): Promise<void> },
  defaults: { from?: string } = {},
  options: Omit<EmailTransportOptions, "from"> = {}
): EmailTransport {
  const messageFactory = options.messageFactory ?? defaultMessageFactory;
  const idSource = options.idSource ?? defaultIdSource;

  return {
    async send(message): Promise<{ messageId: string }> {
      const built = buildMimeEmail(message, {
        from: defaults.from,
        idSource
      });
      await binding.send(await messageFactory(built.from, built.to, built.raw));
      return { messageId: built.messageId };
    }
  };
}
