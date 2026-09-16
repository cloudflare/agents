import type {
  Channel,
  ChannelApprovalLinks,
  ChannelRoute,
  DeliveryFailure,
  DeliveryResult
} from "../../channel";
import type { ChannelIdentity } from "../../identity";
import type { ChannelMessageSurface } from "../../surface";
import type {
  EmailMessageSurface,
  EmailSurfaceAddress,
  EmailSurfaceRecipients
} from "./email-surface";
import {
  inboundEmail,
  type InboundEmailOptions,
  type InboundEmailRaw
} from "./inbound-email";
import { renderInput, utf8ByteLength } from "../../internal";

export type EmailAddress = EmailSurfaceAddress;
export type EmailRecipients = EmailSurfaceRecipients;

export type ChannelEmailMessage = {
  from: EmailAddress;
  to: EmailAddress | EmailAddress[];
  subject: string;
  text: string;
  replyTo?: EmailAddress;
  cc?: EmailAddress | EmailAddress[];
  bcc?: EmailAddress | EmailAddress[];
  headers?: Record<string, string>;
};

/** The structural subset of a Cloudflare Email Service binding used here. */
export interface EmailSendBinding {
  send(message: ChannelEmailMessage): Promise<{ messageId: string }>;
}

/** Configuration for an email Channel. */
export type EmailChannelOptions = {
  binding: EmailSendBinding;
  from: EmailAddress;
  /** Subject used when a message does not provide a title. */
  defaultTitle?: string;
  /** Select an application route from the event, parsed email, and Host context. */
  route?: ChannelRoute<InboundEmailRaw>;
  /** Override inferred Workers Email ingress addresses. */
  inbound?: InboundEmailOptions;
};

const DEFAULT_EMAIL_TITLE = "Agent message";
const EMAIL_HEADER_VALUE_LIMIT = 2048;

function approvalLinksUnavailable(retryable = false): DeliveryResult {
  return {
    status: "failed",
    retryable,
    error: {
      code: "APPROVAL_LINKS_UNAVAILABLE",
      message: "Email approval requests require caller-supplied approval links"
    }
  };
}

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
  "E_DAILY_LIMIT_EXCEEDED"
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

function emailSurface(surface: ChannelMessageSurface): EmailMessageSurface {
  return surface as EmailMessageSurface;
}

function mutableRecipients(
  value: EmailRecipients
): EmailAddress | EmailAddress[] {
  return Array.isArray(value) ? [...value] : (value as EmailAddress);
}

function replySubject(subject: string | undefined): string | undefined {
  if (!subject) return undefined;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function referenceHeader(references: readonly string[]): string | undefined {
  const unique = [...new Set(references.filter(Boolean))];
  if (unique.length === 0) return undefined;
  const root = `<${unique[0]}>`;
  if (utf8ByteLength(root) > EMAIL_HEADER_VALUE_LIMIT) return undefined;

  const selected = [root];
  for (let index = unique.length - 1; index > 0; index -= 1) {
    const candidate = `<${unique[index]}>`;
    if (
      utf8ByteLength([...selected, candidate].join(" ")) <=
      EMAIL_HEADER_VALUE_LIMIT
    ) {
      selected.splice(1, 0, candidate);
    }
  }
  return selected.join(" ");
}

/** Create a configured email Channel. */
export function email(options: EmailChannelOptions): Channel<InboundEmailRaw> {
  if (!options.binding) {
    throw new Error("binding is required to create an email channel");
  }

  async function send(
    destinationValue: ChannelMessageSurface,
    title: string | undefined,
    text: string
  ): Promise<DeliveryResult> {
    const destination = emailSurface(destinationValue);
    const inReplyTo = destination.address.inReplyTo;
    const inReplyToHeader = inReplyTo ? `<${inReplyTo}>` : undefined;
    if (
      inReplyToHeader &&
      utf8ByteLength(inReplyToHeader) > EMAIL_HEADER_VALUE_LIMIT
    ) {
      return {
        status: "failed",
        retryable: false,
        error: {
          code: "EMAIL_SURFACE_INVALID",
          message: "Email reply metadata exceeds provider header limits"
        }
      };
    }
    const references = destination.address.references;
    const referencesHeader = references
      ? referenceHeader(references)
      : undefined;
    if (references?.length && !referencesHeader) {
      return {
        status: "failed",
        retryable: false,
        error: {
          code: "EMAIL_SURFACE_INVALID",
          message: "Email reply metadata exceeds provider header limits"
        }
      };
    }
    const replyHeaders = {
      ...(inReplyToHeader && { "In-Reply-To": inReplyToHeader }),
      ...(referencesHeader && { References: referencesHeader })
    };
    try {
      const result = await options.binding.send({
        from: destination.address.from,
        to: mutableRecipients(destination.address.to),
        subject:
          title ??
          replySubject(destination.address.subject) ??
          options.defaultTitle ??
          DEFAULT_EMAIL_TITLE,
        text,
        replyTo: destination.address.replyTo,
        cc:
          destination.address.cc === undefined
            ? undefined
            : mutableRecipients(destination.address.cc),
        bcc:
          destination.address.bcc === undefined
            ? undefined
            : mutableRecipients(destination.address.bcc),
        headers: {
          ...destination.address.headers,
          ...replyHeaders
        }
      });

      return { status: "delivered" as const, reference: result.messageId };
    } catch (error) {
      return classifyEmailDeliveryError(error);
    }
  }

  return {
    ...(options.route && { route: options.route }),
    emailIngress: inboundEmail({
      to: options.inbound?.to,
      from: options.inbound?.from,
      replyFrom: options.from
    }),
    contactSurface(identity: ChannelIdentity) {
      if ((identity.scope ?? "default") !== "default") return null;
      return {
        version: 1,
        address: { from: options.from, to: identity.subject },
        label: `Email · ${identity.subject}`
      };
    },
    deliver(destination, message) {
      return send(destination, message.title, message.markdown);
    },
    async requestApproval(destination, { request, getApprovalLinks }) {
      if (!getApprovalLinks) return approvalLinksUnavailable();

      let links: ChannelApprovalLinks;
      try {
        links = await getApprovalLinks();
      } catch {
        // No provider send was attempted, so retrying cannot duplicate email
        // delivery even when the caller-owned link lookup failed transiently.
        return approvalLinksUnavailable(true);
      }

      const text = [
        request.summary,
        `Input:\n${renderInput(request.input)}`,
        `Approve: ${links.approve}`,
        `Reject: ${links.reject}`
      ].join("\n\n");
      return send(destination, request.title, text);
    }
  };
}
