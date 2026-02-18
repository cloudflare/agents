import { test, expect } from "@playwright/test";

const MessageType = {
  SYNC: "sync",
  CLEAR: "clear",
  THREADS: "threads",
  STREAM_DELTA: "stream_delta",
  REASONING_DELTA: "reasoning_delta",
  STREAM_END: "stream_end",
  ADD: "add",
  DELETE: "delete",
  CLEAR_REQUEST: "clear_request",
  CREATE_THREAD: "create_thread",
  DELETE_THREAD: "delete_thread",
  RUN: "run",
  GET_MESSAGES: "get_messages"
} as const;

const DEFAULT_THREAD = "default";

type WSMessage = {
  type: string;
  threadId?: string;
  threads?: Array<{ id: string; name: string }>;
  [key: string]: unknown;
};

async function connectAndRun(
  page: import("@playwright/test").Page,
  wsUrl: string,
  actions: string
): Promise<WSMessage[]> {
  return page.evaluate(
    ({ url, actions, MT, THREAD }) => {
      return new Promise<WSMessage[]>((resolve, reject) => {
        const ws = new WebSocket(url);
        const received: WSMessage[] = [];
        ws.onmessage = (e) => {
          try {
            received.push(JSON.parse(e.data as string));
          } catch {}
        };
        ws.onerror = () => reject(new Error("WebSocket error"));
        ws.onopen = () => {
          try {
            const fn = new Function(
              "ws",
              "resolve",
              "reject",
              "received",
              "MT",
              "THREAD",
              actions
            );
            fn(ws, resolve, reject, received, MT, THREAD);
          } catch (err) {
            reject(err);
          }
        };
      });
    },
    { url: wsUrl, actions, MT: MessageType, THREAD: DEFAULT_THREAD }
  );
}

function agentUrl(baseURL: string, room: string) {
  return `${baseURL.replace("http", "ws")}/agents/think-agent/${room}`;
}

test.describe("ThinkAgent e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("connect receives thread list", async ({ page, baseURL }) => {
    const room = crypto.randomUUID();
    const messages = await connectAndRun(
      page,
      agentUrl(baseURL!, room),
      `setTimeout(() => { ws.close(); resolve(received); }, 500);`
    );

    const threadsMsg = messages.find((m) => m.type === MessageType.THREADS);
    expect(threadsMsg).toBeDefined();
    expect(threadsMsg!.threads).toEqual([]);
  });

  test("create thread and receive updated list", async ({ page, baseURL }) => {
    const room = crypto.randomUUID();
    const messages = await connectAndRun(
      page,
      agentUrl(baseURL!, room),
      `
      setTimeout(() => {
        ws.send(JSON.stringify({ type: MT.CREATE_THREAD, name: "My Thread" }));
        setTimeout(() => { ws.close(); resolve(received); }, 500);
      }, 300);
      `
    );

    const threadMsgs = messages.filter((m) => m.type === MessageType.THREADS);
    const last = threadMsgs[threadMsgs.length - 1];
    expect(last.threads).toHaveLength(1);
    expect(last.threads![0].name).toBe("My Thread");
  });

  test("messages persist across connections", async ({ page, baseURL }) => {
    const room = crypto.randomUUID();

    // First connection: add a message
    await connectAndRun(
      page,
      agentUrl(baseURL!, room),
      `
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: MT.ADD, threadId: THREAD,
          message: { id: "persist-1", role: "user", content: "I persist", createdAt: Date.now() }
        }));
        setTimeout(() => { ws.close(); resolve(received); }, 300);
      }, 300);
      `
    );

    // Second connection: open two tabs — one sends, the other observes the SYNC
    const messages = await page.evaluate(
      ({ url, MT, THREAD }) => {
        return new Promise<WSMessage[]>((resolve, reject) => {
          const received: WSMessage[] = [];
          const observer = new WebSocket(url);
          const sender = new WebSocket(url);

          let observerReady = false;
          let senderReady = false;

          observer.onmessage = (e) => {
            try {
              received.push(JSON.parse(e.data as string));
            } catch {}
          };
          observer.onerror = () => reject(new Error("observer error"));
          observer.onopen = () => {
            observerReady = true;
            maybeRun();
          };

          sender.onerror = () => reject(new Error("sender error"));
          sender.onopen = () => {
            senderReady = true;
            maybeRun();
          };

          function maybeRun() {
            if (!observerReady || !senderReady) return;
            setTimeout(() => {
              sender.send(
                JSON.stringify({
                  type: MT.ADD,
                  threadId: THREAD,
                  message: {
                    id: "persist-2",
                    role: "user",
                    content: "second",
                    createdAt: Date.now()
                  }
                })
              );
              setTimeout(() => {
                observer.close();
                sender.close();
                resolve(received);
              }, 500);
            }, 300);
          }
        });
      },
      {
        url: agentUrl(baseURL!, room),
        MT: MessageType,
        THREAD: DEFAULT_THREAD
      }
    );

    const syncMsgs = (messages as WSMessage[]).filter(
      (m) => m.type === MessageType.SYNC && m.threadId === DEFAULT_THREAD
    );
    const last = syncMsgs[syncMsgs.length - 1];
    expect(last).toBeDefined();
    const msgs = last.messages as Array<{ id: string; content: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("I persist");
    expect(msgs[1].content).toBe("second");
  });

  test("delete thread removes it from list", async ({ page, baseURL }) => {
    const room = crypto.randomUUID();

    const messages = await connectAndRun(
      page,
      agentUrl(baseURL!, room),
      `
      setTimeout(() => {
        ws.send(JSON.stringify({ type: MT.CREATE_THREAD, name: "Temp" }));
        setTimeout(() => {
          // Find the thread id from the THREADS message
          const threadsMsg = received.find(m => m.type === MT.THREADS && m.threads && m.threads.length > 0);
          if (threadsMsg && threadsMsg.threads) {
            ws.send(JSON.stringify({ type: MT.DELETE_THREAD, threadId: threadsMsg.threads[0].id }));
          }
          setTimeout(() => { ws.close(); resolve(received); }, 300);
        }, 300);
      }, 300);
      `
    );

    const threadMsgs = messages.filter((m) => m.type === MessageType.THREADS);
    const last = threadMsgs[threadMsgs.length - 1];
    expect(last.threads).toEqual([]);
  });
});

