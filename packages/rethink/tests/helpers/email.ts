import type { EmailSendBinding } from "agents";

type StructuredEmailMessage = Extract<
  Parameters<EmailSendBinding["send"]>[0],
  { subject: string }
>;

export interface SentEmail {
  from: string;
  to: string | string[];
  subject: string;
  body: string;
  headers?: Record<string, string>;
}

export function mockEmailBinding(sentEmails: KVNamespace): EmailSendBinding {
  return {
    async send(message) {
      if (!isStructuredEmailMessage(message)) {
        throw new Error("Mock email binding only supports structured messages");
      }

      const messageId = crypto.randomUUID();
      await sentEmails.put(
        messageId,
        JSON.stringify({
          from: addressText(message.from),
          to: message.to,
          subject: message.subject,
          body: message.text ?? message.html ?? "",
          headers: message.headers
        } satisfies SentEmail)
      );
      return { messageId };
    }
  };
}

export async function listSentEmails(
  sentEmails: KVNamespace
): Promise<SentEmail[]> {
  const listed = await sentEmails.list();
  return Promise.all(
    listed.keys.map(async (key) => {
      const sent = await sentEmails.get<SentEmail>(key.name, "json");
      if (!sent) throw new Error(`Missing sent email ${key.name}`);
      return sent;
    })
  );
}

function isStructuredEmailMessage(
  message: EmailMessage | StructuredEmailMessage
): message is StructuredEmailMessage {
  return "subject" in message;
}

function addressText(
  address: string | { email: string; name?: string }
): string {
  return typeof address === "string" ? address : address.email;
}
