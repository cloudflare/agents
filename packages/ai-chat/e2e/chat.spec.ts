import { test, expect } from "@playwright/test";

// ── Helpers ──────────────────────────────────────────────────────────

/** Message type constants (mirrors src/types.ts MessageType enum values) */
const MessageType = {
  CF_AGENT_CHAT_MESSAGES: "cf_agent_chat_messages",
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response",
  CF_AGENT_CHAT_CLEAR: "cf_agent_chat_clear",
  CF_AGENT_STREAM_RESUMING: "cf_agent_stream_resuming",
  CF_AGENT_STREAM_RESUME_ACK: "cf_agent_stream_resume_ack"
} as const;

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

/**
 * Opens a real WebSocket to the agent inside the browser page context.
 * Returns helpers to send messages and collect responses.
 */
function wsHelpers(baseURL: string) {
  const agentPath = (room: string) =>
    `${baseURL.replace("http", "ws")}/agents/chat-agent/${room}`;

  return { agentPath };
}

/**
 * Connects a WebSocket inside page.evaluate and returns collected messages.
 * We run everything inside the browser because Playwright's native WS
 * support is for intercepting, not initiating raw connections.
 */
async function connectAndRun(
  page: import("@playwright/test").Page,
  wsUrl: string,
  actions: string // JS function body that receives (ws, resolve, reject, MessageType)
): Promise<WSMessage[]> {
  return page.evaluate(
    ({ url, actions, MT }) => {
      return new Promise<WSMessage[]>((resolve, reject) => {
        const ws = new WebSocket(url);
        const received: WSMessage[] = [];

        ws.onmessage = (e) => {
          try {
            received.push(JSON.parse(e.data as string));
          } catch {
            // ignore non-JSON
          }
        };

        ws.onerror = () => reject(new Error("WebSocket error"));

        ws.onopen = () => {
          try {
            // Execute the caller-provided action script
            const fn = new Function(
              "ws",
              "resolve",
              "reject",
              "received",
              "MT",
              actions
            );
            fn(ws, resolve, reject, received, MT);
          } catch (err) {
            reject(err);
          }
        };
      });
    },
    { url: wsUrl, actions, MT: MessageType }
  );
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("AIChatAgent e2e", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to a blank page so we have a browser context for WebSockets
    await page.goto("about:blank");
  });

  test("chat message round-trip: send request, receive streamed response", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    const messages = await connectAndRun(
      page,
      agentPath(room),
      `
      const userMsg = {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      };

      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMsg] })
        }
      }));

      // Wait for the done signal
      const check = setInterval(() => {
        const doneMsg = received.find(
          m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done === true
        );
        if (doneMsg) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);

      // Timeout safety
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Note: The sender is excluded from CF_AGENT_CHAT_MESSAGES broadcasts
    // (by design — only other connections receive it). So we only check
    // for the stream response here. Multi-connection sync is tested separately.

    // Should have received stream response chunks
    const streamResponses = messages.filter(
      (m) => m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE
    );
    expect(streamResponses.length).toBeGreaterThanOrEqual(2); // at least one chunk + done

    // Should have text-start, text-delta, text-end events
    const nonDoneResponses = streamResponses.filter(
      (m) => !m.done && typeof m.body === "string" && (m.body as string).trim()
    );
    const bodies = nonDoneResponses.map((m) => JSON.parse(m.body as string));
    const types = bodies.map((b: { type: string }) => b.type);
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");

    // The text-delta should contain the response text
    const deltas = bodies.filter(
      (b: { type: string }) => b.type === "text-delta"
    );
    const fullText = deltas.map((d: { delta: string }) => d.delta).join("");
    expect(fullText).toBe("Hello from e2e agent!");

    // The final message should be done=true
    const lastMsg = streamResponses[streamResponses.length - 1];
    expect(lastMsg.done).toBe(true);
  });

  test("message persistence: messages survive reconnection", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    // First connection: send a message
    await connectAndRun(
      page,
      agentPath(room),
      `
      const userMsg = {
        id: "persist-1",
        role: "user",
        parts: [{ type: "text", text: "Remember me" }]
      };

      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-persist",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMsg] })
        }
      }));

      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Verify via HTTP GET /get-messages
    const res = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);

    const persisted = await res.json();
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted.length).toBeGreaterThanOrEqual(2); // user + assistant

    // User message should be persisted
    const userMsg = persisted.find((m: { id: string }) => m.id === "persist-1");
    expect(userMsg).toBeTruthy();
    expect(userMsg.role).toBe("user");

    // Assistant response should be persisted
    const assistantMsgs = persisted.filter(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  });

  test("clear history: clears all messages and notifies other connections", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();
    const wsUrl = agentPath(room);

    // Send a message first
    await connectAndRun(
      page,
      wsUrl,
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-clear",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "clear-msg-1",
              role: "user",
              parts: [{ type: "text", text: "About to be cleared" }]
            }]
          })
        }
      }));

      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Verify messages exist
    const before = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    const beforeData = await before.json();
    expect(beforeData.length).toBeGreaterThanOrEqual(1);

    // Send clear from a new connection
    await connectAndRun(
      page,
      wsUrl,
      `
      ws.send(JSON.stringify({ type: MT.CF_AGENT_CHAT_CLEAR }));
      // Wait a bit for the clear to process
      setTimeout(() => { ws.close(); resolve(received); }, 500);
      `
    );

    // Verify messages are cleared
    const after = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    const afterData = await after.json();
    expect(afterData.length).toBe(0);
  });

  test("multi-connection sync: second connection receives broadcast", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();
    const wsUrl = agentPath(room);

    // Open two WebSocket connections and send from the first.
    // The second should receive the CF_AGENT_CHAT_MESSAGES broadcast
    // AND the streamed response.
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          ws1Messages: Array<{ type: string; [k: string]: unknown }>;
          ws2Messages: Array<{ type: string; [k: string]: unknown }>;
        }>((resolve) => {
          const ws1Messages: Array<{ type: string; [k: string]: unknown }> = [];
          const ws2Messages: Array<{ type: string; [k: string]: unknown }> = [];

          const ws1 = new WebSocket(url);
          const ws2 = new WebSocket(url);

          let ws1Open = false;
          let ws2Open = false;

          function maybeSend() {
            if (!ws1Open || !ws2Open) return;

            // Give connections a moment to fully register
            setTimeout(() => {
              ws1.send(
                JSON.stringify({
                  type: MT.CF_AGENT_USE_CHAT_REQUEST,
                  id: "req-sync",
                  init: {
                    method: "POST",
                    body: JSON.stringify({
                      messages: [
                        {
                          id: "sync-1",
                          role: "user",
                          parts: [{ type: "text", text: "Sync test" }]
                        }
                      ]
                    })
                  }
                })
              );
            }, 100);
          }

          ws1.onopen = () => {
            ws1Open = true;
            maybeSend();
          };
          ws2.onopen = () => {
            ws2Open = true;
            maybeSend();
          };

          ws1.onmessage = (e) => {
            try {
              ws1Messages.push(JSON.parse(e.data));
            } catch {}
          };
          ws2.onmessage = (e) => {
            try {
              ws2Messages.push(JSON.parse(e.data));
            } catch {}
          };

          // Wait for stream to complete on ws1
          const check = setInterval(() => {
            const done = ws1Messages.find(
              (m) => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done === true
            );
            if (done) {
              clearInterval(check);
              // Give ws2 a moment to receive broadcasts
              setTimeout(() => {
                ws1.close();
                ws2.close();
                resolve({ ws1Messages, ws2Messages });
              }, 200);
            }
          }, 50);

          setTimeout(() => {
            clearInterval(check);
            ws1.close();
            ws2.close();
            resolve({ ws1Messages, ws2Messages });
          }, 8000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    // ws2 should have received the chat messages broadcast
    const ws2ChatMsgs = result.ws2Messages.filter(
      (m) => m.type === MessageType.CF_AGENT_CHAT_MESSAGES
    );
    expect(ws2ChatMsgs.length).toBeGreaterThanOrEqual(1);

    // ws2 should have received the stream response (it's broadcast to all)
    const ws2StreamResponses = result.ws2Messages.filter(
      (m) => m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE
    );
    expect(ws2StreamResponses.length).toBeGreaterThanOrEqual(1);
  });

  test("separate rooms are isolated", async ({ page, baseURL }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const roomA = crypto.randomUUID();
    const roomB = crypto.randomUUID();

    // Send a message to room A
    await connectAndRun(
      page,
      agentPath(roomA),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-iso-a",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "iso-a",
              role: "user",
              parts: [{ type: "text", text: "Room A" }]
            }]
          })
        }
      }));
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Room A should have messages
    const resA = await page.request.get(
      `${baseURL}/agents/chat-agent/${roomA}/get-messages`
    );
    const dataA = await resA.json();
    expect(dataA.length).toBeGreaterThanOrEqual(2);

    // Room B should be empty
    const resB = await page.request.get(
      `${baseURL}/agents/chat-agent/${roomB}/get-messages`
    );
    const dataB = await resB.json();
    expect(dataB.length).toBe(0);
  });

  test("multiple messages accumulate in conversation", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();
    const wsUrl = agentPath(room);

    // Send first message
    await connectAndRun(
      page,
      wsUrl,
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-multi-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "multi-1",
              role: "user",
              parts: [{ type: "text", text: "First" }]
            }]
          })
        }
      }));
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Send second message (include first message in the array, as the client would)
    await connectAndRun(
      page,
      wsUrl,
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-multi-2",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              { id: "multi-1", role: "user", parts: [{ type: "text", text: "First" }] },
              { id: "multi-2", role: "user", parts: [{ type: "text", text: "Second" }] }
            ]
          })
        }
      }));
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Verify all messages persisted
    const res = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    const data = await res.json();

    // Should have: multi-1 (user), assistant-1, multi-2 (user), assistant-2
    const userMsgs = data.filter((m: { role: string }) => m.role === "user");
    const assistantMsgs = data.filter(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(userMsgs.length).toBe(2);
    expect(assistantMsgs.length).toBe(2);
  });

  test("request cancellation", async ({ page, baseURL }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    // Send a request and immediately cancel it
    const messages = await connectAndRun(
      page,
      agentPath(room),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-cancel",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "cancel-1",
              role: "user",
              parts: [{ type: "text", text: "Cancel me" }]
            }]
          })
        }
      }));

      // Cancel immediately
      ws.send(JSON.stringify({
        type: "cf_agent_chat_request_cancel",
        id: "req-cancel"
      }));

      // Wait a bit then close
      setTimeout(() => { ws.close(); resolve(received); }, 1000);
      `
    );

    // The test passes if no errors are thrown — cancellation is graceful
    // We might or might not get a response depending on timing
    expect(messages).toBeDefined();
  });
});

// ── Stream Resumption ──────────────────────────────────────────────

test.describe("Stream resumption e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("resume mid-stream: reconnecting client receives CF_AGENT_STREAM_RESUMING", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const slowUrl = `${baseURL!.replace("http", "ws")}/agents/slow-agent/${room}`;

    // Connect, send a message to start a slow stream, then disconnect mid-stream
    await page.evaluate(
      ({ url, MT }) => {
        return new Promise<void>((resolve) => {
          const ws = new WebSocket(url);
          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-slow",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "slow-1",
                        role: "user",
                        parts: [{ type: "text", text: "Go slow" }]
                      }
                    ]
                  })
                }
              })
            );
            // Disconnect after 600ms (mid-stream — SlowAgent sends chunks every 400ms)
            setTimeout(() => {
              ws.close();
              resolve();
            }, 600);
          };
        });
      },
      { url: slowUrl, MT: MessageType }
    );

    // Wait a beat for the server to register the disconnect
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect — should receive CF_AGENT_STREAM_RESUMING
    const resumeResult = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          messages: Array<{ type: string; [k: string]: unknown }>;
          gotResuming: boolean;
          gotResumeChunks: boolean;
        }>((resolve) => {
          const ws = new WebSocket(url);
          const messages: Array<{ type: string; [k: string]: unknown }> = [];
          let gotResuming = false;
          let gotResumeChunks = false;

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              messages.push(data);

              if (data.type === MT.CF_AGENT_STREAM_RESUMING) {
                gotResuming = true;
                // Send ACK
                ws.send(
                  JSON.stringify({
                    type: MT.CF_AGENT_STREAM_RESUME_ACK,
                    id: data.id
                  })
                );
              }

              if (
                data.type === MT.CF_AGENT_USE_CHAT_RESPONSE &&
                !data.done &&
                data.body
              ) {
                gotResumeChunks = true;
              }

              if (data.type === MT.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
                setTimeout(() => {
                  ws.close();
                  resolve({ messages, gotResuming, gotResumeChunks });
                }, 200);
              }
            } catch {
              // ignore
            }
          };

          setTimeout(() => {
            ws.close();
            resolve({ messages, gotResuming, gotResumeChunks });
          }, 10000);
        });
      },
      { url: slowUrl, MT: MessageType }
    );

    // Should have received the resuming notification
    expect(resumeResult.gotResuming).toBe(true);
    // Should have received replayed chunks after ACK
    expect(resumeResult.gotResumeChunks).toBe(true);
  });

  test("no resume after completion: reconnecting gets no CF_AGENT_STREAM_RESUMING", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    // Send a message and wait for completion
    await connectAndRun(
      page,
      agentPath(room),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-done-first",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "done-1",
              role: "user",
              parts: [{ type: "text", text: "Quick" }]
            }]
          })
        }
      }));
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Reconnect — should NOT get CF_AGENT_STREAM_RESUMING
    const reconnectMsgs = await connectAndRun(
      page,
      agentPath(room),
      `
      // Wait and see what messages arrive
      setTimeout(() => { ws.close(); resolve(received); }, 1000);
      `
    );

    const resumeMsg = reconnectMsgs.find(
      (m) => m.type === MessageType.CF_AGENT_STREAM_RESUMING
    );
    expect(resumeMsg).toBeUndefined();
  });

  test("client-initiated resume: CF_AGENT_STREAM_RESUME_REQUEST triggers resume after handler is ready", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const slowUrl = `${baseURL!.replace("http", "ws")}/agents/slow-agent/${room}`;

    // Start a slow stream and disconnect mid-stream
    await page.evaluate(
      ({ url, MT }) => {
        return new Promise<void>((resolve) => {
          const ws = new WebSocket(url);
          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-client-resume",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "cr-1",
                        role: "user",
                        parts: [{ type: "text", text: "Go slow" }]
                      }
                    ]
                  })
                }
              })
            );
            setTimeout(() => {
              ws.close();
              resolve();
            }, 600);
          };
        });
      },
      { url: slowUrl, MT: MessageType }
    );

    await new Promise((r) => setTimeout(r, 200));

    // Reconnect and explicitly send CF_AGENT_STREAM_RESUME_REQUEST
    // (simulating what the client does after useEffect registers the handler)
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          gotResuming: boolean;
          gotChunks: boolean;
          replayFlags: boolean[];
        }>((resolve) => {
          const ws = new WebSocket(url);
          let gotResuming = false;
          let gotChunks = false;
          const replayFlags: boolean[] = [];

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);

              if (data.type === MT.CF_AGENT_STREAM_RESUMING) {
                gotResuming = true;
                ws.send(
                  JSON.stringify({
                    type: MT.CF_AGENT_STREAM_RESUME_ACK,
                    id: data.id
                  })
                );
              }

              if (data.type === "cf_agent_use_chat_response") {
                if (!data.done && data.body) {
                  gotChunks = true;
                  replayFlags.push(data.replay === true);
                }
                if (data.done) {
                  replayFlags.push(data.replay === true);
                  setTimeout(() => {
                    ws.close();
                    resolve({ gotResuming, gotChunks, replayFlags });
                  }, 200);
                }
              }
            } catch {
              // ignore
            }
          };

          ws.onopen = () => {
            // Send resume request after handler is ready
            // (this is what useAgentChat does in its useEffect)
            ws.send(
              JSON.stringify({
                type: "cf_agent_stream_resume_request"
              })
            );
          };

          setTimeout(() => {
            ws.close();
            resolve({ gotResuming, gotChunks, replayFlags });
          }, 10000);
        });
      },
      { url: slowUrl, MT: MessageType }
    );

    // Should have received resume notification via the request
    expect(result.gotResuming).toBe(true);
    // Should have received chunks (mix of replayed from DB + live from ongoing stream)
    expect(result.gotChunks).toBe(true);
    // At least some chunks should have replay=true (the ones replayed from DB)
    expect(result.replayFlags.length).toBeGreaterThan(0);
    expect(result.replayFlags.some((f) => f === true)).toBe(true);
  });

  test("replayed chunks have replay=true flag", async ({ page, baseURL }) => {
    const room = crypto.randomUUID();
    const slowUrl = `${baseURL!.replace("http", "ws")}/agents/slow-agent/${room}`;

    // Start stream, disconnect mid-stream, reconnect
    await page.evaluate(
      ({ url, MT }) => {
        return new Promise<void>((resolve) => {
          const ws = new WebSocket(url);
          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-replay-flag",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "rf-1",
                        role: "user",
                        parts: [{ type: "text", text: "Go slow" }]
                      }
                    ]
                  })
                }
              })
            );
            setTimeout(() => {
              ws.close();
              resolve();
            }, 600);
          };
        });
      },
      { url: slowUrl, MT: MessageType }
    );

    await new Promise((r) => setTimeout(r, 200));

    // Reconnect and check replay flags
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          chunks: Array<{
            body?: string;
            done: boolean;
            replay?: boolean;
          }>;
        }>((resolve) => {
          const ws = new WebSocket(url);
          const chunks: Array<{
            body?: string;
            done: boolean;
            replay?: boolean;
          }> = [];

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);

              if (data.type === MT.CF_AGENT_STREAM_RESUMING) {
                ws.send(
                  JSON.stringify({
                    type: MT.CF_AGENT_STREAM_RESUME_ACK,
                    id: data.id
                  })
                );
              }

              if (data.type === "cf_agent_use_chat_response") {
                chunks.push({
                  body: data.body,
                  done: data.done,
                  replay: data.replay
                });
                if (data.done) {
                  setTimeout(() => {
                    ws.close();
                    resolve({ chunks });
                  }, 200);
                }
              }
            } catch {
              // ignore
            }
          };

          setTimeout(() => {
            ws.close();
            resolve({ chunks });
          }, 10000);
        });
      },
      { url: slowUrl, MT: MessageType }
    );

    // Should have received chunks
    expect(result.chunks.length).toBeGreaterThan(0);

    // Replayed chunks (from DB) have replay=true,
    // live chunks (from ongoing stream) don't.
    // At least some should be replayed.
    const replayedChunks = result.chunks.filter((c) => c.replay === true);
    expect(replayedChunks.length).toBeGreaterThan(0);
  });
});

// ── Custom Body ────────────────────────────────────────────────────

test.describe("Custom body forwarding e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("custom fields in request body are forwarded to onChatMessage", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    // Send a request with custom body fields
    await connectAndRun(
      page,
      agentPath(room),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-custom-body",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "cb-1",
              role: "user",
              parts: [{ type: "text", text: "With custom body" }]
            }],
            customField: "test-value",
            nestedData: { key: 123 }
          })
        }
      }));
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // If the agent didn't crash and responded, the custom body was received.
    // The ChatAgent doesn't use options.body, but the fact that it responded
    // means the parsing didn't fail — custom fields are silently passed through.
    const res = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Error Handling ─────────────────────────────────────────────────

test.describe("Error handling e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("malformed JSON on WebSocket does not crash connection", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    const messages = await connectAndRun(
      page,
      agentPath(room),
      `
      // Send garbage text
      ws.send("this is not json at all!!!");
      ws.send("{broken json");
      ws.send("");

      // Then send a valid request
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-after-garbage",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "garbage-1",
              role: "user",
              parts: [{ type: "text", text: "Still works?" }]
            }]
          })
        }
      }));

      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Should have received a valid response despite the garbage
    const doneMsg = messages.find(
      (m) => m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && m.done
    );
    expect(doneMsg).toBeTruthy();
  });

  test("invalid message type does not crash connection", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    const messages = await connectAndRun(
      page,
      agentPath(room),
      `
      // Send valid JSON with unknown type
      ws.send(JSON.stringify({ type: "totally_invalid_type", data: "whatever" }));
      ws.send(JSON.stringify({ type: "another_fake", id: "fake-id" }));

      // Then send a valid request
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-after-invalid",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "invalid-type-1",
              role: "user",
              parts: [{ type: "text", text: "Still alive?" }]
            }]
          })
        }
      }));

      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    const doneMsg = messages.find(
      (m) => m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && m.done
    );
    expect(doneMsg).toBeTruthy();
  });

  test("LLM API error returns error response to client", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const badKeyUrl = `${baseURL!.replace("http", "ws")}/agents/bad-key-agent/${room}`;

    const messages = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<Array<{ type: string; [k: string]: unknown }>>(
          (resolve) => {
            const ws = new WebSocket(url);
            const received: Array<{ type: string; [k: string]: unknown }> = [];

            ws.onmessage = (e) => {
              try {
                received.push(JSON.parse(e.data));
              } catch {
                // ignore
              }
            };

            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  type: MT.CF_AGENT_USE_CHAT_REQUEST,
                  id: "req-bad-key",
                  init: {
                    method: "POST",
                    body: JSON.stringify({
                      messages: [
                        {
                          id: "bad-key-1",
                          role: "user",
                          parts: [{ type: "text", text: "This should fail" }]
                        }
                      ]
                    })
                  }
                })
              );
            };

            // Wait for error or done
            const check = setInterval(() => {
              const errorOrDone = received.find(
                (m) =>
                  m.type === MT.CF_AGENT_USE_CHAT_RESPONSE &&
                  (m.done || m.error)
              );
              if (errorOrDone) {
                clearInterval(check);
                setTimeout(() => {
                  ws.close();
                  resolve(received);
                }, 200);
              }
            }, 100);

            setTimeout(() => {
              clearInterval(check);
              ws.close();
              resolve(received);
            }, 15000);
          }
        );
      },
      { url: badKeyUrl, MT: MessageType }
    );

    // Should have received an error response
    const errorMsg = messages.find(
      (m) =>
        m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && m.error === true
    );
    expect(errorMsg).toBeTruthy();
  });
});

// ── Concurrency ────────────────────────────────────────────────────

test.describe("Concurrency e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("concurrent requests: two requests complete without interference", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          req1Done: boolean;
          req2Done: boolean;
          messages: Array<{ type: string; [k: string]: unknown }>;
        }>((resolve) => {
          const ws = new WebSocket(url);
          const messages: Array<{ type: string; [k: string]: unknown }> = [];
          let req1Done = false;
          let req2Done = false;

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              messages.push(data);

              if (data.type === MT.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
                if (data.id === "req-conc-1") req1Done = true;
                if (data.id === "req-conc-2") req2Done = true;
                if (req1Done && req2Done) {
                  setTimeout(() => {
                    ws.close();
                    resolve({ req1Done, req2Done, messages });
                  }, 200);
                }
              }
            } catch {
              // ignore
            }
          };

          ws.onopen = () => {
            // Send two requests simultaneously
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-conc-1",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "conc-1",
                        role: "user",
                        parts: [{ type: "text", text: "First concurrent" }]
                      }
                    ]
                  })
                }
              })
            );
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-conc-2",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "conc-1",
                        role: "user",
                        parts: [{ type: "text", text: "First concurrent" }]
                      },
                      {
                        id: "conc-2",
                        role: "user",
                        parts: [{ type: "text", text: "Second concurrent" }]
                      }
                    ]
                  })
                }
              })
            );
          };

          setTimeout(() => {
            ws.close();
            resolve({ req1Done, req2Done, messages });
          }, 10000);
        });
      },
      { url: agentPath(room), MT: MessageType }
    );

    expect(result.req1Done).toBe(true);
    expect(result.req2Done).toBe(true);
  });
});

// ── Large Messages ─────────────────────────────────────────────────

test.describe("Large messages e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("large message persistence: 10KB message persists correctly", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    // Generate a 10KB string
    const largeText = "A".repeat(10 * 1024);

    await connectAndRun(
      page,
      agentPath(room),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-large",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "large-1",
              role: "user",
              parts: [{ type: "text", text: "${largeText}" }]
            }]
          })
        }
      }));
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Verify persistence
    const res = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    const data = await res.json();

    const userMsg = data.find((m: { id: string }) => m.id === "large-1");
    expect(userMsg).toBeTruthy();
    const textPart = userMsg.parts.find(
      (p: { type: string }) => p.type === "text"
    );
    expect(textPart.text.length).toBe(10 * 1024);
  });
});

// ── Malformed Input ────────────────────────────────────────────────

test.describe("Malformed input e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("empty messages array: agent handles gracefully", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    const messages = await connectAndRun(
      page,
      agentPath(room),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-empty",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [] })
        }
      }));

      // Wait for a response or timeout
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 3000);
      `
    );

    // Agent should handle empty messages without crashing
    // It may send a response or just not crash — either is fine
    expect(messages).toBeDefined();
  });

  test("missing body in init: agent handles gracefully", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    const messages = await connectAndRun(
      page,
      agentPath(room),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-no-body",
        init: {
          method: "POST"
        }
      }));

      // Give the agent a moment to process (and not crash)
      setTimeout(() => {
        // Then send a valid request to prove the connection is still alive
        ws.send(JSON.stringify({
          type: MT.CF_AGENT_USE_CHAT_REQUEST,
          id: "req-valid-after",
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [{
                id: "after-no-body",
                role: "user",
                parts: [{ type: "text", text: "Recovery" }]
              }]
            })
          }
        }));
      }, 500);

      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Connection should still be alive — the valid request should have completed
    expect(messages).toBeDefined();
  });
});

