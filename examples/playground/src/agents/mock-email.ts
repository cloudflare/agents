import {
  Agent,
  type AgentContext,
  type Connection,
  type WSMessage,
} from "agents";
import * as MockEmail from "../mock-cloudflare-email";
import PostalMime from "postal-mime";
import { createMimeMessage } from "mimetext";
import type { Email as PostalEmail } from "postal-mime";
export class MockEmailService<Env> extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.sql`
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY NOT NULL UNIQUE,
        _from TEXT,
        _to TEXT,
        _raw TEXT
      )
    `;
  }

  async onConnect(connection: Connection) {
    const rawEmails = this.sql<{ _from: string; _to: string; _raw: string }>`
      SELECT * FROM emails
    `;
    const emails: PostalEmail[] = [];
    for (const email of rawEmails) {
      const parsed = await PostalMime.parse(email._raw);
      emails.push(parsed);
    }
    connection.send(
      JSON.stringify({
        type: "inbox:all",
        messages: emails,
      })
    );
  }

  onMessage(connection: Connection, message: WSMessage) {
    console.log("onMessage", message);
    const parsed = JSON.parse(message as string);
    if (parsed.type === "send-email") {
      this.toOutbox(parsed.to, parsed.subject, parsed.text);
    } else if (parsed.type === "clear-emails") {
      this.sql`
        DELETE FROM emails
      `;
      this.broadcast(
        JSON.stringify({
          type: "inbox:all",
          messages: [],
        })
      );
    }
  }

  async toInbox(email: {
    from: string;
    to: string;
    message: string;
  }): Promise<void> {
    console.log("toInbox", email);
    const [mail] = this.sql<{ _from: string; _to: string; _raw: string }>`
      INSERT INTO emails (id, _from, _to, _raw)
      VALUES (${crypto.randomUUID()}, ${email.from}, ${email.to}, ${
        email.message
      })
      RETURNING *
    `;
    const parsed = await PostalMime.parse(mail._raw);
    this.broadcast(
      JSON.stringify({
        type: "inbox:new-message",
        message: parsed,
      })
    );
  }

  async toOutbox(to: string, subject: string, text: string): Promise<void> {
    console.log("toOutbox", to, subject, text);
    const email = createMimeMessage();
    email.setSender({ name: "The Man", addr: "theman@example.com" });
    email.setRecipient(to);
    email.setSubject(subject);
    email.addMessage({
      contentType: "text/plain",
      data: text,
    });
    const raw = email.asRaw();

    const [mail] = this.sql`
      INSERT INTO emails (_from, _to, _raw)
      VALUES (${"theman@example.com"}, ${to}, ${raw})
      RETURNING *
    `;
    this.broadcast(
      JSON.stringify({
        type: "outbox:new-message",
        message: mail,
      })
    );

    await fetch("http://localhost:5173/agents/email-agent/default/api/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "theman@example.com",
        to: to,
        message: raw,
      }),
    });
  }
}
