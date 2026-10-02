export type ChannelIdentity = Readonly<{
  /** Configured Channel that observed this identity. */
  channelKey: string;
  /** Stable Channel namespace in which `subject` is unique. @default "default" */
  scope?: string;
  /** Stable Channel subject within `scope`. */
  subject: string;
}>;

/** A Channel-produced identity before its Host stamps the configured key. */
export type ChannelIdentityInput = Readonly<{
  scope?: string;
  subject: string;
}>;

const DEFAULT_IDENTITY_SCOPE = "default";

type NormalizedChannelIdentity = Readonly<{
  channelKey: string;
  scope: string;
  subject: string;
}>;

function normalizeIdentity(
  identity: ChannelIdentity
): NormalizedChannelIdentity {
  return {
    channelKey: identity.channelKey,
    scope: identity.scope ?? DEFAULT_IDENTITY_SCOPE,
    subject: identity.subject
  };
}

/** Build a stable key for comparing or indexing a Channel identity. */
export function identityKey(identity: ChannelIdentity): string {
  const normalized = normalizeIdentity(identity);
  return JSON.stringify([
    normalized.channelKey,
    normalized.scope,
    normalized.subject
  ]);
}

export type UserIdentity = Readonly<{
  /** Opaque identity owned by this store. */
  id: string;
  /** Channel identities explicitly linked to this user. */
  channelIdentities: readonly ChannelIdentity[];
}>;

export type UserIdentityConflict = Readonly<{
  channelIdentity: ChannelIdentity;
  userId: string;
}>;

/** Raised when an operation would join identities already assigned to users. */
export class UserIdentityConflictError extends Error {
  readonly code = "USER_IDENTITY_CONFLICT";

  constructor(
    readonly conflicts: readonly UserIdentityConflict[],
    readonly attemptedUserId?: string
  ) {
    super(
      attemptedUserId
        ? `A channel identity is already linked to a different user than ${attemptedUserId}`
        : "Both channel identities are already linked to users"
    );
    this.name = "UserIdentityConflictError";
  }
}

/**
 * Application-owned user identity links.
 *
 * Implementations never infer links from usernames, email-like values, display
 * names, or message surfaces. Every link is an explicit application decision.
 */
export interface UserIdentityStore {
  /** Link one Channel identity to a user. Repeating the same link is safe. */
  link(userId: string, identity: ChannelIdentity): Promise<UserIdentity>;

  /** Find the user linked to one Channel identity. */
  findUser(identity: ChannelIdentity): Promise<UserIdentity | null>;

  /** Get a user and all of its linked Channel identities. */
  getUser(userId: string): Promise<UserIdentity | null>;

  /** List every user and its linked Channel identities, ordered by user ID. */
  listUsers(): Promise<UserIdentity[]>;

  /**
   * Atomically join two previously unjoined Channel identities.
   *
   * If one is linked, the other joins that user. If neither is linked, a new
   * user is created. If both are linked, this raises
   * `UserIdentityConflictError`, including when both point to the same user.
   */
  linkChannelIdentities(
    first: ChannelIdentity,
    second: ChannelIdentity
  ): Promise<UserIdentity>;
}

export type UserIdentitySqlValue = ArrayBuffer | string | number | null;

/** Structural storage seam satisfied by Durable Object SQLite storage. */
export interface UserIdentityStorage {
  readonly sql: {
    exec<Row extends Record<string, UserIdentitySqlValue>>(
      query: string,
      ...bindings: UserIdentitySqlValue[]
    ): { toArray(): Row[] };
  };
  transactionSync<Result>(closure: () => Result): Result;
}

export type UserIdentityStoreOptions = {
  /** Generate a new opaque user ID. @default crypto.randomUUID */
  createUserId?: () => string;
};

const USERS_TABLE = "cf_channels_users_v1";
const LINKS_TABLE = "cf_channels_user_identity_links_v1";

