import { Agent, callable, routeAgentEmail, routeAgentRequest } from "agents";
import {
  createAddressBasedEmailResolver,
  createSecureReplyEmailResolver,
  isAutoReplyEmail,
  type AgentEmail
} from "agents/email";
import PostalMime from "postal-mime";

const MAX_EMAILS = 25;
const SENDER_NAME = "Email Service Agent";

type DeliveryMethod = "email-service" | "reply-to-email";

export interface EmailRecord {
  id: string;
  direction: "inbound" | "outbound";
  method: DeliveryMethod;
  simulated: boolean;
  secureReply: boolean;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  timestamp: string;
  messageId?: string;
  headers: Record<string, string>;
}

export interface EmailServiceState {
  inbox: EmailRecord[];
  outbox: EmailRecord[];
  totalReceived: number;
  totalSent: number;
  autoReplyEnabled: boolean;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string;
}

export type SendEmailResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

interface SimulatedEmailPayload {
  from: string;
  to: string;
  subject: string;
  body: string;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    headers
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function trimToRecent(
  records: EmailRecord[],
  record: EmailRecord
): EmailRecord[] {
  return [...records.slice(-(MAX_EMAILS - 1)), record];
}

function getMailboxId(address: string): string {
  const [localPart = address] = address.split("@");
  return localPart.toLowerCase();
}

function getEmailSecret(env: unknown): string | null {
  if (!isRecord(env)) {
    return null;
  }

  const emailSecret = env.EMAIL_SECRET;

  return typeof emailSecret === "string" && emailSecret.trim().length > 0
    ? emailSecret
    : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textToHtml(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br />");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (
      "code" in error &&
      typeof error.code === "string" &&
      error.code.length > 0
    ) {
      return `${error.code}: ${error.message}`;
    }
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return "Unknown error";
}

function normalizeEmailPayload(
  payload: unknown,
  mailboxAddress: string
): SimulatedEmailPayload | null {
  if (!isRecord(payload)) {
    return null;
  }

  const from = typeof payload.from === "string" ? payload.from.trim() : "";
  const to =
    typeof payload.to === "string" && payload.to.trim().length > 0
      ? payload.to.trim()
      : mailboxAddress;
  const subject =
    typeof payload.subject === "string" ? payload.subject.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";

  if (!from || !to || !subject || !body) {
    return null;
  }

  return { from, to, subject, body };
}

function createMockEmail(
  payload: SimulatedEmailPayload
): ForwardableEmailMessage {
  const messageId = `<simulated-${crypto.randomUUID()}@example.local>`;
  const rawEmail = [
    `From: ${payload.from}`,
    `To: ${payload.to}`,
    `Subject: ${payload.subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "X-Example-Simulated: true",
    "Content-Type: text/plain; charset=utf-8",
    "",
    payload.body
  ].join("\r\n");

  return {
    from: payload.from,
    to: payload.to,
    headers: new Headers({
      subject: payload.subject,
      "Message-ID": messageId,
      "X-Example-Simulated": "true"
    }),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(rawEmail));
        controller.close();
      }
    }),
    rawSize: rawEmail.length,
    reply: async (_message: EmailMessage) => ({
      messageId: `mock-reply-${crypto.randomUUID()}`
    }),
    forward: async (_rcptTo: string, _headers?: Headers) => ({
      messageId: `mock-forward-${crypto.randomUUID()}`
    }),
    setReject: (_reason: string) => {}
  };
}

async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const emailSecret = getEmailSecret(env);
  const addressResolver = createAddressBasedEmailResolver("EmailServiceAgent");

  await routeAgentEmail(message, env, {
    resolver: async (email, workerEnv) => {
      if (emailSecret) {
        const secureResolver = createSecureReplyEmailResolver(emailSecret);
        const secureReply = await secureResolver(email, workerEnv);
        if (secureReply) {
          return secureReply;
        }
      }

      return addressResolver(email, workerEnv);
    },
    onNoRoute: (email) => {
      email.setReject(
        `No EmailServiceAgent mailbox matched ${email.to}. Update EMAIL_FROM or your routing rule.`
      );
    }
  });
}

export class EmailServiceAgent extends Agent<Env, EmailServiceState> {
  initialState: EmailServiceState = {
    inbox: [],
    outbox: [],
    totalReceived: 0,
    totalSent: 0,
    autoReplyEnabled: true
  };

  async onEmail(email: AgentEmail): Promise<void> {
    try {
      const raw = await email.getRaw();
      const parsed = await PostalMime.parse(raw);
      const receivedAt = new Date().toISOString();
      const inboundRecord: EmailRecord = {
        id: crypto.randomUUID(),
        direction: "inbound",
        method: "email-service",
        simulated: email.headers.get("X-Example-Simulated") === "true",
        secureReply: email._secureRouted === true,
        from: parsed.from?.address || email.from,
        to: email.to,
        subject: parsed.subject?.trim() || "(No subject)",
        text: parsed.text?.trim() || "",
        html: typeof parsed.html === "string" ? parsed.html : undefined,
        timestamp: receivedAt,
        messageId: parsed.messageId,
        headers: Object.fromEntries(
          parsed.headers.map((header) => [header.key, header.value])
        )
      };

      this.setState({
        ...this.state,
        inbox: trimToRecent(this.state.inbox, inboundRecord),
        totalReceived: this.state.totalReceived + 1,
        lastInboundAt: receivedAt,
        lastError: undefined
      });

      if (!this.state.autoReplyEnabled || isAutoReplyEmail(parsed.headers)) {
        return;
      }

      const emailSecret = getEmailSecret(this.env);

      const replyText = [
        `Thanks for emailing ${this.env.EMAIL_FROM}.`,
        "",
        `The agent stored your message with subject "${inboundRecord.subject}".`,
        emailSecret
          ? "This reply was signed with replyToEmail(), so follow-up replies can use the secure resolver."
          : "This reply was sent without EMAIL_SECRET, so follow-up replies will use address-based routing until you configure signed replies.",
        "",
        `Mailbox instance: ${this.name}`
      ].join("\n");

      await this.replyToEmail(email, {
        fromName: SENDER_NAME,
        body: replyText,
        ...(emailSecret ? { secret: emailSecret } : {})
      });

      const replyRecord: EmailRecord = {
        id: crypto.randomUUID(),
        direction: "outbound",
        method: "reply-to-email",
        simulated: inboundRecord.simulated,
        secureReply: Boolean(emailSecret),
        from: this.env.EMAIL_FROM,
        to: inboundRecord.from,
        subject: `Re: ${inboundRecord.subject}`,
        text: replyText,
        html: textToHtml(replyText),
        timestamp: new Date().toISOString(),
        headers: {}
      };

      this.setState({
        ...this.state,
        outbox: trimToRecent(this.state.outbox, replyRecord),
        totalSent: this.state.totalSent + 1,
        lastOutboundAt: replyRecord.timestamp,
        lastError: undefined
      });
    } catch (error) {
      const message = `Failed to process inbound email. Existing mailbox state was preserved. ${getErrorMessage(error)}`;
      this.setState({
        ...this.state,
        lastError: message
      });
      throw new Error(message);
    }
  }

  @callable({ description: "Send an outbound email with Email Service" })
  async sendTransactionalEmail(input: {
    to: string;
    subject: string;
    body: string;
  }): Promise<SendEmailResult> {
    const to = input.to.trim();
    const subject = input.subject.trim();
    const body = input.body.trim();

    if (!to || !subject || !body) {
      return {
        ok: false,
        error: "Recipient, subject, and body are required before sending email."
      };
    }

    try {
      const response = await this.env.EMAIL.send({
        to,
        from: {
          email: this.env.EMAIL_FROM,
          name: SENDER_NAME
        },
        replyTo: this.env.EMAIL_FROM,
        subject,
        text: body,
        html: textToHtml(body)
      });

      const sentAt = new Date().toISOString();
      const outboundRecord: EmailRecord = {
        id: crypto.randomUUID(),
        direction: "outbound",
        method: "email-service",
        simulated: false,
        secureReply: false,
        from: this.env.EMAIL_FROM,
        to,
        subject,
        text: body,
        html: textToHtml(body),
        timestamp: sentAt,
        messageId: response.messageId,
        headers: {}
      };

      this.setState({
        ...this.state,
        outbox: trimToRecent(this.state.outbox, outboundRecord),
        totalSent: this.state.totalSent + 1,
        lastOutboundAt: sentAt,
        lastError: undefined
      });

      return {
        ok: true,
        messageId: response.messageId
      };
    } catch (error) {
      const message =
        `Email Service rejected the send request for configured sender ` +
        `${this.env.EMAIL_FROM}. ${getErrorMessage(error)}`;
      this.setState({
        ...this.state,
        lastError: message
      });
      return {
        ok: false,
        error: message
      };
    }
  }

  @callable({ description: "Enable or disable automatic replies" })
  toggleAutoReply(): boolean {
    const autoReplyEnabled = !this.state.autoReplyEnabled;
    this.setState({
      ...this.state,
      autoReplyEnabled
    });
    return autoReplyEnabled;
  }

  @callable({ description: "Clear the inbox and outbox history" })
  clearActivity(): void {
    this.setState({
      ...this.state,
      inbox: [],
      outbox: [],
      totalReceived: 0,
      totalSent: 0,
      lastInboundAt: undefined,
      lastOutboundAt: undefined,
      lastError: undefined
    });
  }
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleInboundEmail(message, env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/example-config") {
      return jsonResponse({
        mailboxAddress: env.EMAIL_FROM,
        mailboxId: getMailboxId(env.EMAIL_FROM)
      });
    }

    if (request.method === "POST" && url.pathname === "/api/simulate-email") {
      const payload = normalizeEmailPayload(
        await request.json(),
        env.EMAIL_FROM
      );

      if (!payload) {
        return jsonResponse(
          {
            success: false,
            error:
              "Provide from, subject, and body to simulate an inbound email."
          },
          { status: 400 }
        );
      }

      await handleInboundEmail(createMockEmail(payload), env);

      return jsonResponse({
        success: true,
        routedTo: payload.to
      });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
