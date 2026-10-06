import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function bare(name: string = crypto.randomUUID()) {
  return env.OPENCODE_HARNESS_TEST.getByName(name);
}

function withModel(name: string = crypto.randomUUID()) {
  return env.OPENCODE_MODEL_TEST.getByName(name);
}

describe("OpenCodeHarness sessions", () => {
  it("admits one native prompt for a stable operation identifier", async () => {
    const stub = bare();
    const session = await stub.createSession();

    await stub.admitPrompt(session, "op-1", "hello");
    expect(await stub.pending(session)).toMatchObject([
      { operationId: "op-1", session, status: "queued" }
    ]);

    await stub.admitPrompt(session, "op-1", "hello again");
    expect(await stub.pending(session)).toHaveLength(1);

    expect(await stub.leases()).toEqual([]);
    await stub.dispose();
  });

  it("creates, lists, and restores independent sessions", async () => {
    const name = crypto.randomUUID();
    const stub = bare(name);

    const root = await stub.rootSession();
    const first = await stub.createSession();
    const second = await stub.createSession();
    expect(new Set([root, first, second]).size).toBe(3);
    expect((await stub.listSessions()).map((info) => info.id).sort()).toEqual(
      [root, first, second].sort()
    );

    await stub.dispose();
    await evictDurableObject(stub);
    const restored = bare(name);

    expect(await restored.rootSession()).toBe(root);
    expect(await restored.snapshot(first)).toMatchObject({ session: first });
    expect(await restored.snapshot()).toEqual({
      session: root,
      messages: 0,
      running: false
    });
    await restored.dispose();
  });
});

describe("OpenCodeHarness on a shared database", () => {
  it("boots beside tables other capabilities made first", async () => {
    const stub = env.OPENCODE_SHARED_DATABASE_TEST.getByName(
      crypto.randomUUID()
    );
    expect(await stub.rootSession()).toMatch(/^ses_/);
    const tables = await stub.tables();
    expect(tables).toContain("vfs_files");
    expect(tables).toContain("migration");
    await stub.dispose();
  });
});

describe("OpenCodeHarness turns, through agents/models/opencode", () => {
  it("answers a prompt from the AI binding and keeps it across eviction", async () => {
    const stub = withModel();
    const answer = await stub.prompt("hello");

    expect(answer).toMatchObject({ status: "done", text: "echo: hello" });
    expect(answer.roles).toEqual(["user", "assistant"]);
    expect(await stub.bindingCalls()).toContain(
      "@cf/moonshotai/kimi-k2.7-code"
    );

    expect(await stub.leases()).toBe(0);

    await stub.dispose();
    await evictDurableObject(stub);
    expect(await stub.roles()).toEqual(["user", "assistant"]);
  });

  it("dedupes a submission by operation id", async () => {
    const stub = withModel();
    const receipt = await stub.submit("hello", "op-1");
    const again = await stub.submit("hello", "op-1");

    expect(receipt).toMatchObject({ operationId: "op-1", accepted: true });
    expect(again).toMatchObject({ operationId: "op-1", accepted: false });
    expect(await stub.wait("op-1")).toMatchObject({
      status: "done",
      text: "echo: hello"
    });
    await stub.dispose();
  });

  it("reports a failed turn as unanswered instead of waiting forever", async () => {
    const stub = withModel();
    const answer = await stub.prompt("fail");

    expect(answer.status).toBe("unanswered");
    expect(answer.reason).toBeTruthy();
    await stub.dispose();
  });

  it("reports an operation it never saw as not found", async () => {
    const stub = withModel();
    expect(await stub.wait("missing")).toMatchObject({
      status: "unanswered",
      reason: "not_found"
    });
    await stub.dispose();
  });

  it("streams a session's events: a snapshot, then the turn", async () => {
    const stub = withModel();
    const types = await stub.watch("hello");

    expect(types[0]).toBe("snapshot");
    expect(types.slice(1, 3)).toEqual(["operation_start", "snapshot"]);
    expect(types).toContain("text_delta");

    expect(types.indexOf("operation_end")).toBeGreaterThan(0);
    await stub.dispose();
  });

  it("serves OpenCode's HTTP API, which is what the CLI speaks", async () => {
    const stub = withModel();
    await stub.prompt("hello");

    const sessions = await stub.api("/api/session");
    expect(sessions.status).toBe(200);
    expect(
      (JSON.parse(sessions.body) as { data: { id: string }[] }).data.length
    ).toBeGreaterThan(0);

    const models = await stub.api("/api/model");
    expect(models.status).toBe(200);
    expect(
      (
        JSON.parse(models.body) as {
          data: { id: string; providerID: string }[];
        }
      ).data
    ).toContainEqual(
      expect.objectContaining({
        id: "@cf/moonshotai/kimi-k2.7-code",
        providerID: "cloudflare-workers-ai"
      })
    );
    await stub.dispose();
  });
});
