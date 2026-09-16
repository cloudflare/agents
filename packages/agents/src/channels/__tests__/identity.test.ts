import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createUserIdentityStore,
  identityKey,
  linkChannelIdentities,
  UserIdentityConflictError,
  type ChannelIdentity,
  type UserIdentityStorage
} from "..";

class TestStorage implements UserIdentityStorage {
  readonly #database = new DatabaseSync(":memory:");

  readonly sql = {
    exec: <Row extends Record<string, ArrayBuffer | string | number | null>>(
      query: string,
      ...bindings: (ArrayBuffer | string | number | null)[]
    ) => {
      const input = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value
      ) as SQLInputValue[];
      const rows = this.#database.prepare(query).all(...input) as Row[];
      return { toArray: () => rows };
    }
  };

  transactionSync<Result>(closure: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = closure();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

const slack = {
  channelKey: "slack",
  scope: "workspace:T_SUPPORT",
  subject: "user:U_ALICE"
} satisfies ChannelIdentity;

const telegram = {
  channelKey: "telegram",
  scope: "global",
  subject: "user:778899"
} satisfies ChannelIdentity;

const email = {
  channelKey: "email",
  scope: "global",
  subject: "alice@example.com"
} satisfies ChannelIdentity;

function store(userIds: string[] = ["user:new"]) {
  return createUserIdentityStore(new TestStorage(), {
    createUserId() {
      const userId = userIds.shift();
      if (!userId) throw new Error("Test exhausted its user IDs");
      return userId;
    }
  });
}

describe("UserIdentityStore", () => {
  it("links and queries Channel identities for an application user", async () => {
    const identities = store();

    await identities.link("user:alice", slack);
    const user = await identities.link("user:alice", telegram);

    expect(user).toEqual({
      id: "user:alice",
      channelIdentities: [slack, telegram]
    });
    await expect(identities.findUser(slack)).resolves.toEqual(user);
    await expect(identities.getUser("user:alice")).resolves.toEqual(user);
  });

  it("treats the same explicit link as idempotent", async () => {
    const identities = store();

    const first = await identities.link("user:alice", slack);
    const second = await identities.link("user:alice", slack);

    expect(second).toEqual(first);
  });

  it("normalizes an omitted scope to default for keys and storage", async () => {
    const identities = store();
    const implicit = {
      channelKey: "support-form",
      subject: "alice@example.com"
    } satisfies ChannelIdentity;
    const explicit = {
      ...implicit,
      scope: "default"
    } satisfies ChannelIdentity;

    expect(identityKey(implicit)).toBe(identityKey(explicit));
    await identities.link("user:alice", implicit);
    await expect(identities.findUser(explicit)).resolves.toEqual({
      id: "user:alice",
      channelIdentities: [explicit]
    });
  });

  it("lists every user ordered by user ID", async () => {
    const identities = store();
    await identities.link("user:bob", telegram);
    await identities.link("user:alice", slack);
    await identities.link("user:alice", email);

    await expect(identities.listUsers()).resolves.toEqual([
      {
        id: "user:alice",
        channelIdentities: [email, slack]
      },
      {
        id: "user:bob",
        channelIdentities: [telegram]
      }
    ]);
  });

  it("rejects moving an identity to another user", async () => {
    const identities = store();
    await identities.link("user:alice", slack);

    await expect(identities.link("user:bob", slack)).rejects.toMatchObject({
      name: "UserIdentityConflictError",
      code: "USER_IDENTITY_CONFLICT",
      conflicts: [{ channelIdentity: slack, userId: "user:alice" }],
      attemptedUserId: "user:bob"
    });
    await expect(identities.findUser(slack)).resolves.toMatchObject({
      id: "user:alice"
    });
  });

  it("creates a user when linking two unlinked channel identities", async () => {
    const identities = store(["user:generated"]);

    const user = await linkChannelIdentities(identities, slack, telegram);

    expect(user).toEqual({
      id: "user:generated",
      channelIdentities: [slack, telegram]
    });
  });

  it.each([
    [slack, telegram],
    [telegram, slack]
  ])(
    "adds an unlinked identity to the user found through either input order",
    async (linked, unlinked) => {
      const identities = store();
      await identities.link("user:alice", linked);

      const user = await linkChannelIdentities(identities, unlinked, linked);

      expect(user).toEqual({
        id: "user:alice",
        channelIdentities: [slack, telegram]
      });
    }
  );

  it("raises a conflict when both identities already link to the same user", async () => {
    const identities = store();
    await identities.link("user:alice", slack);
    await identities.link("user:alice", telegram);

    await expect(
      linkChannelIdentities(identities, slack, telegram)
    ).rejects.toBeInstanceOf(UserIdentityConflictError);
  });

  it("raises a conflict without merging users when both identities are linked", async () => {
    const identities = store();
    await identities.link("user:alice", slack);
    await identities.link("user:bob", telegram);

    await expect(
      linkChannelIdentities(identities, slack, telegram)
    ).rejects.toMatchObject({
      conflicts: [
        { channelIdentity: slack, userId: "user:alice" },
        { channelIdentity: telegram, userId: "user:bob" }
      ]
    });
    await expect(identities.findUser(slack)).resolves.toMatchObject({
      id: "user:alice"
    });
    await expect(identities.findUser(telegram)).resolves.toMatchObject({
      id: "user:bob"
    });
  });

  it("treats the configured Channel key as part of identity", async () => {
    const identities = store();
    const secondSlackChannel = {
      ...slack,
      channelKey: "slack-secondary"
    } satisfies ChannelIdentity;

    await identities.link("user:alice", slack);
    await identities.link("user:bob", secondSlackChannel);

    await expect(identities.findUser(slack)).resolves.toMatchObject({
      id: "user:alice"
    });
    await expect(
      identities.findUser(secondSlackChannel)
    ).resolves.toMatchObject({ id: "user:bob" });
  });

  it("treats Channel scope as part of identity", async () => {
    const identities = store();
    const otherWorkspace = {
      ...slack,
      scope: "workspace:T_OTHER"
    } satisfies ChannelIdentity;

    await identities.link("user:alice", slack);
    await identities.link("user:bob", otherWorkspace);
    await identities.link("user:alice", email);

    await expect(identities.findUser(slack)).resolves.toMatchObject({
      id: "user:alice"
    });
    await expect(identities.findUser(otherWorkspace)).resolves.toMatchObject({
      id: "user:bob"
    });
  });
});
