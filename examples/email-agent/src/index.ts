import {
  Agent,
  createAddressBasedEmailResolver,
  createSecureReplyEmailResolver,
  routeAgentEmail,
  routeAgentRequest,
  type AgentEmail
} from "agents";
import PostalMime from "postal-mime";

interface EmailData {
  from: string;
  subject: string;
  text?: string;
  html?: string;
  to: string;
  timestamp: Date;
  messageId?: string;
}

interface EmailAgentState {
  emailCount: number;
  lastUpdated: Date;
  emails: EmailData[];
  autoReplyEnabled: boolean;
}

interface Env {
  EmailAgent: DurableObjectNamespace<EmailAgent>;
  EMAIL_SECRET: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const DEFAULT_SECRET = "change-me-in-production";

function assertSecretConfigured(secret: string | undefined): void {
  if (!secret) {
    throw new Error(
      "EMAIL_SECRET is not set. " +
        "Please set a secret using `wrangler secret put EMAIL_SECRET` " +
        "or add it to wrangler.jsonc for local development."
    );
  }
  if (secret === DEFAULT_SECRET) {
    throw new Error(
      "EMAIL_SECRET has not been changed from the default value. " +
        "Please set a unique secret using `wrangler secret put EMAIL_SECRET` " +
        "or update the value in wrangler.jsonc for local development."
    );
  }
}

export class EmailAgent extends Agent<Env, EmailAgentState> {
  initialState = {
    autoReplyEnabled: true,
    emailCount: 0,
    emails: [],
    lastUpdated: new Date()
  };

  async onEmail(email: AgentEmail) {
    try {
      console.log("📧 Received email from:", email.from, "to:", email.to);

      const raw = await email.getRaw();

      const parsed = await PostalMime.parse(raw);
      console.log("📧 Parsed email:", parsed);

      const emailData: EmailData = {
        from: parsed.from?.address || email.from,
        html: parsed.html,
        messageId: parsed.messageId,
        subject: parsed.subject || "No Subject",
        text: parsed.text,
        timestamp: new Date(),
        to: email.to
      };

      const newState = {
        autoReplyEnabled: this.state.autoReplyEnabled,
        emailCount: this.state.emailCount + 1,
        emails: [...this.state.emails.slice(-9), emailData],
        lastUpdated: new Date()
      };

      this.setState(newState);

      if (newState.autoReplyEnabled && !this.isAutoReply(parsed)) {
        await this.replyToEmail(email, {
          fromName: "My Email Agent",
          body: `Thank you for your email! 

I received your message with subject: "${email.headers.get("subject")}"

This is an automated response. Your email has been recorded and I will process it accordingly.

Current stats:
- Total emails processed: ${newState.emailCount}
- Last updated: ${newState.lastUpdated.toISOString()}

Best regards,
Email Agent`,
          secret: this.env.EMAIL_SECRET
        });
      }
    } catch (error) {
      console.error("❌ Error processing email:", error);
      throw error;
    }
  }

  private isAutoReply(
    parsed: Awaited<ReturnType<typeof PostalMime.parse>>
  ): boolean {
    // Check headers for auto-reply indicators
    // Cast header to Record to allow dynamic key access
    for (const h of parsed.headers) {
      const header = h as Record<string, string | undefined>;

      // auto-submitted header (RFC 3834) - any value except "no" indicates auto-reply
      const autoSubmitted = header["auto-submitted"];
      if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") {
        return true;
      }

      // x-auto-response-suppress header (Microsoft) - presence indicates auto-reply
      if (header["x-auto-response-suppress"]) {
        return true;
      }

      // precedence header - only specific values indicate auto-reply
      const precedence = header.precedence;
      if (
        precedence &&
        ["bulk", "junk", "list", "auto_reply"].includes(
          precedence.toLowerCase()
        )
      ) {
        return true;
      }
    }

    // Check subject line for common auto-reply patterns
    const subject = (parsed.subject || "").toLowerCase();
    return (
      subject.includes("auto-reply") ||
      subject.includes("out of office") ||
      subject.includes("automatic reply")
    );
  }
}

