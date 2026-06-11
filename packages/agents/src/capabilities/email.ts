/**
 * Email capability (Layer 1): inbound dispatch to the agent's `onEmail`
 * hook plus outbound send/reply with agent routing headers.
 *
 * The `Agent` class delegates its `_onEmail()`/`replyToEmail()`/
 * `sendEmail()` methods here; the capability talks to the agent only
 * through the narrow {@link EmailHost} slice.
 */

import { signAgentHeaders } from "../email";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../internal_context";
import type { AgentEmail } from "../internal_context";
import { camelCaseToKebabCase } from "../utils";
// EmailSendResult is an ambient global from @cloudflare/workers-types.
import type { SendEmailOptions } from "../index";

type EmailEventType = "email:receive" | "email:reply" | "email:send";

/** The RPC bridge handed to `_onEmail` by the email router. */
export interface InboundEmailBridge {
  getRaw(): Promise<Uint8Array>;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<EmailSendResult>;
  reply(options: {
    from: string;
    to: string;
    raw: string;
  }): Promise<EmailSendResult>;
}

/** The slice of the agent the email capability needs. */
export interface EmailHost {
  /** The agent instance — ALS context value and `onEmail` dispatch target. */
  agent: object;
  /** The agent's class name (used for X-Agent-Name routing headers). */
  agentClassName(): string;
  /** The agent's instance name (used for X-Agent-ID routing headers). */
  agentInstanceName(): string;
  emit(type: EmailEventType, payload: Record<string, unknown>): void;
  tryCatch<T>(fn: () => T | Promise<T>): Promise<T>;
}

export class AgentEmailCapability {
  private readonly _host: EmailHost;

  constructor(host: EmailHost) {
    this._host = host;
  }

  /** Reconstruct the AgentEmail surface and dispatch to `onEmail`. */
  async dispatchInbound(payload: {
    from: string;
    to: string;
    headers: Headers;
    rawSize: number;
    _secureRouted?: boolean;
    _bridge: InboundEmailBridge;
  }): Promise<unknown> {
    // Reconstruct the AgentEmail interface from the payload so the
    // user's onEmail handler sees the same API as before
    const email: AgentEmail = {
      from: payload.from,
      to: payload.to,
      headers: payload.headers,
      rawSize: payload.rawSize,
      _secureRouted: payload._secureRouted,
      getRaw: () => payload._bridge.getRaw(),
      setReject: (reason: string) => payload._bridge.setReject(reason),
      forward: (rcptTo: string, headers?: Headers) =>
        payload._bridge.forward(rcptTo, headers),
      reply: (options: { from: string; to: string; raw: string }) =>
        payload._bridge.reply(options)
    };

    const agent = this._host.agent;
    return agentContext.run(
      { agent, connection: undefined, request: undefined, email },
      async () => {
        this._host.emit("email:receive", {
          from: email.from,
          to: email.to,
          subject: email.headers.get("subject") ?? undefined
        });
        if ("onEmail" in agent && typeof agent.onEmail === "function") {
          return this._host.tryCatch(() =>
            (agent.onEmail as (email: AgentEmail) => Promise<void>)(email)
          );
        } else {
          console.log("Received email from:", email.from, "to:", email.to);
          console.log("Subject:", email.headers.get("subject"));
          console.log(
            "Implement onEmail(email: AgentEmail): Promise<void> in your agent to process emails"
          );
        }
      }
    );
  }

  /** Reply to an inbound email, signing routing headers when asked. */
  async reply(
    email: AgentEmail,
    options: {
      fromName: string;
      subject?: string | undefined;
      body: string;
      contentType?: string;
      headers?: Record<string, string>;
      secret?: string | null;
    }
  ): Promise<void> {
    return this._host.tryCatch(async () => {
      // Enforce signing for emails routed via createSecureReplyEmailResolver
      if (email._secureRouted && options.secret === undefined) {
        throw new Error(
          "This email was routed via createSecureReplyEmailResolver. " +
            "You must pass a secret to replyToEmail() to sign replies, " +
            "or pass explicit null to opt-out (not recommended)."
        );
      }

      const agentName = camelCaseToKebabCase(this._host.agentClassName());
      const agentId = this._host.agentInstanceName();

      const { createMimeMessage } = await import("mimetext");
      const msg = createMimeMessage();
      msg.setSender({ addr: email.to, name: options.fromName });
      msg.setRecipient(email.from);
      msg.setSubject(
        options.subject || `Re: ${email.headers.get("subject")}` || "No subject"
      );
      msg.addMessage({
        contentType: options.contentType || "text/plain",
        data: options.body
      });

      const domain = email.from.split("@")[1];
      const messageId = `<${agentId}@${domain}>`;
      msg.setHeader("In-Reply-To", email.headers.get("Message-ID")!);
      msg.setHeader("Message-ID", messageId);
      msg.setHeader("X-Agent-Name", agentName);
      msg.setHeader("X-Agent-ID", agentId);

      // Sign headers if secret is provided (enables secure reply routing)
      if (typeof options.secret === "string") {
        const signedHeaders = await signAgentHeaders(
          options.secret,
          agentName,
          agentId
        );
        msg.setHeader("X-Agent-Sig", signedHeaders["X-Agent-Sig"]);
        msg.setHeader("X-Agent-Sig-Ts", signedHeaders["X-Agent-Sig-Ts"]);
      }

      if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          msg.setHeader(key, value);
        }
      }
      await email.reply({
        from: email.to,
        raw: msg.asRaw(),
        to: email.from
      });

      // Emit after the send succeeds — from/to are swapped because
      // this is a reply: the agent (email.to) is now the sender.
      const rawSubject = email.headers.get("subject");
      this._host.emit("email:reply", {
        from: email.to,
        to: email.from,
        subject:
          options.subject ?? (rawSubject ? `Re: ${rawSubject}` : undefined)
      });
    });
  }

  /** Send an outbound email via an Email Service binding. */
  async send(options: SendEmailOptions): Promise<EmailSendResult> {
    return this._host.tryCatch(async () => {
      if (!options.binding) {
        throw new Error(
          "binding is required. Pass your send_email binding, " +
            "e.g. this.sendEmail({ binding: this.env.EMAIL, ... })."
        );
      }

      const agentName = camelCaseToKebabCase(this._host.agentClassName());
      const agentId = this._host.agentInstanceName();

      const headers: Record<string, string> = {
        ...options.headers,
        "X-Agent-Name": agentName,
        "X-Agent-ID": agentId
      };

      if (options.inReplyTo) {
        headers["In-Reply-To"] = options.inReplyTo;
      }

      if (typeof options.secret === "string") {
        const signedHeaders = await signAgentHeaders(
          options.secret,
          agentName,
          agentId
        );
        headers["X-Agent-Sig"] = signedHeaders["X-Agent-Sig"];
        headers["X-Agent-Sig-Ts"] = signedHeaders["X-Agent-Sig-Ts"];
      }

      const result = await options.binding.send({
        from: options.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
        replyTo: options.replyTo,
        cc: options.cc,
        bcc: options.bcc,
        headers
      });

      const fromAddr =
        typeof options.from === "string" ? options.from : options.from.email;
      this._host.emit("email:send", {
        from: fromAddr,
        to: options.to,
        subject: options.subject
      });

      return result;
    });
  }
}
