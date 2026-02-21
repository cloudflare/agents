import { callable } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";
import { type AgentEmail, isAutoReplyEmail } from "agents/email";
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
  isSecureReply?: boolean;
}

export interface SentReply {
  id: string;
  to: string;
  subject: string;
  body: string;
  timestamp: string;
  signed: boolean;
  inReplyTo: string;
}

export interface SecureEmailState {
  inbox: ParsedEmail[];
  outbox: SentReply[];
  totalReceived: number;
  totalReplies: number;
  autoReplyEnabled: boolean;
  lastReceivedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SecureEmailAgent - Demonstrates secure email replies with signed headers
 *
 * This agent receives emails and sends signed replies using replyToEmail().
 * The signed headers (X-Agent-Name, X-Agent-ID, X-Agent-Sig, X-Agent-Sig-Ts)
 * allow secure routing of replies back to this agent instance.
 *
 * To use:
 * 1. Deploy to Cloudflare
 * 2. Set EMAIL_SECRET: `wrangler secret put EMAIL_SECRET`
 * 3. Configure Email Routing in Cloudflare dashboard
 * 4. Route emails to: secure+{instanceId}@yourdomain.com
 */
export class SecureEmailAgent extends Agent<Env, SecureEmailState> {
  initialState: SecureEmailState = {
    inbox: [],
    outbox: [],
    totalReceived: 0,
    totalReplies: 0,
    autoReplyEnabled: true
  };

  async onEmail(email: AgentEmail): Promise<void> {
    console.log("🔐 SecureEmailAgent: Email from", email.from, "to", email.to);
    console.log("🔐 Secure routed:", email._secureRouted ? "Yes" : "No");

    try {
      // Parse the email
      const raw = await email.getRaw();
      const parsed = await PostalMime.parse(raw);

      // Check if this is a reply (has our signed headers)
      const isSecureReply = email._secureRouted === true;

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
        isSecureReply
      };

      // Add to inbox
      this.setState({
        ...this.state,
        inbox: [...this.state.inbox.slice(-49), parsedEmail],
        totalReceived: this.state.totalReceived + 1,
        lastReceivedAt: parsedEmail.timestamp
      });

      // Broadcast to connected clients
      this.broadcast(
        JSON.stringify({
          type: "email_received",
          email: parsedEmail,
          isSecureReply
        })
      );

      // Send auto-reply if enabled and not an auto-reply itself
      // Use the SDK's isAutoReplyEmail utility to detect auto-replies
      if (this.state.autoReplyEnabled && !isAutoReplyEmail(parsed.headers)) {
        await this.sendSignedReply(email, parsedEmail);
      }

      console.log("🔐 Email processed:", parsedEmail.subject);
    } catch (error) {
      console.error("❌ Error processing email:", error);
      throw error;
    }
  }

  private async sendSignedReply(
    email: AgentEmail,
    parsedEmail: ParsedEmail
  ): Promise<void> {
    const replyBody = `Thank you for your email!

I received your message with subject: "${parsedEmail.subject}"

This is an automated response from the Secure Email Agent.
Your reply will be securely routed back to this agent instance.

---
Instance ID: ${this.name}
Total emails processed: ${this.state.totalReceived + 1}
`;

    // Use the SDK's replyToEmail with signed headers
    await this.replyToEmail(email, {
      fromName: "Secure Email Agent",
      body: replyBody,
      secret: this.env.EMAIL_SECRET // Sign the reply for secure routing
    });

    // Record the sent reply
    const sentReply: SentReply = {
      id: crypto.randomUUID(),
      to: parsedEmail.from,
      subject: `Re: ${parsedEmail.subject}`,
      body: replyBody,
      timestamp: new Date().toISOString(),
      signed: true,
      inReplyTo: parsedEmail.id
    };

    this.setState({
      ...this.state,
      outbox: [...this.state.outbox.slice(-49), sentReply],
      totalReplies: this.state.totalReplies + 1
    });

    this.broadcast(
      JSON.stringify({
        type: "reply_sent",
        reply: sentReply
      })
    );

    console.log("🔐 Signed reply sent to:", parsedEmail.from);
  }

  @callable({ description: "Toggle auto-reply on/off" })
  toggleAutoReply(): boolean {
    const newValue = !this.state.autoReplyEnabled;
    this.setState({
      ...this.state,
      autoReplyEnabled: newValue
    });
    this.broadcast(
      JSON.stringify({
        type: "auto_reply_toggled",
        enabled: newValue
      })
    );
    return newValue;
  }

  @callable({ description: "Clear all emails" })
  clearEmails(): void {
    this.setState({
      ...this.state,
      inbox: [],
      outbox: []
    });
    this.broadcast(JSON.stringify({ type: "emails_cleared" }));
  }

  @callable({ description: "Get email stats" })
  getStats(): {
    inboxCount: number;
    outboxCount: number;
    totalReceived: number;
    totalReplies: number;
    autoReplyEnabled: boolean;
  } {
    return {
      inboxCount: this.state.inbox.length,
      outboxCount: this.state.outbox.length,
      totalReceived: this.state.totalReceived,
      totalReplies: this.state.totalReplies,
      autoReplyEnabled: this.state.autoReplyEnabled
    };
  }
}