function requireNonEmpty(label: string, value: string): void {
  if (value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function validatedIdentity(
  identity: ChannelIdentity
): NormalizedChannelIdentity {
  const normalized = normalizeIdentity(identity);
  requireNonEmpty("identity.channelKey", normalized.channelKey);
  requireNonEmpty("identity.scope", normalized.scope);
  requireNonEmpty("identity.subject", normalized.subject);
  return normalized;
}

function sameIdentity(
  first: ChannelIdentity,
  second: ChannelIdentity
): boolean {
  return identityKey(first) === identityKey(second);
}

function compareIdentities(
  first: NormalizedChannelIdentity,
  second: NormalizedChannelIdentity
): number {
  return (
    first.channelKey.localeCompare(second.channelKey) ||
    first.scope.localeCompare(second.scope) ||
    first.subject.localeCompare(second.subject)
  );
}

/** Build the off-the-shelf user identity store over application-owned SQLite. */
export function createUserIdentityStore(
  storage: UserIdentityStorage,
  options: UserIdentityStoreOptions = {}
): UserIdentityStore {
  const createUserId = options.createUserId ?? (() => crypto.randomUUID());

  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
      user_id TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${LINKS_TABLE} (
      channel_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (channel_key, scope, subject)
    ) WITHOUT ROWID
  `);
  storage.sql.exec(`
    CREATE INDEX IF NOT EXISTS ${LINKS_TABLE}_user
    ON ${LINKS_TABLE} (user_id, channel_key, scope, subject)
  `);

  function linkedUserId(identity: NormalizedChannelIdentity): string | null {
    const row = storage.sql
      .exec<{ user_id: string }>(
        `SELECT user_id FROM ${LINKS_TABLE}
         WHERE channel_key = ? AND scope = ? AND subject = ?`,
        identity.channelKey,
        identity.scope,
        identity.subject
      )
      .toArray()[0];
    return row?.user_id ?? null;
  }

  function readUser(userId: string): UserIdentity | null {
    const user = storage.sql
      .exec<{ user_id: string }>(
        `SELECT user_id FROM ${USERS_TABLE} WHERE user_id = ?`,
        userId
      )
      .toArray()[0];
    if (!user) return null;

    const channelIdentities = storage.sql
      .exec<{ channelKey: string; scope: string; subject: string }>(
        `SELECT channel_key AS channelKey, scope, subject FROM ${LINKS_TABLE}
         WHERE user_id = ?
         ORDER BY channel_key, scope, subject`,
        userId
      )
      .toArray()
      .sort(compareIdentities);
    return { id: user.user_id, channelIdentities };
  }

  function insertUser(userId: string): boolean {
    const inserted = storage.sql
      .exec<{ user_id: string }>(
        `INSERT INTO ${USERS_TABLE} (user_id) VALUES (?)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id`,
        userId
      )
      .toArray()[0];
    return inserted !== undefined;
  }

  function createUser(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const userId = createUserId();
      requireNonEmpty("createUserId() result", userId);
      if (insertUser(userId)) return userId;
    }
    throw new Error("createUserId() repeatedly returned existing user IDs");
  }

  function insertLink(
    userId: string,
    identity: NormalizedChannelIdentity
  ): void {
    storage.sql.exec(
      `INSERT INTO ${LINKS_TABLE} (channel_key, scope, subject, user_id)
       VALUES (?, ?, ?, ?)`,
      identity.channelKey,
      identity.scope,
      identity.subject,
      userId
    );
  }

  const store: UserIdentityStore = {
    async link(userId, identity) {
      requireNonEmpty("userId", userId);
      const normalized = validatedIdentity(identity);

      return storage.transactionSync(() => {
        const existingUserId = linkedUserId(normalized);
        if (existingUserId && existingUserId !== userId) {
          throw new UserIdentityConflictError(
            [{ channelIdentity: normalized, userId: existingUserId }],
            userId
          );
        }

        insertUser(userId);
        if (!existingUserId) insertLink(userId, normalized);
        const user = readUser(userId);
        if (!user) throw new Error("Linked user identity could not be read");
        return user;
      });
    },

    async findUser(identity) {
      const normalized = validatedIdentity(identity);
      const userId = linkedUserId(normalized);
      return userId ? readUser(userId) : null;
    },

    async getUser(userId) {
      requireNonEmpty("userId", userId);
      return readUser(userId);
    },

    async listUsers() {
      return storage.sql
        .exec<{ user_id: string }>(
          `SELECT user_id FROM ${USERS_TABLE} ORDER BY user_id`
        )
        .toArray()
        .map(({ user_id }) => readUser(user_id))
        .filter((user): user is UserIdentity => user !== null);
    },

    async linkChannelIdentities(first, second) {
      const normalizedFirst = validatedIdentity(first);
      const normalizedSecond = validatedIdentity(second);
      if (sameIdentity(normalizedFirst, normalizedSecond)) {
        throw new TypeError("Channel identities must be distinct");
      }

      return storage.transactionSync(() => {
        const firstUserId = linkedUserId(normalizedFirst);
        const secondUserId = linkedUserId(normalizedSecond);
        if (firstUserId && secondUserId) {
          throw new UserIdentityConflictError([
            { channelIdentity: normalizedFirst, userId: firstUserId },
            { channelIdentity: normalizedSecond, userId: secondUserId }
          ]);
        }

        const userId = firstUserId ?? secondUserId ?? createUser();
        if (!firstUserId) insertLink(userId, normalizedFirst);
        if (!secondUserId) insertLink(userId, normalizedSecond);

        const user = readUser(userId);
        if (!user) throw new Error("Linked user identity could not be read");
        return user;
      });
    }
  };

  return store;
}

/** Join two Channel identities through a `UserIdentityStore`. */
export function linkChannelIdentities(
  store: UserIdentityStore,
  first: ChannelIdentity,
  second: ChannelIdentity
): Promise<UserIdentity> {
  return store.linkChannelIdentities(first, second);
}
