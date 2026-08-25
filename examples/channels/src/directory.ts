import { DurableObject } from "cloudflare:workers";
import {
  createUserIdentityStore,
  identityKey,
  type ChannelIdentity,
  type UserIdentity
} from "agents/channels";
import {
  DIRECTORY_NAME,
  type ConversationSummary,
  type DirectorySnapshot,
  type UserPage
} from "./types";

/**
 * Which conversations exist, and which users their identities belong to.
 *
 * The only Channels API here is `createUserIdentityStore()`: it links a
 * Channel identity to a user when the application requests it.
 */
export class Directory extends DurableObject<Env> {
  #users = createUserIdentityStore(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // One row per conversation. The summary itself is JSON because only this
    // application reads it; the columns are what we sort and look up by.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        summary TEXT NOT NULL
      ) WITHOUT ROWID
    `);
  }

  /** Read-only check for a route already indexed by a conversation. */
  knows(route: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM conversations WHERE id = ?`, route)
        .toArray().length > 0
    );
  }

  /** Keep the list current after a conversation changes. */
  record(summary: ConversationSummary): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO conversations (id, updated_at, summary) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE
         SET updated_at = excluded.updated_at, summary = excluded.summary`,
      summary.id,
      summary.updatedAt,
      JSON.stringify(summary)
    );
  }

  async snapshot(): Promise<DirectorySnapshot> {
    return {
      conversations: this.#conversations(),
      users: await this.#users.listUsers()
    };
  }

  /** Link an identity to an existing user, or to a brand new one. */
  async link(
    identity: ChannelIdentity,
    userId?: string
  ): Promise<UserIdentity> {
    return this.#users.link(userId ?? crypto.randomUUID(), identity);
  }

  /** The user explicitly linked to one Channel identity, if any. */
  userFor(identity: ChannelIdentity): Promise<UserIdentity | null> {
    return this.#users.findUser(identity);
  }

  /** The user behind any identity seen in one conversation, if any. */
  async userForAny(
    identities: readonly ChannelIdentity[]
  ): Promise<UserIdentity | null> {
    for (const identity of identities) {
      const user = await this.#users.findUser(identity);
      if (user) return user;
    }
    return null;
  }

  async userPage(userId: string): Promise<UserPage> {
    const user = await this.#users.getUser(userId);
    if (!user) throw new Error("Unknown user");

    const linked = new Set(user.channelIdentities.map(identityKey));
    const conversations = this.#conversations().filter((conversation) =>
      conversation.identities.some((identity) =>
        linked.has(identityKey(identity))
      )
    );
    return { user, conversations };
  }

  #conversations(): ConversationSummary[] {
    return this.ctx.storage.sql
      .exec<{ summary: string }>(
        `SELECT summary FROM conversations ORDER BY updated_at DESC`
      )
      .toArray()
      .map((row) => JSON.parse(row.summary) as ConversationSummary);
  }
}

/** The single Durable Object that indexes every conversation. */
export function directoryFor(env: Env): DurableObjectStub<Directory> {
  return env.Directory.getByName(DIRECTORY_NAME);
}
