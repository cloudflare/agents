import { DurableObject } from "cloudflare:workers";
import {
  identityKey,
  type ChannelIdentity,
  type ChannelInboundMessage,
  type ChannelMessageSurface
} from "@cloudflare/channels";
import { directoryFor } from "./directory";
import { createHost } from "./server";
import {
  type ConversationPage,
  type ConversationSnapshot,
  type ConversationSummary,
  type Message
} from "./types";

type ConversationRow = {
  id: string;
  reply_surface: string | null;
  closed_at: string | null;
};

/**
 * One durable conversation, named by the route its Channel chose.
 *
 * It stores what arrived, remembers where to answer, and answers there.
 */
export class Conversation extends DurableObject<Env> {
  #host = createHost(this.env);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversation (
        id TEXT PRIMARY KEY,
        reply_surface TEXT,
        closed_at TEXT
      ) WITHOUT ROWID
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        message TEXT NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS handled_events (
        dispatch_id TEXT PRIMARY KEY
      ) WITHOUT ROWID
    `);
  }

  /**
   * Store one inbound message, or ignore a redelivery of one already stored.
   *
   * Providers can deliver the same event more than once, so the application
   * deduplicates on `dispatchId` before doing anything else.
   */
  async receive(
    id: string,
    channelKey: string,
    dispatchId: string,
    inbound: ChannelInboundMessage
  ): Promise<void> {
    const handled = this.#sql
      .exec(`SELECT 1 FROM handled_events WHERE dispatch_id = ?`, dispatchId)
      .toArray();
    if (handled.length > 0) return;
    this.#sql.exec(
      `INSERT INTO handled_events (dispatch_id) VALUES (?)`,
      dispatchId
    );

    // The reply surface is the exact destination for answering this
    // conversation. Keep the newest one we have been given.
    this.#sql.exec(
      `INSERT INTO conversation (id, reply_surface) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE
         SET reply_surface =
               COALESCE(excluded.reply_surface, conversation.reply_surface)`,
      id,
      inbound.replySurface ? JSON.stringify(inbound.replySurface) : null
    );

    const actor = inbound.actor;
    this.#append({
      id: dispatchId,
      direction: "received",
      markdown: inbound.message.markdown ?? inbound.message.text,
      createdAt: new Date().toISOString(),
      channelKey,
      ...(actor && {
        author: {
          ...((actor.fullName ?? actor.username) && {
            name: actor.fullName ?? actor.username
          }),
          ...(actor.identity && { identity: actor.identity })
        }
      })
    });
    await this.#index();
  }

  /** Send a reply, and store whatever the Channel reports about the attempt. */
  async reply(
    markdown: string,
    surface: ChannelMessageSurface
  ): Promise<ConversationPage> {
    const row = this.#row();
    if (row.closed_at) throw new Error("This conversation is closed");
    const delivery = await this.#host.deliver(surface, { markdown });
    const destination = {
      channelKey: surface.channelKey,
      label: surface.label
    };
    this.#append({
      id: crypto.randomUUID(),
      direction: "sent",
      markdown,
      createdAt: new Date().toISOString(),
      destination,
      delivery
    });
    await this.#index();
    return this.page();
  }

  /**
   * Ask the destination's Channel to render an approval request the user
   * decides in their own app: Slack buttons, a Telegram prompt, email links.
   */
  async requestApproval(
    summary: string,
    surface: ChannelMessageSurface
  ): Promise<ConversationPage> {
    const row = this.#row();
    if (row.closed_at) throw new Error("This conversation is closed");
    const destination = {
      channelKey: surface.channelKey,
      label: surface.label
    };

    const interactionId = crypto.randomUUID();
    const delivery = await this.#host.requestApproval(surface, {
      interactionId,
      request: {
        title: "Elevated access request",
        summary,
        input: { action: "grant-elevated-access" }
      }
    });

    this.#append({
      id: crypto.randomUUID(),
      direction: "sent",
      markdown: summary,
      createdAt: new Date().toISOString(),
      destination,
      delivery,
      approval: { interactionId, decision: null, decidedAt: null }
    });
    await this.#index();
    return this.page();
  }

  /**
   * Apply the user's decision to the approval request this conversation sent.
   *
   * The first decision wins, so a repeated provider callback changes nothing.
   */
  async settle(
    interactionId: string,
    decision: "approve" | "reject"
  ): Promise<void> {
    const request = this.#messages().find(
      (message) =>
        message.direction === "sent" &&
        message.approval?.interactionId === interactionId &&
        message.approval.decision === null
    );
    if (request?.direction !== "sent" || !request.approval) return;

    this.#replace({
      ...request,
      approval: {
        ...request.approval,
        decision,
        decidedAt: new Date().toISOString()
      }
    });
    await this.#index();
  }

  async close(): Promise<ConversationPage> {
    this.#sql.exec(
      `UPDATE conversation SET closed_at = ?`,
      new Date().toISOString()
    );
    await this.#index();
    return this.page();
  }

  /** The conversation and every destination it can currently answer through. */
  async page(): Promise<ConversationPage> {
    const conversation = this.#snapshot();
    const user = await directoryFor(this.env).userForAny(
      conversation.identities
    );
    const targets: ChannelMessageSurface[] = [];

    const replySurfaceValue = this.#row().reply_surface;
    const replySurface = replySurfaceValue
      ? (JSON.parse(replySurfaceValue) as ChannelMessageSurface)
      : undefined;
    if (replySurface) targets.push(replySurface);
    for (const identity of user?.channelIdentities ?? []) {
      const contactSurface = this.#host.contactSurface(identity);
      if (contactSurface) targets.push(contactSurface);
    }
    return { conversation, user, targets };
  }

  get #sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  #row(): ConversationRow {
    const row = this.#sql
      .exec<ConversationRow>(`SELECT * FROM conversation`)
      .toArray()[0];
    if (!row) throw new Error("This conversation has not received anything");
    return row;
  }

  #messages(): Message[] {
    return this.#sql
      .exec<{ message: string }>(
        `SELECT message FROM messages ORDER BY sequence`
      )
      .toArray()
      .map((row) => JSON.parse(row.message) as Message);
  }

  #append(message: Message): void {
    this.#sql.exec(
      `INSERT INTO messages (id, message) VALUES (?, ?)`,
      message.id,
      JSON.stringify(message)
    );
  }

  #replace(message: Message): void {
    this.#sql.exec(
      `UPDATE messages SET message = ? WHERE id = ?`,
      JSON.stringify(message),
      message.id
    );
  }

  #snapshot(): ConversationSnapshot {
    return { ...this.#summary(), messages: this.#messages() };
  }

  #summary(): ConversationSummary {
    const row = this.#row();
    const messages = this.#messages();
    const opener = messages.find((message) => message.direction === "received");
    const latest = messages.at(-1);

    const lastChannelKey =
      latest?.direction === "sent"
        ? latest.destination.channelKey
        : (latest?.channelKey ?? opener?.channelKey ?? "");

    return {
      id: row.id,
      title:
        opener?.direction === "received" && opener.author?.name
          ? opener.author.name
          : `${opener?.channelKey ?? ""} conversation`,
      preview: latest?.markdown ?? "",
      lastChannelKey,
      updatedAt: latest?.createdAt ?? new Date().toISOString(),
      closedAt: row.closed_at,
      messageCount: messages.length,
      identities: identitiesIn(messages)
    };
  }

  /** Keep this conversation visible in the directory's list. */
  async #index(): Promise<void> {
    await directoryFor(this.env).record(this.#summary());
  }
}

function identitiesIn(messages: readonly Message[]): ChannelIdentity[] {
  const identities = new Map<string, ChannelIdentity>();
  for (const message of messages) {
    const identity =
      message.direction === "received" ? message.author?.identity : undefined;
    if (identity) identities.set(identityKey(identity), identity);
  }
  return [...identities.values()];
}