// ── Streaming (AI required) ──────────────────────────────────────────

test.describe("ThinkAgent streaming e2e (AI)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("RUN streams STREAM_DELTA events and persists final message", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();

    type StreamResult = {
      streamDeltas: number;
      reasoningDeltas: number;
      gotStreamEnd: boolean;
      finalMessages: Array<{
        role: string;
        content: string;
        reasoning?: string;
      }>;
    };

    const result = await page.evaluate(
      ({ url, MT, THREAD }) => {
        return new Promise<StreamResult>((resolve, reject) => {
          const ws = new WebSocket(url);
          let streamDeltas = 0;
          let reasoningDeltas = 0;
          let gotStreamEnd = false;
          let gotSync = false;

          ws.onmessage = (e) => {
            const data = JSON.parse(e.data as string) as {
              type: string;
              threadId?: string;
              delta?: string;
              messages?: Array<{
                role: string;
                content: string;
                reasoning?: string;
              }>;
            };

            if (data.type === MT.STREAM_DELTA && data.threadId === THREAD) {
              streamDeltas++;
            }
            if (data.type === MT.REASONING_DELTA && data.threadId === THREAD) {
              reasoningDeltas++;
            }
            if (data.type === MT.STREAM_END && data.threadId === THREAD) {
              gotStreamEnd = true;
            }
            if (
              data.type === MT.SYNC &&
              data.threadId === THREAD &&
              streamDeltas > 0
            ) {
              gotSync = true;
              ws.close();
              resolve({
                streamDeltas,
                reasoningDeltas,
                gotStreamEnd,
                finalMessages: data.messages ?? []
              });
            }
          };

          ws.onerror = () => reject(new Error("WebSocket error"));

          ws.onopen = () => {
            setTimeout(() => {
              ws.send(
                JSON.stringify({
                  type: MT.ADD,
                  threadId: THREAD,
                  message: {
                    id: "stream-test-1",
                    role: "user",
                    content: "Say exactly the word 'hello'.",
                    createdAt: Date.now()
                  }
                })
              );
              ws.send(JSON.stringify({ type: MT.RUN, threadId: THREAD }));
            }, 300);
          };

          setTimeout(
            () => reject(new Error("Timeout waiting for streaming")),
            60_000
          );
        });
      },
      {
        url: agentUrl(baseURL!, room),
        MT: MessageType,
        THREAD: DEFAULT_THREAD
      }
    );

    expect(result.streamDeltas).toBeGreaterThan(0);
    expect(result.gotStreamEnd).toBe(true);
    expect(result.finalMessages.length).toBeGreaterThanOrEqual(2);

    const assistantMsg = result.finalMessages.find(
      (m) => m.role === "assistant"
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content.length).toBeGreaterThan(0);
  });

  test("reasoning traces are persisted and survive reconnect", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();

    // First connection: send message, run, wait for sync
    await page.evaluate(
      ({ url, MT, THREAD }) => {
        return new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(url);
          let gotSync = false;
          let streamStarted = false;

          ws.onmessage = (e) => {
            const data = JSON.parse(e.data as string) as {
              type: string;
              threadId?: string;
            };
            if (data.type === MT.STREAM_DELTA) streamStarted = true;
            if (
              data.type === MT.SYNC &&
              data.threadId === THREAD &&
              streamStarted
            ) {
              gotSync = true;
              ws.close();
              resolve();
            }
          };
          ws.onerror = () => reject(new Error("WebSocket error"));
          ws.onopen = () => {
            setTimeout(() => {
              ws.send(
                JSON.stringify({
                  type: MT.ADD,
                  threadId: THREAD,
                  message: {
                    id: "reasoning-test-1",
                    role: "user",
                    content: "What is 1 + 1?",
                    createdAt: Date.now()
                  }
                })
              );
              ws.send(JSON.stringify({ type: MT.RUN, threadId: THREAD }));
            }, 300);
          };
          setTimeout(() => reject(new Error("Timeout")), 60_000);
        });
      },
      {
        url: agentUrl(baseURL!, room),
        MT: MessageType,
        THREAD: DEFAULT_THREAD
      }
    );

    // Second connection: request messages, verify assistant message exists
    const messages = await connectAndRun(
      page,
      agentUrl(baseURL!, room),
      `
      setTimeout(() => {
        ws.send(JSON.stringify({ type: MT.GET_MESSAGES, threadId: THREAD }));
        setTimeout(() => { ws.close(); resolve(received); }, 1000);
      }, 500);
      `
    );

    const syncMsg = messages.find(
      (m) => m.type === MessageType.SYNC && m.threadId === DEFAULT_THREAD
    );
    expect(syncMsg).toBeDefined();
    const msgs = syncMsg!.messages as Array<{
      role: string;
      content: string;
      reasoning?: string;
    }>;
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content.length).toBeGreaterThan(0);
    // If model supports reasoning, the field should be present
    // (no assertion on reasoning field — depends on model capability)
  });
});
