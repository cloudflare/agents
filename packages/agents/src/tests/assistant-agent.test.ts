import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";
import type { UIMessage } from "ai";
import type { Session } from "../experimental/assistant/session/index";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// ── Helpers ────────────────────────────────────────────────────────

async function freshAgent(name?: string) {
  return getAgentByName(
    env.TestAssistantAgentAgent,
    name ?? crypto.randomUUID()
  );
}

// ── Tests ──────────────────────────────────────────────────────────

describe("AssistantAgent — session management", () => {
  it("starts with no sessions", async () => {
    const agent = await freshAgent();
    const sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(0);
  });

  it("creates a session and sets it as current", async () => {
    const agent = await freshAgent();
    const session = (await agent.createSession(
      "test chat"
    )) as unknown as Session;
    expect(session.name).toBe("test chat");

    const currentId = (await agent.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(session.id);
  });

  it("lists multiple sessions", async () => {
    const agent = await freshAgent();
    await agent.createSession("chat 1");
    await agent.createSession("chat 2");

    const sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(2);
  });

  it("switches sessions and loads history", async () => {
    const agent = await freshAgent();
    const s1 = (await agent.createSession("session 1")) as unknown as Session;
    const s2 = (await agent.createSession("session 2")) as unknown as Session;

    // Current should be s2 (last created)
    let currentId = (await agent.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(s2.id);

    // Switch back to s1
    const messages = (await agent.switchSession(
      s1.id
    )) as unknown as UIMessage[];
    expect(messages).toEqual([]);

    currentId = (await agent.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(s1.id);
  });

  it("deletes a session", async () => {
    const agent = await freshAgent();
    const session = (await agent.createSession(
      "to delete"
    )) as unknown as Session;

    await agent.deleteSession(session.id);

    const sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(0);

    // Current session should be null
    const currentId = await agent.getCurrentSessionId();
    expect(currentId).toBeNull();
  });

  it("renames a session", async () => {
    const agent = await freshAgent();
    const session = (await agent.createSession(
      "old name"
    )) as unknown as Session;

    await agent.renameSession(session.id, "new name");

    const sessions = (await agent.getSessions()) as unknown as Session[];
    expect(sessions[0].name).toBe("new name");
  });
});

describe("AssistantAgent — message persistence", () => {
  it("messages are empty for a new session", async () => {
    const agent = await freshAgent();
    await agent.createSession("empty chat");

    const messages = (await agent.getMessages()) as unknown as UIMessage[];
    expect(messages.length).toBe(0);
  });

  it("getSessionHistory returns history for a session", async () => {
    const agent = await freshAgent();
    const session = (await agent.createSession("test")) as unknown as Session;

    // Session history should be empty
    const history = (await agent.getSessionHistory(
      session.id
    )) as unknown as UIMessage[];
    expect(history.length).toBe(0);
  });
});

describe("AssistantAgent — session recovery", () => {
  it("recovers current session ID across agent instances", async () => {
    const name = crypto.randomUUID();

    // First instance — create a session
    const agent1 = await freshAgent(name);
    const session = (await agent1.createSession(
      "persistent"
    )) as unknown as Session;

    // Second instance with same name — should recover session
    const agent2 = await freshAgent(name);
    const currentId = (await agent2.getCurrentSessionId()) as unknown as string;
    expect(currentId).toBe(session.id);

    const sessions = (await agent2.getSessions()) as unknown as Session[];
    expect(sessions.length).toBe(1);
    expect(sessions[0].name).toBe("persistent");
  });
});
