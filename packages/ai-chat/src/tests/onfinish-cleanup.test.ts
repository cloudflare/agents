import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

describe("onFinish cleanup (framework-managed)", () => {
  it("cleans up abort controller after stream completes even without user passing onFinish", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    const timeout = setTimeout(() => resolvePromise(false), 3000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    // Send first request
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-cleanup-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg-cleanup-1",
                role: "user",
                parts: [{ type: "text", text: "Hello" }]
              }
            ]
          })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    // Send a second request to prove the agent is still healthy
    // (no leaked abort controllers causing issues)
    let resolveSecond: (value: boolean) => void;
    const secondDone = new Promise<boolean>((res) => {
      resolveSecond = res;
    });
    const timeout2 = setTimeout(() => resolveSecond(false), 3000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (
        data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        data.done &&
        data.id === "req-cleanup-2"
      ) {
        clearTimeout(timeout2);
        resolveSecond(true);
      }
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-cleanup-2",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg-cleanup-1",
                role: "user",
                parts: [{ type: "text", text: "Hello" }]
              },
              {
                id: "msg-cleanup-2",
                role: "user",
                parts: [{ type: "text", text: "Second message" }]
              }
            ]
          })
        }
      })
    );

    const second = await secondDone;
    expect(second).toBe(true);

    ws.close(1000);
  });

  it("cancellation still works after cleanup is moved to _reply", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    // Send a request and immediately cancel it
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-cancel-test",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "cancel-1",
                role: "user",
                parts: [{ type: "text", text: "Cancel me" }]
              }
            ]
          })
        }
      })
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
        id: "req-cancel-test"
      })
    );

    // Wait a moment for processing
    await new Promise((r) => setTimeout(r, 500));

    // Agent should still be alive -- send another request
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    const timeout = setTimeout(() => resolvePromise(false), 3000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (
        data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        data.done &&
        data.id === "req-after-cancel"
      ) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-after-cancel",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "after-cancel-1",
                role: "user",
                parts: [{ type: "text", text: "Still alive?" }]
              }
            ]
          })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    ws.close(1000);
  });

  it("multiple concurrent requests each get cleaned up", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const received: string[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string);
        if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
          received.push(data.id);
        }
      } catch {
        // ignore
      }
    });

    // Send two requests simultaneously
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-concurrent-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "conc-1",
                role: "user",
                parts: [{ type: "text", text: "First" }]
              }
            ]
          })
        }
      })
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-concurrent-2",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "conc-1",
                role: "user",
                parts: [{ type: "text", text: "First" }]
              },
              {
                id: "conc-2",
                role: "user",
                parts: [{ type: "text", text: "Second" }]
              }
            ]
          })
        }
      })
    );

    // Wait for both to complete
    await new Promise((r) => setTimeout(r, 2000));

    // Both requests should have completed
    expect(received).toContain("req-concurrent-1");
    expect(received).toContain("req-concurrent-2");

    ws.close(1000);
  });

  it("abort controllers are cleaned up after stream completion (count returns to 0)", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Initially no abort controllers
    expect(await agentStub.getAbortControllerCount()).toBe(0);

    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    const timeout = setTimeout(() => resolvePromise(false), 3000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    // Send a request
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-ac-check",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "ac-1",
                role: "user",
                parts: [{ type: "text", text: "Hello" }]
              }
            ]
          })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    // Give _reply a moment to finish its cleanup after the stream completes
    await new Promise((r) => setTimeout(r, 100));

    // Abort controller should have been cleaned up by _reply
    // even though our test worker's onChatMessage does NOT pass onFinish to streamText
    expect(await agentStub.getAbortControllerCount()).toBe(0);

    ws.close(1000);
  });

  it("abort controllers are cleaned up after multiple sequential requests", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Send 3 sequential requests
    for (let i = 0; i < 3; i++) {
      let resolvePromise: (value: boolean) => void;
      const donePromise = new Promise<boolean>((res) => {
        resolvePromise = res;
      });
      const timeout = setTimeout(() => resolvePromise(false), 3000);

      const listener = (e: MessageEvent) => {
        const data = JSON.parse(e.data as string);
        if (
          data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          data.done &&
          data.id === `req-seq-${i}`
        ) {
          clearTimeout(timeout);
          resolvePromise(true);
        }
      };
      ws.addEventListener("message", listener);

      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
          id: `req-seq-${i}`,
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: `seq-${i}`,
                  role: "user",
                  parts: [{ type: "text", text: `Message ${i}` }]
                }
              ]
            })
          }
        })
      );

      await donePromise;
      ws.removeEventListener("message", listener);
    }

    // Wait for cleanup
    await new Promise((r) => setTimeout(r, 100));

    // All 3 abort controllers should be cleaned up
    expect(await agentStub.getAbortControllerCount()).toBe(0);

    ws.close(1000);
  });
});
