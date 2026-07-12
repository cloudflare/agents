import { defaultIdSource, type IdSource } from "../../kernel/ids.js";
import type { EmailMessage, EmailTransport } from "../../ports/email.js";

export interface MemoryEmailTransport extends EmailTransport {
  readonly sent: Array<EmailMessage & { messageId: string }>;
}

export function createMemoryEmailTransport(idSource: IdSource = defaultIdSource): MemoryEmailTransport {
  const sent: Array<EmailMessage & { messageId: string }> = [];

  return {
    sent,
    async send(message: EmailMessage): Promise<{ messageId: string }> {
      const messageId = idSource.newId("email");
      sent.push({ ...message, messageId });
      return { messageId };
    },
  };
}
