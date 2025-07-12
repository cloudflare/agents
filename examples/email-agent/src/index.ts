import {
  Agent,
  createAddressBasedEmailResolver,
  routeAgentEmail,
  routeAgentRequest,
  type SerialisedEmail
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
  EMAIL: SendEmail;
  FROM_NAME: string;
}

export class EmailAgent extends Agent<Env, EmailAgentState> {
  initialState = {
    autoReplyEnabled: true,
    emailCount: 0,
    emails: [],
    lastUpdated: new Date()
  };

  async onEmail(email: SerialisedEmail) {
    try {
      console.log("📧 Received email from:", email.from, "to:", email.to);

      const raw = await email.getRaw();

      const parsed = await PostalMime.parse(raw);

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

      if (this.state.autoReplyEnabled && !this.isAutoReply(parsed)) {
        await this.replyToEmail(email, {
          fromName: this.env.FROM_NAME,
          body: `Thank you for your email! 

I received your message with subject: "${email.headers.get("subject")}"

This is an automated response. Your email has been recorded and I will process it accordingly.

Current stats:
- Total emails processed: ${this.state.emailCount}
- Last updated: ${this.state.lastUpdated.toISOString()}

Best regards,
Email Agent`
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
    const autoReplyHeaders = [
      "auto-submitted",
      "x-auto-response-suppress",
      "precedence"
    ];

    for (const header of autoReplyHeaders) {
      const hasHeader = parsed.headers.some((h) =>
        Object.keys(h).includes(header)
      );
      if (hasHeader) {
        return true;
      }
    }

    const subject = (parsed.subject || "").toLowerCase();
    return (
      subject.includes("auto-reply") ||
      subject.includes("out of office") ||
      subject.includes("automatic reply")
    );
  }
}

export default {
  async email(email, env) {
    console.log("📮 Email received via email handler");

    const addressResolver = createAddressBasedEmailResolver("EmailAgent");

    await routeAgentEmail(email, env, {
      resolver: addressResolver
    });
  },
  async fetch(request: Request, env: Env) {
    try {
      const url = new URL(request.url);

      // Handle test email API endpoint
      if (url.pathname === "/api/test-email" && request.method === "POST") {
        const emailData = (await request.json()) as {
          from?: string;
          to?: string;
          subject?: string;
          body?: string;
        };
        const { from, to, subject, body } = emailData;

        console.log("📧 Received test email data:", emailData);

        // Create mock email from the JSON payload
        const mockEmail = {
          forward: async () => {},
          from: from || "unknown@example.com",
          headers: new Headers({
            subject: subject || "Test Email"
          }),
          raw: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body || ""));
              controller.close();
            }
          }),
          rawSize: (body || "").length,
          reply: async () => {},
          setReject: () => {},
          to: to || "agent@example.com"
        } as ForwardableEmailMessage;

        // Route the email using our email routing system
        const resolver = createAddressBasedEmailResolver("EmailAgent");
        await routeAgentEmail(mockEmail, env, {
          resolver
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

      // Handle custom email webhook endpoint for testing
      if (url.pathname === "/webhook/email" && request.method === "POST") {
        const urlParams = new URLSearchParams(url.search);
        const from = urlParams.get("from") || "unknown@example.com";
        const to = urlParams.get("to") || "agent@example.com";
        const body = await request.text();

        // Create mock email from the raw content
        const mockEmail = {
          forward: async () => {},
          from,
          headers: new Headers({
            subject: "Test Email"
          }),
          raw: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            }
          }),
          rawSize: body.length,
          reply: async () => {},
          setReject: () => {},
          to
        } as ForwardableEmailMessage;

        // Route the email using our email routing system
        await routeAgentEmail(mockEmail, env, {
          resolver: createAddressBasedEmailResolver("EmailAgent")
        });

        return new Response("Worker successfully processed email");
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
