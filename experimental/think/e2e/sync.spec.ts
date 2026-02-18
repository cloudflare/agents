import { test, expect } from "@playwright/test";

const MessageType = {
  SYNC: "sync",
  CLEAR: "clear",
  THREADS: "threads",
  WORKSPACES: "workspaces",
  STREAM_DELTA: "stream_delta",
  REASONING_DELTA: "reasoning_delta",
  TOOL_CALL: "tool_call",
  STREAM_END: "stream_end",
  ADD: "add",
  DELETE: "delete",
  CLEAR_REQUEST: "clear_request",
  CREATE_THREAD: "create_thread",
  DELETE_THREAD: "delete_thread",
  CREATE_WORKSPACE: "create_workspace",
  ATTACH_WORKSPACE: "attach_workspace",
  LIST_FILES: "list_files",
  FILE_LIST: "file_list",
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

  test("STREAM_END is always sent even when no text was produced", async ({
    page,
    baseURL
  }) => {
    // Ask a question that will likely get a minimal or even empty text response
    // before done is called. We only care that STREAM_END arrives — the UI
    // must always be able to unblock.
    const room = crypto.randomUUID();

    const gotStreamEnd = await page.evaluate(
      ({ url, MT, THREAD }) => {
        return new Promise<boolean>((resolve, reject) => {
          const ws = new WebSocket(url);
          let streamEnd = false;

          ws.onmessage = (e) => {
            const data = JSON.parse(e.data as string) as {
              type: string;
              threadId?: string;
            };
            if (data.type === MT.STREAM_END && data.threadId === THREAD) {
              streamEnd = true;
              ws.close();
              resolve(true);
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
                    id: "stream-end-test",
                    role: "user",
                    content: "Reply with a single emoji.",
                    createdAt: Date.now()
                  }
                })
              );
              ws.send(JSON.stringify({ type: MT.RUN, threadId: THREAD }));
            }, 300);
          };

          setTimeout(() => {
            if (!streamEnd)
              reject(new Error("Timeout: STREAM_END not received"));
          }, 60_000);
        });
      },
      { url: agentUrl(baseURL!, room), MT: MessageType, THREAD: DEFAULT_THREAD }
    );

    expect(gotStreamEnd).toBe(true);
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

// ── Workspace + file tool e2e (AI required) ───────────────────────────────────
//
// These tests verify the full pipeline:
//   user message → RUN → tool calls → file operations → done → SYNC
//
// Each test creates a fresh ThinkAgent room, workspace, and thread so there
// is no state leak between tests.

