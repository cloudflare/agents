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
  prompts: unknown[] = [];
  agents: unknown[] = [];
  interrupted: string[] = [];
  waitPromise: Promise<void> = Promise.resolve();

  listMessages() {
    return Promise.resolve(this.messages);
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
    return Promise.resolve();
  }
}

describe("OpenCodeRuntimeAdapter", () => {
  it("uses durable messages rather than process-local activity", async () => {
    const client = new Client();
    const adapter = new OpenCodeRuntimeAdapter({ client, passBudgetMs: 10 });

    expect(await adapter.inspect("session", "op-1")).toEqual({
      status: "not-admitted"
    });

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
      { sessionID: "session", id: "msg_op-1", text: "hello" }
    ]);
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
