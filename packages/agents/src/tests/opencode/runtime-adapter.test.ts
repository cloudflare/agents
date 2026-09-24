import { describe, expect, it } from "vitest";
import {
  OpenCodeRuntimeAdapter,
  type OpenCodeRuntimeClient
} from "../../opencode/runtime-adapter";

type Message = {
  info: {
    id: string;
    role: string;
    time?: { completed?: number };
    error?: { type?: string; message?: string };
  };
};

class Client implements OpenCodeRuntimeClient {
  messages: Message[] = [];
  inbox: Array<{ id: string }> = [];
  prompts: unknown[] = [];
  agents: unknown[] = [];
  interrupted: string[] = [];
  interruptResult = { interrupted: true };
  waitPromise: Promise<void> = Promise.resolve();

  listMessages() {
    return Promise.resolve(this.messages);
  }

  listInbox() {
    return Promise.resolve(this.inbox);
  }

  prompt(input: unknown) {
    this.prompts.push(input);
    return Promise.resolve();
  }

  switchAgent(input: unknown) {
    this.agents.push(input);
    return Promise.resolve();
  }

  wait() {
    return this.waitPromise;
  }

  interrupt(sessionId: string) {
    this.interrupted.push(sessionId);
    return Promise.resolve(this.interruptResult);
  }
}

describe("OpenCodeRuntimeAdapter", () => {
  it("uses durable messages rather than process-local activity", async () => {
    const client = new Client();
    const adapter = new OpenCodeRuntimeAdapter({ client, passBudgetMs: 10 });

    expect(await adapter.inspect("session", "op-1")).toEqual({
      status: "not-admitted"
    });

    client.inbox = [{ id: "msg_op-1" }];
    expect(await adapter.inspect("session", "op-1")).toEqual({
      status: "active"
    });

    client.inbox = [];
    client.messages = [{ info: { id: "msg_op-1", role: "user" } }];
    expect(await adapter.inspect("session", "op-1")).toEqual({
      status: "active"
    });
  });

  it("reads completion and failure from the matching turn boundary", async () => {
    const client = new Client();
    const adapter = new OpenCodeRuntimeAdapter({ client });
    client.messages = [
      { info: { id: "msg_op-1", role: "user" } },
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          time: { completed: 2 }
        }
      },
      { info: { id: "msg_op-2", role: "user" } },
      {
        info: {
          id: "assistant-2",
          role: "assistant",
          time: { completed: 3 }
        }
      }
    ];

    expect(await adapter.inspect("session", "op-1")).toEqual({
      status: "completed",
      result: {
        operationId: "op-1",
        status: "completed",
        messageId: "assistant-1"
      }
    });

    client.messages = [
      { info: { id: "msg_op-1", role: "user" } },
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          time: { completed: 2 },
          error: { type: "provider", message: "failed" }
        }
      }
    ];
    expect(await adapter.inspect("session", "op-1")).toEqual({
      status: "completed",
      result: {
        operationId: "op-1",
        status: "failed",
        messageId: "assistant-1",
        error: { code: "provider", message: "failed" }
      }
    });
  });

  it("admits one prompt with a stable message identifier", async () => {
    const client = new Client();
    const adapter = new OpenCodeRuntimeAdapter({ client });

    await adapter.admit("session", "op-1", {
      kind: "prompt",
      text: "hello",
      agent: "build"
    });

    expect(client.agents).toEqual([{ sessionID: "session", agent: "build" }]);
    expect(client.prompts).toEqual([
      {
        sessionID: "session",
        id: "msg_op-1",
        text: "hello",
        resume: true
      }
    ]);
  });

  it("acknowledges cancellation only when native execution is interrupted", async () => {
    const client = new Client();
    client.messages = [{ info: { id: "msg_op-1", role: "user" } }];
    const adapter = new OpenCodeRuntimeAdapter({ client, heartbeatMs: 100 });

    expect(await adapter.cancel("session", "op-1")).toEqual({
      status: "cancelled"
    });

    client.interruptResult = { interrupted: false };
    const before = Date.now();
    const pending = await adapter.cancel("session", "op-1");
    expect(pending).toMatchObject({ status: "pending" });
    if (pending.status === "pending") {
      expect(pending.notBefore).toBeGreaterThanOrEqual(before + 100);
    }

    expect(client.interrupted).toEqual(["session", "session"]);
  });

  it("does not interrupt an absent or already completed operation", async () => {
    const client = new Client();
    const adapter = new OpenCodeRuntimeAdapter({ client });

    expect(await adapter.cancel("session", "missing")).toEqual({
      status: "not-found"
    });

    client.messages = [
      { info: { id: "msg_op-1", role: "user" } },
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          time: { completed: 2 }
        }
      }
    ];
    expect(await adapter.cancel("session", "op-1")).toEqual({
      status: "completed",
      result: {
        operationId: "op-1",
        status: "completed",
        messageId: "assistant-1"
      }
    });
    expect(client.interrupted).toEqual([]);
  });

  it("returns a bounded wait while OpenCode remains active", async () => {
    const client = new Client();
    client.messages = [{ info: { id: "msg_op-1", role: "user" } }];
    client.waitPromise = new Promise(() => {});
    const adapter = new OpenCodeRuntimeAdapter({ client, passBudgetMs: 5 });
    const before = Date.now();

    const outcome = await adapter.drive(
      "session",
      "op-1",
      new AbortController().signal
    );

    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.notBefore).toBeGreaterThanOrEqual(before);
    }
  });
});
