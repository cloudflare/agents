import { PlaygroundAgent as Agent } from "../../shared/playground-agent";
import type { AgentEmail } from "agents/email";
import PostalMime from "postal-mime";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedEmail {
  id: string;
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  timestamp: string;
  messageId?: string;
  headers: Record<string, string>;
}

export interface ReceiveEmailState {
  emails: ParsedEmail[];
  totalReceived: number;
  lastReceivedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ReceiveEmailAgent - Demonstrates basic email receiving
 *
 * This agent receives emails via Cloudflare Email Routing and stores them
 * in its state. No auto-reply, just receives and displays.
 *
 * To use:
 * 1. Deploy to Cloudflare
 * 2. Configure Email Routing in Cloudflare dashboard
 * 3. Route emails to: receive+{instanceId}@yourdomain.com
 */
export class ReceiveEmailAgent extends Agent<Env, ReceiveEmailState> {
  initialState: ReceiveEmailState = {
    emails: [],
    totalReceived: 0
  };

  private storeEmail(parsedEmail: ParsedEmail) {
    this.setState({
      emails: [...this.state.emails.slice(-49), parsedEmail],
      totalReceived: this.state.totalReceived + 1,
      lastReceivedAt: parsedEmail.timestamp
    });

    this.broadcast(
      JSON.stringify({
        type: "email_received",
        email: parsedEmail
      })
    );
  }

  async onEmail(email: AgentEmail): Promise<void> {
    console.log("📧 ReceiveEmailAgent: Email from", email.from, "to", email.to);

    try {
      // Parse the email using postal-mime
      const raw = await email.getRaw();
      const parsed = await PostalMime.parse(raw);

      // Convert postal-mime headers to a simple key-value object
      const headers = Object.fromEntries(
        parsed.headers.map((h) => [h.key, h.value])
      );

      // Create parsed email record
      const parsedEmail: ParsedEmail = {
        id: crypto.randomUUID(),
        from: parsed.from?.address || email.from,
        to: email.to,
        subject: parsed.subject || "(No Subject)",
        text: parsed.text,
        html: parsed.html,
        timestamp: new Date().toISOString(),
        messageId: parsed.messageId,
        headers
      };

      this.storeEmail(parsedEmail);

      console.log("📧 Email stored:", parsedEmail.subject);
    } catch (error) {
      console.error("❌ Error processing email:", error);
      throw error;
    }
  }
}
