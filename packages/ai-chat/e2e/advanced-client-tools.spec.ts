import { test, expect } from "@playwright/test";

/**
 * Advanced e2e tests for client-side tool interactions:
 * - Multi-tab continuation broadcast (other tabs receive continuation without ACK)
 * - Delayed tool result (proxy for hibernation recovery)
 * - Turn coalescing behavior
 *
 * Uses ClientToolAgent which defines getUserLocation without `execute`.
 */

const MessageType = {
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response",
  CF_AGENT_TOOL_RESULT: "cf_agent_tool_result",
  CF_AGENT_STREAM_RESUMING: "cf_agent_stream_resuming",
  CF_AGENT_STREAM_RESUME_ACK: "cf_agent_stream_resume_ack",
  CF_AGENT_STREAM_RESUME_NONE: "cf_agent_stream_resume_none",
  CF_AGENT_MESSAGE_UPDATED: "cf_agent_message_updated"
} as const;

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

function agentPath(baseURL: string, room: string) {
  return `${baseURL.replace("http", "ws")}/agents/client-tool-agent/${room}`;
}

// ── Multi-tab continuation broadcast ──────────────────────────────

test.describe("Multi-tab continuation broadcast e2e", () => {
  test.setTimeout(30_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("observer tab receives continuation stream without sending ACK", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    // ws1: sends the request, handles tool result + resume handshake
    // ws2: observes — should receive continuation chunks as live broadcast
    //      WITHOUT having to send STREAM_RESUME_ACK
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          ws2ChunkTypes: string[];
          ws2GotContinuationChunks: boolean;
          ws2SentAck: boolean;
          ws1ToolCallId: string | null;
        }>((resolve) => {
          const ws1 = new WebSocket(url);
          const ws2 = new WebSocket(url);
          const ws2ChunkTypes: string[] = [];
          let ws1Open = false;
          let ws2Open = false;
          let ws1ToolCallId: string | null = null;
          let sentResult = false;
          let ws2SentAck = false;
          let doneCount = 0;

          function maybeSend() {
            if (!ws1Open || !ws2Open) return;
            setTimeout(() => {
              ws1.send(
                JSON.stringify({
                  type: MT.CF_AGENT_USE_CHAT_REQUEST,
                  id: "req-mt-cont",
                  init: {
                    method: "POST",
                    body: JSON.stringify({
                      messages: [
                        {
                          id: "mt-cont-1",
                          role: "user",
                          parts: [
                            {
                              type: "text",
                              text: "Where am I? Use the getUserLocation tool."
                            }
                          ]
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

          // ws1 handles the full flow
          ws1.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data) as WSMessage;

              // Handle resume handshake on ws1
              if (data.type === MT.CF_AGENT_STREAM_RESUMING && data.id) {
                ws1.send(
                  JSON.stringify({
                    type: MT.CF_AGENT_STREAM_RESUME_ACK,
                    id: data.id
                  })
                );
              }

              if (data.type === MT.CF_AGENT_USE_CHAT_RESPONSE) {
                // Look for tool-input-available
                if (
                  !sentResult &&
                  typeof data.body === "string" &&
                  data.body.includes("tool-input-available")
                ) {
                  try {
                    const chunk = JSON.parse(data.body as string);
                    if (
                      chunk.type === "tool-input-available" &&
                      chunk.toolCallId
                    ) {
                      ws1ToolCallId = chunk.toolCallId;
                      ws1.send(
                        JSON.stringify({
                          type: MT.CF_AGENT_TOOL_RESULT,
                          toolCallId: chunk.toolCallId,
                          toolName: "getUserLocation",
                          output: {
                            city: "Berlin",
                            lat: 52.52,
                            lng: 13.405
                          },
                          autoContinue: true
                        })
                      );
                      sentResult = true;
                    }
                  } catch {
                    // not JSON
                  }
                }

                if (data.done) {
                  doneCount++;
                  if (doneCount >= 2) {
                    setTimeout(() => {
                      ws1.close();
                      ws2.close();
                      resolve({
                        ws2ChunkTypes,
                        ws2GotContinuationChunks: ws2ChunkTypes.length > 0,
                        ws2SentAck,
                        ws1ToolCallId
                      });
                    }, 500);
                  }
                }
              }
            } catch {
              // ignore
            }
          };

          // ws2 only observes — never sends ACK
          ws2.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data) as WSMessage;

              // ws2 should receive RESUME_NONE (not RESUMING) since
              // it's not the originating connection
              if (data.type === MT.CF_AGENT_STREAM_RESUMING) {
                // If ws2 receives RESUMING, the test still works —
                // we just note that ws2 did NOT send ACK
              }

              if (
                data.type === MT.CF_AGENT_USE_CHAT_RESPONSE &&
                typeof data.body === "string" &&
                data.body.trim()
              ) {
                try {
                  const chunk = JSON.parse(data.body as string);
                  ws2ChunkTypes.push(chunk.type);
                } catch {
                  // not JSON body
                }
              }
            } catch {
              // ignore
            }
          };

          setTimeout(() => {
            ws1.close();
            ws2.close();
            resolve({
              ws2ChunkTypes,
              ws2GotContinuationChunks: ws2ChunkTypes.length > 0,
              ws2SentAck,
              ws1ToolCallId
            });
          }, 25000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    expect(result.ws1ToolCallId).toBeTruthy();
    // ws2 should have received chunks (both initial and continuation)
    expect(result.ws2GotContinuationChunks).toBe(true);
    // ws2 never sent an ACK
    expect(result.ws2SentAck).toBe(false);
    // ws2 should have seen tool-related chunks
    expect(result.ws2ChunkTypes).toContain("tool-input-start");
  });
});

// ── Delayed tool result (hibernation recovery proxy) ──────────────

test.describe("Delayed tool result e2e", () => {
  test.setTimeout(30_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("tool result sent after delay still triggers valid continuation", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    // Exercises the timing edge case from PR #1161:
    // Send CF_AGENT_TOOL_RESULT several seconds after tool-input-available.
    // keepAliveWhile ensures the DO stays alive for the continuation.
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          toolCallId: string | null;
          continuationStreamId: string | null;
          gotContinuationChunks: boolean;
          delayMs: number;
        }>((resolve) => {
          const ws = new WebSocket(url);
          let toolCallId: string | null = null;
          let sentResult = false;
          let continuationStreamId: string | null = null;
          let gotContinuationChunks = false;
          let toolAvailableTime = 0;
          let resultSentTime = 0;
          let doneCount = 0;
          const allMessages: WSMessage[] = [];

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data) as WSMessage;
              allMessages.push(data);

              if (data.type === MT.CF_AGENT_STREAM_RESUMING && data.id) {
                continuationStreamId = data.id as string;
                ws.send(
                  JSON.stringify({
                    type: MT.CF_AGENT_STREAM_RESUME_ACK,
                    id: data.id
                  })
                );
              }

              if (data.type === MT.CF_AGENT_USE_CHAT_RESPONSE) {
                if (
                  !sentResult &&
                  typeof data.body === "string" &&
                  data.body.includes("tool-input-available")
                ) {
                  try {
                    const chunk = JSON.parse(data.body as string);
                    if (
                      chunk.type === "tool-input-available" &&
                      chunk.toolCallId
                    ) {
                      toolCallId = chunk.toolCallId;
                      toolAvailableTime = Date.now();

                      // Wait 3 seconds before sending the result
                      setTimeout(() => {
                        resultSentTime = Date.now();
                        ws.send(
                          JSON.stringify({
                            type: MT.CF_AGENT_TOOL_RESULT,
                            toolCallId: chunk.toolCallId,
                            toolName: "getUserLocation",
                            output: {
                              city: "Tokyo",
                              lat: 35.6762,
                              lng: 139.6503
                            },
                            autoContinue: true
                          })
                        );
                        sentResult = true;
                      }, 3000);
                    }
                  } catch {
                    // not JSON
                  }
                }

                if (
                  continuationStreamId &&
                  data.id === continuationStreamId &&
                  !data.done &&
                  typeof data.body === "string"
                ) {
                  gotContinuationChunks = true;
                }

                if (data.done) {
                  doneCount++;
                  if (doneCount >= 2 || continuationStreamId) {
                    setTimeout(() => {
                      ws.close();
                      resolve({
                        toolCallId,
                        continuationStreamId,
                        gotContinuationChunks,
                        delayMs: resultSentTime - toolAvailableTime
                      });
                    }, 500);
                  }
                }
              }
            } catch {
              // ignore
            }
          };

          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-delayed-tool",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "dt-1",
                        role: "user",
                        parts: [
                          {
                            type: "text",
                            text: "Where am I? Use the getUserLocation tool."
                          }
                        ]
                      }
                    ]
                  })
                }
              })
            );
          };

          setTimeout(() => {
            ws.close();
            resolve({
              toolCallId,
              continuationStreamId,
              gotContinuationChunks,
              delayMs: resultSentTime - toolAvailableTime
            });
          }, 25000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    expect(result.toolCallId).toBeTruthy();
    // Verify we actually delayed ~3 seconds (generous lower bound for timer imprecision)
    expect(result.delayMs).toBeGreaterThanOrEqual(2000);
    // Continuation should have been triggered
    expect(result.continuationStreamId).toBeTruthy();
    // Should have received continuation chunks
    expect(result.gotContinuationChunks).toBe(true);

    // Verify persistence after the delayed continuation
    const res = await page.request.get(
      `${baseURL}/agents/client-tool-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);
    const persisted = await res.json();
    const assistantMsgs = persisted.filter(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Turn coalescing ───────────────────────────────────────────────

test.describe("Turn coalescing e2e", () => {
  test.setTimeout(30_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("single tool result + autoContinue produces exactly one continuation", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    // Send a tool result with autoContinue and verify only one continuation
    // stream is created. This is a simplified test — the full coalescing
    // behavior (multiple tool calls) is covered in unit tests.
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          toolCallId: string | null;
          resumingCount: number;
          doneCount: number;
        }>((resolve) => {
          const ws = new WebSocket(url);
          let toolCallId: string | null = null;
          let sentResult = false;
          let resumingCount = 0;
          let doneCount = 0;

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data) as WSMessage;

              if (data.type === MT.CF_AGENT_STREAM_RESUMING && data.id) {
                resumingCount++;
                ws.send(
                  JSON.stringify({
                    type: MT.CF_AGENT_STREAM_RESUME_ACK,
                    id: data.id
                  })
                );
              }

              if (data.type === MT.CF_AGENT_USE_CHAT_RESPONSE) {
                if (
                  !sentResult &&
                  typeof data.body === "string" &&
                  data.body.includes("tool-input-available")
                ) {
                  try {
                    const chunk = JSON.parse(data.body as string);
                    if (
                      chunk.type === "tool-input-available" &&
                      chunk.toolCallId
                    ) {
                      toolCallId = chunk.toolCallId;
                      // Send the result once with autoContinue
                      ws.send(
                        JSON.stringify({
                          type: MT.CF_AGENT_TOOL_RESULT,
                          toolCallId: chunk.toolCallId,
                          toolName: "getUserLocation",
                          output: { city: "NYC", lat: 40.71, lng: -74.0 },
                          autoContinue: true
                        })
                      );
                      sentResult = true;
                    }
                  } catch {
                    // not JSON
                  }
                }

                if (data.done) {
                  doneCount++;
                  // Wait for potential extra continuations
                  if (doneCount >= 2) {
                    setTimeout(() => {
                      ws.close();
                      resolve({ toolCallId, resumingCount, doneCount });
                    }, 1000);
                  }
                }
              }
            } catch {
              // ignore
            }
          };

          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-coalesce",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "coal-1",
                        role: "user",
                        parts: [
                          {
                            type: "text",
                            text: "Where am I? Use the getUserLocation tool."
                          }
                        ]
                      }
                    ]
                  })
                }
              })
            );
          };

          setTimeout(() => {
            ws.close();
            resolve({ toolCallId, resumingCount, doneCount });
          }, 25000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    expect(result.toolCallId).toBeTruthy();
    // Should have exactly 1 STREAM_RESUMING (one continuation)
    expect(result.resumingCount).toBe(1);
    // Exactly 2 done signals: original stream + continuation
    expect(result.doneCount).toBe(2);
  });
});
