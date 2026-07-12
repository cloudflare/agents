export interface EmailMessage {
  from: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}