export default {
  async email(email, env: Env) {
    console.log("📮 Email received via email handler");

    assertSecretConfigured(env.EMAIL_SECRET);

    const secureReplyResolver = createSecureReplyEmailResolver(
      env.EMAIL_SECRET
    );
    const addressResolver = createAddressBasedEmailResolver("EmailAgent");

    await routeAgentEmail(email, env, {
      resolver: async (email, env) => {
        // Check if this is a reply to one of our outbound emails
        const replyRouting = await secureReplyResolver(email, env);
        if (replyRouting) return replyRouting;
        // Otherwise route based on recipient address
        return addressResolver(email, env);
      }
    });
  },
  async fetch(request: Request, env: Env) {
    try {
      const url = new URL(request.url);

      // Handle test email API endpoint
      if (url.pathname === "/api/test-email" && request.method === "POST") {
        assertSecretConfigured(env.EMAIL_SECRET);

        const emailData = (await request.json()) as {
          from?: string;
          to?: string;
          subject?: string;
          body?: string;
        };
        const { from, to, subject, body } = emailData;
        assert(from, "from is required");
        assert(to, "to is required");
        assert(subject, "subject is required");
        assert(body, "body is required");

        console.log("📧 Received test email data:", emailData);

        // Create properly formatted RFC 5322 email message
        const messageId = `<test-${crypto.randomUUID()}@test.local>`;
        const rawEmail = [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `Message-ID: ${messageId}`,
          `Date: ${new Date().toUTCString()}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          body
        ].join("\r\n");

        // Create mock email from the JSON payload
        const mockEmail: ForwardableEmailMessage = {
          from,
          to,
          headers: new Headers({
            subject,
            "Message-ID": messageId
          }),
          raw: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(rawEmail));
              controller.close();
            }
          }),
          rawSize: rawEmail.length,
          reply: async (message: EmailMessage) => {
            console.log("📧 Reply to email:", message);
            return { messageId: "mock-reply-id" };
          },
          forward: async (rcptTo: string, headers?: Headers) => {
            console.log("📧 Forwarding email to:", rcptTo, headers);
            return { messageId: "mock-forward-id" };
          },
          setReject: (reason: string) => {
            console.log("📧 Rejecting email:", reason);
          }
        };

        // Route the email using our email routing system
        const secureReplyResolver = createSecureReplyEmailResolver(
          env.EMAIL_SECRET
        );
        const addressResolver = createAddressBasedEmailResolver("EmailAgent");
        await routeAgentEmail(mockEmail, env, {
          resolver: async (email, env) => {
            const replyRouting = await secureReplyResolver(email, env);
            if (replyRouting) return replyRouting;
            return addressResolver(email, env);
          }
        });

        return new Response(
          JSON.stringify({
            success: true,
            message: "Email processed successfully"
          }),
          {
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      // Security test endpoint - allows injecting custom X-Agent headers
      // This is for testing the secure reply resolver's defenses
      if (url.pathname === "/api/test-security" && request.method === "POST") {
        assertSecretConfigured(env.EMAIL_SECRET);

        const testData = (await request.json()) as {
          from?: string;
          to?: string;
          subject?: string;
          body?: string;
          // Custom headers for security testing
          headers?: Record<string, string>;
          // If true, only use secure resolver (no fallback)
          secureOnly?: boolean;
        };
        const {
          from,
          to,
          subject,
          body,
          headers: customHeaders,
          secureOnly
        } = testData;
        assert(from, "from is required");
        assert(to, "to is required");
        assert(subject, "subject is required");
        assert(body, "body is required");

        console.log("🔒 Security test with headers:", customHeaders);

        const messageId = `<test-${crypto.randomUUID()}@test.local>`;
        const emailHeaders = new Headers({
          subject,
          "Message-ID": messageId
        });

        // Add custom headers for security testing
        if (customHeaders) {
          for (const [key, value] of Object.entries(customHeaders)) {
            emailHeaders.set(key, value);
          }
        }

        const rawEmail = [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `Message-ID: ${messageId}`,
          `Date: ${new Date().toUTCString()}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          body
        ].join("\r\n");

        const mockEmail: ForwardableEmailMessage = {
          from,
          to,
          headers: emailHeaders,
          raw: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(rawEmail));
              controller.close();
            }
          }),
          rawSize: rawEmail.length,
          reply: async (message: EmailMessage) => {
            console.log("📧 Reply to email:", message);
            return { messageId: "mock-reply-id" };
          },
          forward: async (rcptTo: string, headers?: Headers) => {
            console.log("📧 Forwarding email to:", rcptTo, headers);
            return { messageId: "mock-forward-id" };
          },
          setReject: (reason: string) => {
            console.log("📧 Rejecting email:", reason);
          }
        };

        const secureReplyResolver = createSecureReplyEmailResolver(
          env.EMAIL_SECRET,
          {
            onInvalidSignature: (email, reason) => {
              console.log(
                `🔒 Signature rejected: ${reason} from ${email.from}`
              );
            }
          }
        );
        const addressResolver = createAddressBasedEmailResolver("EmailAgent");

        let routedVia: string | null = null;

        try {
          await routeAgentEmail(mockEmail, env, {
            resolver: async (email, env) => {
              // Try secure reply routing first
              const replyRouting = await secureReplyResolver(email, env);
              if (replyRouting) {
                routedVia = "secure";
                return replyRouting;
              }

              // If secureOnly, don't fall back to address resolver
              if (secureOnly) {
                routedVia = "rejected";
                return null;
              }

              // Fall back to address-based routing
              routedVia = "address";
              return addressResolver(email, env);
            }
          });

          return new Response(
            JSON.stringify({
              success: true,
              routedVia,
              message:
                routedVia === "secure"
                  ? "Routed via secure resolver (signature valid)"
                  : routedVia === "address"
                    ? "Routed via address resolver (signature invalid/missing)"
                    : "Not routed (rejected)"
            }),
            {
              headers: { "Content-Type": "application/json" }
            }
          );
        } catch (routeError) {
          return new Response(
            JSON.stringify({
              success: false,
              routedVia,
              error:
                routeError instanceof Error
                  ? routeError.message
                  : "Unknown error"
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 400
            }
          );
        }
      }

      return (
        (await routeAgentRequest(request, env)) ||
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Fetch error in Worker:", error);
      return new Response(
        JSON.stringify({
          error: "Internal Server Error",
          message: error instanceof Error ? error.message : "Unknown error"
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 500
        }
      );
    }
  }
} satisfies ExportedHandler<Env>;