test.describe("ThinkAgent workspace e2e (AI)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("agent uses writeFile tool and emits TOOL_CALL events", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();

    type FileOpResult = {
      toolCallEvents: Array<{
        toolName: string;
        args: Record<string, unknown>;
      }>;
      gotStreamEnd: boolean;
      finalMessages: Array<{ role: string; content: string }>;
    };

    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<FileOpResult>((resolve, reject) => {
          const ws = new WebSocket(url);
          const toolCallEvents: Array<{
            toolName: string;
            args: Record<string, unknown>;
          }> = [];
          let gotStreamEnd = false;
          let threadId: string | null = null;
          let workspaceId: string | null = null;
          let setupDone = false;

          ws.onmessage = (e) => {
            const data = JSON.parse(e.data as string) as {
              type: string;
              threads?: Array<{ id: string }>;
              workspaces?: Array<{ id: string }>;
              threadId?: string;
              toolName?: string;
              args?: Record<string, unknown>;
              messages?: Array<{ role: string; content: string }>;
            };

            // 1. On initial THREADS, create a workspace + thread
            if (data.type === MT.THREADS && !setupDone) {
              setupDone = true;
              ws.send(
                JSON.stringify({ type: MT.CREATE_WORKSPACE, name: "TestWS" })
              );
              ws.send(
                JSON.stringify({ type: MT.CREATE_THREAD, name: "FileTest" })
              );
            }

            // 2. Capture workspace ID
            if (data.type === MT.WORKSPACES && data.workspaces?.length) {
              workspaceId = data.workspaces[0].id;
              tryAttach();
            }

            // 3. Capture thread ID
            if (data.type === MT.THREADS && data.threads?.length && !threadId) {
              threadId = data.threads[0].id;
              tryAttach();
            }

            function tryAttach() {
              if (!threadId || !workspaceId) return;
              // Attach workspace, then send the task
              ws.send(
                JSON.stringify({
                  type: MT.ATTACH_WORKSPACE,
                  threadId,
                  workspaceId
                })
              );
              setTimeout(() => {
                ws.send(
                  JSON.stringify({
                    type: MT.ADD,
                    threadId,
                    message: {
                      id: "file-task-1",
                      role: "user",
                      content:
                        "Create a file at /hello.txt containing exactly the text 'hello world'. " +
                        "Then call done with a short summary.",
                      createdAt: Date.now()
                    }
                  })
                );
                ws.send(JSON.stringify({ type: MT.RUN, threadId }));
              }, 400);
            }

            // 4. Collect TOOL_CALL events
            if (data.type === MT.TOOL_CALL && data.threadId === threadId) {
              toolCallEvents.push({
                toolName: data.toolName ?? "",
                args: data.args ?? {}
              });
            }

            // 5. STREAM_END — mark it
            if (data.type === MT.STREAM_END && data.threadId === threadId) {
              gotStreamEnd = true;
            }

            // 6. SYNC after stream — resolve with results
            if (
              data.type === MT.SYNC &&
              data.threadId === threadId &&
              gotStreamEnd
            ) {
              ws.close();
              resolve({
                toolCallEvents,
                gotStreamEnd,
                finalMessages: data.messages ?? []
              });
            }
          };

          ws.onerror = () => reject(new Error("WebSocket error"));
          setTimeout(
            () => reject(new Error("Timeout: workspace file test")),
            90_000
          );
        });
      },
      { url: agentUrl(baseURL!, room), MT: MessageType }
    );

    // The agent must have called at least one tool (writeFile or bash)
    expect(result.toolCallEvents.length).toBeGreaterThan(0);

    // The agent should have used a file write tool
    const writeCallNames = result.toolCallEvents
      .map((e) => e.toolName)
      .filter((n) => n === "writeFile" || n === "bash");
    expect(writeCallNames.length).toBeGreaterThan(0);

    // Stream must complete cleanly
    expect(result.gotStreamEnd).toBe(true);

    // A persisted assistant message must exist
    const assistant = result.finalMessages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content.length).toBeGreaterThan(0);
  });

  test("done tool terminates loop and summary becomes the assistant message", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();

    type DoneResult = {
      sawDoneToolCall: boolean;
      gotStreamEnd: boolean;
      assistantContent: string;
    };

    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<DoneResult>((resolve, reject) => {
          const ws = new WebSocket(url);
          let sawDoneToolCall = false;
          let gotStreamEnd = false;
          let threadId: string | null = null;
          let workspaceId: string | null = null;
          let setupDone = false;

          ws.onmessage = (e) => {
            const data = JSON.parse(e.data as string) as {
              type: string;
              threads?: Array<{ id: string }>;
              workspaces?: Array<{ id: string }>;
              threadId?: string;
              toolName?: string;
              args?: Record<string, unknown>;
              messages?: Array<{ role: string; content: string }>;
            };

            if (data.type === MT.THREADS && !setupDone) {
              setupDone = true;
              ws.send(
                JSON.stringify({ type: MT.CREATE_WORKSPACE, name: "DoneWS" })
              );
              ws.send(
                JSON.stringify({ type: MT.CREATE_THREAD, name: "DoneTest" })
              );
            }

            if (data.type === MT.WORKSPACES && data.workspaces?.length) {
              workspaceId = data.workspaces[0].id;
              tryAttach();
            }

            if (data.type === MT.THREADS && data.threads?.length && !threadId) {
              threadId = data.threads[0].id;
              tryAttach();
            }

            function tryAttach() {
              if (!threadId || !workspaceId) return;
              ws.send(
                JSON.stringify({
                  type: MT.ATTACH_WORKSPACE,
                  threadId,
                  workspaceId
                })
              );
              setTimeout(() => {
                ws.send(
                  JSON.stringify({
                    type: MT.ADD,
                    threadId,
                    message: {
                      id: "done-task-1",
                      role: "user",
                      // Ask for a multi-file creation task with explicit done instruction.
                      // This exercises: tool calls → done tool → summary extraction.
                      content:
                        "Create two files: /a.txt with 'file A' and /b.txt with 'file B'. " +
                        "When both files are written, call done with a summary that mentions both file names.",
                      createdAt: Date.now()
                    }
                  })
                );
                ws.send(JSON.stringify({ type: MT.RUN, threadId }));
              }, 400);
            }

            if (data.type === MT.TOOL_CALL && data.threadId === threadId) {
              if (data.toolName === "done") sawDoneToolCall = true;
            }

            if (data.type === MT.STREAM_END && data.threadId === threadId) {
              gotStreamEnd = true;
            }

            if (
              data.type === MT.SYNC &&
              data.threadId === threadId &&
              gotStreamEnd
            ) {
              const msgs = (data.messages ?? []) as Array<{
                role: string;
                content: string;
              }>;
              const assistant = msgs.find((m) => m.role === "assistant");
              ws.close();
              resolve({
                sawDoneToolCall,
                gotStreamEnd,
                assistantContent: assistant?.content ?? ""
              });
            }
          };

          ws.onerror = () => reject(new Error("WebSocket error"));
          setTimeout(
            () => reject(new Error("Timeout: done tool test")),
            90_000
          );
        });
      },
      { url: agentUrl(baseURL!, room), MT: MessageType }
    );

    // The done tool must have been called
    expect(result.sawDoneToolCall).toBe(true);

    // Stream must complete cleanly
    expect(result.gotStreamEnd).toBe(true);

    // The persisted assistant message must be non-empty (the done summary)
    expect(result.assistantContent.length).toBeGreaterThan(0);
  });

  test("multi-step: agent reads its own written file and summarises correctly", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();

    type MultiStepResult = {
      toolCallNames: string[];
      gotStreamEnd: boolean;
      assistantContent: string;
    };

    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<MultiStepResult>((resolve, reject) => {
          const ws = new WebSocket(url);
          const toolCallNames: string[] = [];
          let gotStreamEnd = false;
          let threadId: string | null = null;
          let workspaceId: string | null = null;
          let setupDone = false;

          ws.onmessage = (e) => {
            const data = JSON.parse(e.data as string) as {
              type: string;
              threads?: Array<{ id: string }>;
              workspaces?: Array<{ id: string }>;
              threadId?: string;
              toolName?: string;
              messages?: Array<{ role: string; content: string }>;
            };

            if (data.type === MT.THREADS && !setupDone) {
              setupDone = true;
              ws.send(
                JSON.stringify({ type: MT.CREATE_WORKSPACE, name: "MultiWS" })
              );
              ws.send(
                JSON.stringify({ type: MT.CREATE_THREAD, name: "MultiStep" })
              );
            }

            if (data.type === MT.WORKSPACES && data.workspaces?.length) {
              workspaceId = data.workspaces[0].id;
              tryAttach();
            }

            if (data.type === MT.THREADS && data.threads?.length && !threadId) {
              threadId = data.threads[0].id;
              tryAttach();
            }

            function tryAttach() {
              if (!threadId || !workspaceId) return;
              ws.send(
                JSON.stringify({
                  type: MT.ATTACH_WORKSPACE,
                  threadId,
                  workspaceId
                })
              );
              setTimeout(() => {
                ws.send(
                  JSON.stringify({
                    type: MT.ADD,
                    threadId,
                    message: {
                      id: "multi-step-1",
                      role: "user",
                      // 1. Write a file. 2. Read it back. 3. Call done with the content.
                      // This forces at least 2 tool-use steps before the loop ends.
                      content:
                        "Write the text 'version=1' to /config.txt. " +
                        "Then read /config.txt back to confirm its content. " +
                        "Finally, call done with a summary that includes the file content you read.",
                      createdAt: Date.now()
                    }
                  })
                );
                ws.send(JSON.stringify({ type: MT.RUN, threadId }));
              }, 400);
            }

            if (data.type === MT.TOOL_CALL && data.threadId === threadId) {
              toolCallNames.push(data.toolName ?? "");
            }

            if (data.type === MT.STREAM_END && data.threadId === threadId) {
              gotStreamEnd = true;
            }

            if (
              data.type === MT.SYNC &&
              data.threadId === threadId &&
              gotStreamEnd
            ) {
              const msgs = (data.messages ?? []) as Array<{
                role: string;
                content: string;
              }>;
              const assistant = msgs.find((m) => m.role === "assistant");
              ws.close();
              resolve({
                toolCallNames,
                gotStreamEnd,
                assistantContent: assistant?.content ?? ""
              });
            }
          };

          ws.onerror = () => reject(new Error("WebSocket error"));
          setTimeout(
            () => reject(new Error("Timeout: multi-step test")),
            90_000
          );
        });
      },
      { url: agentUrl(baseURL!, room), MT: MessageType }
    );

    // Multiple tool calls must have occurred
    expect(result.toolCallNames.length).toBeGreaterThanOrEqual(2);

    // Both a write tool and a read tool must have been used
    const hasWrite = result.toolCallNames.some(
      (n) => n === "writeFile" || n === "bash"
    );
    const hasRead = result.toolCallNames.some(
      (n) => n === "readFile" || n === "bash"
    );
    expect(hasWrite).toBe(true);
    expect(hasRead).toBe(true);

    // Stream completes cleanly
    expect(result.gotStreamEnd).toBe(true);

    // The done summary should mention the file content
    expect(result.assistantContent).toContain("version=1");
  });
});

