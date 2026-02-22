import { test, expect } from "@playwright/test";

/**
 * E2E tests for client-side tool results and auto-continuation.
 * Uses ClientToolAgent which defines a tool without `execute`,
 * so the LLM calls it but the server waits for CF_AGENT_TOOL_RESULT from the client.
 */

const MessageType = {
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response",
  CF_AGENT_TOOL_RESULT: "cf_agent_tool_result",
  CF_AGENT_TOOL_APPROVAL: "cf_agent_tool_approval",
  CF_AGENT_MESSAGE_UPDATED: "cf_agent_message_updated"
} as const;

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

function agentPath(baseURL: string, room: string) {
  return `${baseURL.replace("http", "ws")}/agents/client-tool-agent/${room}`;
}

test.describe("Client-side tool results e2e", () => {
  test.setTimeout(30_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("client tool round-trip: LLM calls tool, client sends result, server broadcasts update", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    // This test:
    // 1. Sends a message that triggers the LLM to call getUserLocation
    // 2. Waits for tool-input-available in the stream
    // 3. Sends CF_AGENT_TOOL_RESULT with the "location"
    // 4. Verifies CF_AGENT_MESSAGE_UPDATED is received with the output
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          streamMessages: WSMessage[];
          updatedMessages: WSMessage[];
          toolCallId: string | null;
        }>((resolve) => {
          const ws = new WebSocket(url);
          const streamMessages: WSMessage[] = [];
          const updatedMessages: WSMessage[] = [];
          let toolCallId: string | null = null;
          let sentResult = false;

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data) as WSMessage;

              if (data.type === MT.CF_AGENT_USE_CHAT_RESPONSE) {
                streamMessages.push(data);

                // Look for tool-input-available in the stream body
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
                      // Send tool result back to server
                      ws.send(
                        JSON.stringify({
                          type: MT.CF_AGENT_TOOL_RESULT,
                          toolCallId: chunk.toolCallId,
                          toolName: "getUserLocation",
                          output: {
                            lat: 51.5074,
                            lng: -0.1278,
                            city: "London"
                          },
                          autoContinue: false
                        })
                      );
                      sentResult = true;
                    }
                  } catch {
                    // not JSON
                  }
                }

                // Check for done
                if (data.done) {
                  // Wait a bit for MESSAGE_UPDATED to arrive
                  setTimeout(() => {
                    ws.close();
                    resolve({ streamMessages, updatedMessages, toolCallId });
                  }, 1000);
                }
              } else if (data.type === MT.CF_AGENT_MESSAGE_UPDATED) {
                updatedMessages.push(data);
              }
            } catch {
              // ignore
            }
          };

          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-client-tool",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "msg-ct-1",
                        role: "user",
                        parts: [
                          {
                            type: "text",
                            text: "What is my current location? Use the getUserLocation tool."
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
            resolve({ streamMessages, updatedMessages, toolCallId });
          }, 20000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    // The LLM should have called the tool
    expect(result.toolCallId).toBeTruthy();

    // The server now broadcasts CF_AGENT_MESSAGE_UPDATED for streaming
    // messages too, so clients get immediate confirmation.
    expect(result.updatedMessages.length).toBeGreaterThanOrEqual(1);

    const updateMsg = result.updatedMessages[0];
    expect(updateMsg.type).toBe(MessageType.CF_AGENT_MESSAGE_UPDATED);
    const message = updateMsg.message as {
      parts: Array<{
        toolCallId?: string;
        state?: string;
        output?: unknown;
      }>;
    };
    const toolPart = message.parts.find(
      (p) => p.toolCallId === result.toolCallId
    );
    expect(toolPart).toBeTruthy();
    expect(toolPart!.state).toBe("output-available");
    expect(toolPart!.output).toEqual({
      lat: 51.5074,
      lng: -0.1278,
      city: "London"
    });

    // Also verify persistence after stream completes
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

  test("auto-continuation: server continues conversation after receiving tool result", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          allMessages: WSMessage[];
          continuationReceived: boolean;
          toolCallId: string | null;
        }>((resolve) => {
          const ws = new WebSocket(url);
          const allMessages: WSMessage[] = [];
          let toolCallId: string | null = null;
          let sentResult = false;
          let doneCount = 0;
          let continuationReceived = false;

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data) as WSMessage;
              allMessages.push(data);

              if (data.type === MT.CF_AGENT_USE_CHAT_RESPONSE) {
                // Check for continuation flag
                if (data.continuation === true) {
                  continuationReceived = true;
                }

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
                      toolCallId = chunk.toolCallId;
                      // Send tool result with autoContinue=true
                      ws.send(
                        JSON.stringify({
                          type: MT.CF_AGENT_TOOL_RESULT,
                          toolCallId: chunk.toolCallId,
                          toolName: "getUserLocation",
                          output: { city: "Paris", lat: 48.8566, lng: 2.3522 },
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
                  // With auto-continuation, we expect 2 done signals:
                  // 1st from the original stream, 2nd from the continuation.
                  // Wait for both, but also handle the case where continuation
                  // arrives in a single stream.
                  if (
                    doneCount >= 2 ||
                    (doneCount >= 1 && continuationReceived)
                  ) {
                    setTimeout(() => {
                      ws.close();
                      resolve({
                        allMessages,
                        continuationReceived,
                        toolCallId
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
                id: "req-auto-cont",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "msg-ac-1",
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
            resolve({ allMessages, continuationReceived, toolCallId });
          }, 25000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    expect(result.toolCallId).toBeTruthy();

    // With autoContinue=true, the server should have sent a continuation stream
    // The continuation messages have continuation: true flag
    expect(result.continuationReceived).toBe(true);

    // The continuation should include text from the LLM responding to the tool result
    const continuationChunks = result.allMessages.filter(
      (m) =>
        m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        m.continuation === true &&
        typeof m.body === "string" &&
        (m.body as string).trim()
    );
    expect(continuationChunks.length).toBeGreaterThan(0);
  });
});

test.describe("Tool approval auto-continuation e2e", () => {
  test.setTimeout(30_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("tool approval with autoContinue triggers continuation stream", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    // This test:
    // 1. Sends a message that triggers the LLM to call getUserLocation
    // 2. Waits for tool-input-available in the stream
    // 3. Sends CF_AGENT_TOOL_APPROVAL (instead of TOOL_RESULT) with autoContinue
    // 4. Verifies continuation messages are received
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          allMessages: WSMessage[];
          continuationReceived: boolean;
          toolCallId: string | null;
          approvalSent: boolean;
        }>((resolve) => {
          const ws = new WebSocket(url);
          const allMessages: WSMessage[] = [];
          let toolCallId: string | null = null;
          let sentApproval = false;
          let doneCount = 0;
          let continuationReceived = false;

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data) as WSMessage;
              allMessages.push(data);

              if (data.type === MT.CF_AGENT_USE_CHAT_RESPONSE) {
                if (data.continuation === true) {
                  continuationReceived = true;
                }

                // Look for tool-input-available
                if (
                  !sentApproval &&
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
                      // Send tool APPROVAL with autoContinue
                      ws.send(
                        JSON.stringify({
                          type: MT.CF_AGENT_TOOL_APPROVAL,
                          toolCallId: chunk.toolCallId,
                          approved: true,
                          autoContinue: true
                        })
                      );
                      sentApproval = true;
                    }
                  } catch {
                    // not JSON
                  }
                }

                if (data.done) {
                  doneCount++;
                  // With auto-continuation, we expect 2 done signals
                  if (
                    doneCount >= 2 ||
                    (doneCount >= 1 && continuationReceived)
                  ) {
                    setTimeout(() => {
                      ws.close();
                      resolve({
                        allMessages,
                        continuationReceived,
                        toolCallId,
                        approvalSent: sentApproval
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
                id: "req-approval-cont",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "msg-appr-1",
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
              allMessages,
              continuationReceived,
              toolCallId,
              approvalSent: sentApproval
            });
          }, 25000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    // The LLM should have called the tool
    expect(result.toolCallId).toBeTruthy();
    expect(result.approvalSent).toBe(true);

    // With autoContinue=true on approval, the server should send continuation
    expect(result.continuationReceived).toBe(true);

    // The continuation should include response chunks
    const continuationChunks = result.allMessages.filter(
      (m) =>
        m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        m.continuation === true &&
        typeof m.body === "string" &&
        (m.body as string).trim()
    );
    expect(continuationChunks.length).toBeGreaterThan(0);

    // Verify persistence
    const res = await page.request.get(
      `${baseURL}/agents/client-tool-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);
    const persisted = await res.json();
    const assistantMsgs = persisted.filter(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

    // The tool part should be in approval-responded state
    const assistantMsg = assistantMsgs[0];
    const toolPart = assistantMsg.parts.find(
      (p: { toolCallId?: string }) => p.toolCallId === result.toolCallId
    );
    expect(toolPart).toBeTruthy();
    expect(toolPart.state).toBe("approval-responded");
    expect(toolPart.approval).toEqual({ approved: true });
  });
});
