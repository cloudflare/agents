import type { Channel, DeliveryFailure, DeliveryResult } from "./channel";
import { inboundEmail, type InboundEmailOptions } from "./inbound-email";

export type EmailAddress = string | { email: string; name: string };
export type EmailRecipients = EmailAddress | EmailAddress[];

export type ChannelEmailMessage = {
  from: EmailAddress;
  to: EmailRecipients;
  subject: string;
  text: string;
  replyTo?: EmailAddress;
  cc?: EmailRecipients;
  bcc?: EmailRecipients;
  headers?: Record<string, string>;
};

/** The structural subset of a Cloudflare Email Service binding used here. */
export interface EmailSendBinding {
  send(message: ChannelEmailMessage): Promise<{ messageId: string }>;
}

/** Configuration for a destination-bound email channel. */
export type EmailChannelOptions = {
  binding: EmailSendBinding;
  from: EmailAddress;
  to: EmailRecipients;
  /** Subject used when a message does not provide a title. */
  defaultTitle?: string;
  replyTo?: EmailAddress;
  cc?: EmailRecipients;
  bcc?: EmailRecipients;
  headers?: Record<string, string>;
  /** Override inferred Workers Email ingress addresses. */
  inbound?: InboundEmailOptions;
};

const DEFAULT_EMAIL_TITLE = "Agent message";

const PERMANENT_EMAIL_ERRORS = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_DELIVERY_FAILED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY"
]);

const RETRYABLE_EMAIL_ERRORS = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR"
]);

const EMAIL_ERROR_MESSAGES = new Map<string, string>([
  [
    'Email must have at least one recipient in "to", "cc", or "bcc".',
    "E_FIELD_MISSING"
  ]
]);

function emailFailure(error: unknown): DeliveryFailure {
  if (error !== null && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    return {
      code:
        typeof value.code === "string" ? value.code : "EMAIL_DELIVERY_ERROR",
      message:
        typeof value.message === "string"
          ? value.message
          : "Email delivery failed"
    };
  }

  return {
    code: "EMAIL_DELIVERY_ERROR",
    message: typeof error === "string" ? error : "Email delivery failed"
  };
}

/** Classify an Email Service binding error as a model-visible result. */
function classifyEmailDeliveryError(error: unknown): DeliveryResult {
  const failure = emailFailure(error);
  const inferredCode = EMAIL_ERROR_MESSAGES.get(failure.message);
  if (inferredCode) {
    return {
      status: "failed",
      retryable: false,
      error: { ...failure, code: inferredCode }
    };
  }

  if (RETRYABLE_EMAIL_ERRORS.has(failure.code)) {
    return { status: "failed", retryable: true, error: failure };
  }

  if (PERMANENT_EMAIL_ERRORS.has(failure.code)) {
    return { status: "failed", retryable: false, error: failure };
  }

  return { status: "uncertain", error: failure };
}

function address(value: EmailAddress): string {
  return typeof value === "string" ? value : value.email;
}

function addresses(value: EmailRecipients): string[] {
  return (Array.isArray(value) ? value : [value]).map(address);
}

function renderInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

/** Create a configured outbound email route. */
export function email(options: EmailChannelOptions): Channel {
  if (!options.binding) {
    throw new Error("binding is required to create an email channel");
  }

  async function send(title: string | undefined, text: string) {
    try {
      const result = await options.binding.send({
        from: options.from,
        to: options.to,
        subject: title ?? options.defaultTitle ?? DEFAULT_EMAIL_TITLE,
        text,
        replyTo: options.replyTo,
        cc: options.cc,
        bcc: options.bcc,
        headers: options.headers
      });

      return { status: "delivered" as const, reference: result.messageId };
    } catch (error) {
      return classifyEmailDeliveryError(error);
    }
  }

  return {
    emailIngress: inboundEmail({
      to: address(options.from),
      from: addresses(options.to),
      ...options.inbound
    }),
    deliver(message) {
      return send(message.title, message.markdown);
    },
    async requestApproval({ request, getApprovalLinks }) {
      if (!getApprovalLinks) {
        return {
          status: "failed",
          retryable: false,
          error: {
            code: "APPROVAL_LINKS_UNAVAILABLE",
            message:
              "Email approval requests require a ChannelHost with approval links configured"
          }
        };
      }

      const links = await getApprovalLinks();
      const text = [
        request.summary,
        `Input:\n${renderInput(request.input)}`,
        `Approve: ${links.approve}`,
        `Reject: ${links.reject}`
      ].join("\n\n");
      return send(request.title, text);
    }
  };
}