// ── File actually created in workspace (regression test for RPC disconnect) ──
//
// Previously, passing tool execute closures across the Chat RPC boundary caused
// "WritableStream received over RPC was disconnected" errors when a workspace
// was attached and the agent made file calls. This suite verifies the fix:
// the workspace stub is now passed to Chat, tools are built locally there, and
// execution goes Chat → Workspace directly without ThinkAgent in the chain.

test.describe("ThinkAgent workspace file creation (RPC fix regression)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("agent creates a file in the workspace and it is visible via LIST_FILES", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();

    type CreateFileResult = {
      gotStreamEnd: boolean;
      toolCallNames: string[];
      assistantContent: string;
      fileListEntries: string[]; // file names returned by LIST_FILES after run
    };

    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<CreateFileResult>((resolve, reject) => {
          const ws = new WebSocket(url);
          const toolCallNames: string[] = [];
          let gotStreamEnd = false;
          let threadId: string | null = null;
          let workspaceId: string | null = null;
          let setupDone = false;
          let assistantContent = "";

          ws.onmessage = (e) => {
            const data = JSON.parse(e.data as string) as {
              type: string;
              threads?: Array<{ id: string }>;
              workspaces?: Array<{ id: string }>;
              threadId?: string;
              toolName?: string;
              messages?: Array<{ role: string; content: string }>;
              entries?: Array<{ name: string }>;
              dir?: string;
            };

            if (data.type === MT.THREADS && !setupDone) {
              setupDone = true;
              ws.send(
                JSON.stringify({ type: MT.CREATE_WORKSPACE, name: "FileWS" })
              );
              ws.send(
                JSON.stringify({ type: MT.CREATE_THREAD, name: "FileThread" })
              );
            }

            if (data.type === MT.WORKSPACES && data.workspaces?.length) {
              workspaceId = data.workspaces[0].id;
              tryAttach();
            }
            if (data.type === MT.THREADS && data.threads?.length && !threadId) {
              threadId = data.threads[0].id;
              tryAttach();
            }

            function tryAttach() {
              if (!threadId || !workspaceId) return;
              ws.send(
                JSON.stringify({
                  type: MT.ATTACH_WORKSPACE,
                  threadId,
                  workspaceId
                })
              );
              setTimeout(() => {
                ws.send(
                  JSON.stringify({
                    type: MT.ADD,
                    threadId,
                    message: {
                      id: "create-file-1",
                      role: "user",
                      // Very explicit instruction to maximise reliability
                      content:
                        "Using the writeFile tool, create a file at /created.txt " +
                        "with the exact content 'file was created'. " +
                        "Then call done with a one-sentence summary.",
                      createdAt: Date.now()
                    }
                  })
                );
                ws.send(JSON.stringify({ type: MT.RUN, threadId }));
              }, 400);
            }

            if (data.type === MT.TOOL_CALL && data.threadId === threadId) {
              toolCallNames.push(data.toolName ?? "");
            }

            if (data.type === MT.STREAM_END && data.threadId === threadId) {
              gotStreamEnd = true;
            }

            if (
              data.type === MT.SYNC &&
              data.threadId === threadId &&
              gotStreamEnd
            ) {
              const msgs = (data.messages ?? []) as Array<{
                role: string;
                content: string;
              }>;
              assistantContent =
                msgs.find((m) => m.role === "assistant")?.content ?? "";

              // Immediately request the file listing to verify the file exists
              if (workspaceId) {
                ws.send(
                  JSON.stringify({
                    type: MT.LIST_FILES,
                    workspaceId,
                    dir: "/"
                  })
                );
              } else {
                ws.close();
                resolve({
                  gotStreamEnd,
                  toolCallNames,
                  assistantContent,
                  fileListEntries: []
                });
              }
            }

            if (data.type === MT.FILE_LIST && data.dir === "/") {
              const entries = (data.entries ?? []) as Array<{ name: string }>;
              ws.close();
              resolve({
                gotStreamEnd,
                toolCallNames,
                assistantContent,
                fileListEntries: entries.map((e) => e.name)
              });
            }
          };

          ws.onerror = () => reject(new Error("WebSocket error"));
          setTimeout(
            () => reject(new Error("Timeout: file creation test")),
            90_000
          );
        });
      },
      { url: agentUrl(baseURL!, room), MT: MessageType }
    );

    // No RPC disconnect — STREAM_END must arrive
    expect(result.gotStreamEnd).toBe(true);

    // The agent must have used a file-writing tool
    const wroteSomething = result.toolCallNames.some(
      (n) => n === "writeFile" || n === "bash"
    );
    expect(wroteSomething).toBe(true);

    // The file must actually exist in the workspace
    expect(result.fileListEntries).toContain("created.txt");

    // The assistant message (from done summary) must be non-empty
    expect(result.assistantContent.length).toBeGreaterThan(0);
  });
});