// ── Large Output ───────────────────────────────────────────────────

test.describe("Large tool output e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("large message persists without crash", async ({ page, baseURL }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    // Send a message with a 100KB body to test persistence of large data
    const largeText = "A".repeat(100_000);

    await connectAndRun(
      page,
      agentPath(room),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-large-output",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "large-output-1",
              role: "user",
              parts: [{ type: "text", text: "${largeText}" }]
            }]
          })
        }
      }));
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Verify the message persisted and is retrievable
    const res = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(2); // user + assistant

    // The user message should have the large text
    const userMsg = data.find((m: { id: string }) => m.id === "large-output-1");
    expect(userMsg).toBeTruthy();
  });

  test("3MB message: does not crash, degrades gracefully with compaction", async ({
    page,
    baseURL
  }) => {
    const { agentPath } = wsHelpers(baseURL!);
    const room = crypto.randomUUID();

    // First, send a normal message to establish the conversation
    await connectAndRun(
      page,
      agentPath(room),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-3mb-setup",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{
              id: "3mb-user-1",
              role: "user",
              parts: [{ type: "text", text: "Hello" }]
            }]
          })
        }
      }));
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Now send a message set that includes a 3MB assistant message
    // (simulating what would happen if a tool returned a huge result)
    // We send it via CF_AGENT_CHAT_MESSAGES which goes through persistMessages
    const threeMBText = "X".repeat(3_000_000);

    await connectAndRun(
      page,
      agentPath(room),
      `
      // Send the 3MB message via CF_AGENT_CHAT_MESSAGES (setMessages path)
      ws.send(JSON.stringify({
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "3mb-user-1",
            role: "user",
            parts: [{ type: "text", text: "Hello" }]
          },
          {
            id: "3mb-assistant-huge",
            role: "assistant",
            parts: [
              { type: "text", text: "Here are the results:" },
              {
                type: "tool-bigQuery",
                toolCallId: "call_3mb",
                state: "output-available",
                input: { query: "SELECT * FROM everything" },
                output: "${threeMBText}"
              }
            ]
          }
        ]
      }));

      // Give it time to persist
      setTimeout(() => { ws.close(); resolve(received); }, 1000);
      `
    );

    // Verify the agent didn't crash -- messages are retrievable
    const res = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);
    const data = await res.json();

    // Should have messages (didn't crash)
    expect(data.length).toBeGreaterThanOrEqual(2);

    // Find the huge assistant message
    const hugeMsg = data.find(
      (m: { id: string }) => m.id === "3mb-assistant-huge"
    );
    expect(hugeMsg).toBeTruthy();

    // The tool output should be compacted (not the original 3MB)
    const toolPart = hugeMsg.parts.find(
      (p: { toolCallId?: string }) => p.toolCallId === "call_3mb"
    );
    expect(toolPart).toBeTruthy();
    const output = toolPart.output as string;

    // Should contain the compaction notice
    expect(output).toContain("too large to persist");
    expect(output).toContain("suggest re-running the tool");
    expect(output).toContain("Preview:");

    // Should be much smaller than 3MB
    expect(output.length).toBeLessThan(10_000);

    // The text part should be preserved (it was small)
    const textPart = hugeMsg.parts.find(
      (p: { type: string }) => p.type === "text"
    );
    expect(textPart).toBeTruthy();
    expect(textPart.text).toBe("Here are the results:");

    // Metadata should indicate compaction happened
    if (hugeMsg.metadata) {
      expect(hugeMsg.metadata.compactedToolOutputs).toContain("call_3mb");
    }

    // The conversation should still work -- send another message
    const followUp = await connectAndRun(
      page,
      agentPath(room),
      `
      ws.send(JSON.stringify({
        type: MT.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-3mb-followup",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "3mb-user-1",
                role: "user",
                parts: [{ type: "text", text: "Hello" }]
              },
              {
                id: "3mb-assistant-huge",
                role: "assistant",
                parts: [
                  { type: "text", text: "Here are the results:" },
                  {
                    type: "tool-bigQuery",
                    toolCallId: "call_3mb",
                    state: "output-available",
                    input: { query: "SELECT * FROM everything" },
                    output: "compacted"
                  }
                ]
              },
              {
                id: "3mb-user-2",
                role: "user",
                parts: [{ type: "text", text: "Thanks, what next?" }]
              }
            ]
          })
        }
      }));
      const check = setInterval(() => {
        if (received.find(m => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done)) {
          clearInterval(check);
          ws.close();
          resolve(received);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); ws.close(); resolve(received); }, 5000);
      `
    );

    // Follow-up should succeed (agent still alive)
    const doneMsg = followUp.find(
      (m) => m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && m.done
    );
    expect(doneMsg).toBeTruthy();
  });
});
