import { test, expect } from "@playwright/test";

/**
 * E2E tests that make real LLM calls via Workers AI (@cf/zai-org/glm-4.7-flash).
 * These verify the full streaming pipeline: streamText → SSE → WebSocket → client.
 *
 * Uses the AI binding configured in wrangler.jsonc -- no API key needed.
 * The only OpenAI usage is BadKeyAgent, which tests error handling with an invalid key.
 */

const MessageType = {
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response",
  CF_AGENT_CHAT_CLEAR: "cf_agent_chat_clear"
} as const;

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

function agentPath(baseURL: string, room: string) {
  return `${baseURL.replace("http", "ws")}/agents/llm-chat-agent/${room}`;
}

/**
 * Opens a WebSocket, sends a chat request, collects all messages until done.
 */
async function sendChatAndCollect(
  page: import("@playwright/test").Page,
  wsUrl: string,
  userMessage: string,
  requestId: string,
  timeoutMs = 15000
): Promise<WSMessage[]> {
  return page.evaluate(
    ({ url, userMessage, requestId, timeoutMs, MT }) => {
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
          ws.send(
            JSON.stringify({
              type: MT.CF_AGENT_USE_CHAT_REQUEST,
              id: requestId,
              init: {
                method: "POST",
                body: JSON.stringify({
                  messages: [
                    {
                      id: `msg-${requestId}`,
                      role: "user",
                      parts: [{ type: "text", text: userMessage }]
                    }
                  ]
                })
              }
            })
          );

          const check = setInterval(() => {
            const doneMsg = received.find(
              (m) => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done === true
            );
            if (doneMsg) {
              clearInterval(check);
              ws.close();
              resolve(received);
            }
          }, 100);

          setTimeout(() => {
            clearInterval(check);
            ws.close();
            resolve(received);
          }, timeoutMs);
        };
      });
    },
    { url: wsUrl, userMessage, requestId, timeoutMs, MT: MessageType }
  );
}

/** Extract parsed chunk bodies from stream responses */
function extractChunkBodies(
  messages: WSMessage[]
): Array<{ type: string; [k: string]: unknown }> {
  return messages
    .filter(
      (m) =>
        m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        !m.done &&
        typeof m.body === "string" &&
        (m.body as string).trim()
    )
    .map((m) => JSON.parse(m.body as string));
}

test.describe("LLM e2e (Workers AI)", () => {
  // Longer timeout for real LLM calls
  test.setTimeout(30_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("SSE streaming: receives text-start, text-delta(s), text-end from real model", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const messages = await sendChatAndCollect(
      page,
      agentPath(baseURL!, room),
      "Say hello in exactly 3 words.",
      "req-sse-1"
    );

    const chunks = extractChunkBodies(messages);
    const types = chunks.map((c) => c.type);

    // Should have SSE format (not plain text format)
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");

    // Accumulate the text deltas
    const fullText = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta as string)
      .join("");

    // Model should have responded with something
    expect(fullText.length).toBeGreaterThan(0);
    console.log("LLM response:", fullText);

    // Should have start/finish lifecycle events
    expect(types).toContain("start");
    expect(types).toContain("finish");
  });

  test("server-side tool call: model calls getWeather and returns result", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const messages = await sendChatAndCollect(
      page,
      agentPath(baseURL!, room),
      "What is the weather in London?",
      "req-tool-1"
    );

    const chunks = extractChunkBodies(messages);
    const types = chunks.map((c) => c.type);

    // Should have tool lifecycle events
    // The model should call getWeather, which executes server-side,
    // and then continue with text output
    expect(types).toContain("tool-input-start");
    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-output-available");

    // Find the tool-input-available chunk
    const toolInput = chunks.find((c) => c.type === "tool-input-available");
    expect(toolInput).toBeTruthy();
    expect(toolInput!.toolName).toBe("getWeather");

    // Find the tool-output-available chunk — the execute function returns mocked data
    const toolOutput = chunks.find((c) => c.type === "tool-output-available");
    expect(toolOutput).toBeTruthy();
    const output = toolOutput!.output as { city: string; temperature: number };
    expect(output.city).toBe("London");
    expect(output.temperature).toBe(22);

    // After the tool result, the model should continue with text
    // (maxSteps=3 allows continuation). The model usually responds with text,
    // but may occasionally stop after the tool result.
    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    if (textDeltas.length > 0) {
      const fullText = textDeltas.map((c) => c.delta as string).join("");
      console.log("Tool call response:", fullText);
      expect(fullText.length).toBeGreaterThan(0);
    } else {
      // Model stopped after tool result — this is valid behavior
      console.log("Model did not produce text after tool result (valid)");
    }
  });

  test("message persistence with real LLM: messages survive reconnection", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();

    // Send a message
    await sendChatAndCollect(
      page,
      agentPath(baseURL!, room),
      "Remember the number 42.",
      "req-persist-llm"
    );

    // Check persistence via HTTP
    const res = await page.request.get(
      `${baseURL}/agents/llm-chat-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);

    const persisted = await res.json();
    expect(persisted.length).toBeGreaterThanOrEqual(2); // user + assistant

    // User message
    const userMsg = persisted.find(
      (m: { id: string }) => m.id === "msg-req-persist-llm"
    );
    expect(userMsg).toBeTruthy();
    expect(userMsg.role).toBe("user");

    // Assistant message should have text parts from the real LLM response
    const assistantMsgs = persisted.filter(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

    const assistantParts = assistantMsgs[0].parts;
    const textParts = assistantParts.filter(
      (p: { type: string }) => p.type === "text"
    );
    expect(textParts.length).toBeGreaterThanOrEqual(1);
    expect(textParts[0].text.length).toBeGreaterThan(0);
  });

  test("multi-step tool use: model uses addNumbers tool", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const messages = await sendChatAndCollect(
      page,
      agentPath(baseURL!, room),
      "What is 17 + 25? Use the addNumbers tool to calculate.",
      "req-math-1"
    );

    const chunks = extractChunkBodies(messages);

    // Should have called addNumbers tool
    const toolInput = chunks.find(
      (c) => c.type === "tool-input-available" && c.toolName === "addNumbers"
    );
    expect(toolInput).toBeTruthy();

    // Tool output should have the correct result
    const toolOutput = chunks.find((c) => c.type === "tool-output-available");
    expect(toolOutput).toBeTruthy();
    const output = toolOutput!.output as { result: number };
    expect(output.result).toBe(42);

    // Model should have continued with text mentioning the result
    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    if (textDeltas.length > 0) {
      const fullText = textDeltas.map((c) => c.delta as string).join("");
      console.log("Math response:", fullText);
      // The model should mention 42 somewhere in its response
      expect(fullText).toContain("42");
    } else {
      console.log("Model did not produce text after tool result (valid)");
    }
  });

  test("step boundaries: multi-step response has start-step and finish-step", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const messages = await sendChatAndCollect(
      page,
      agentPath(baseURL!, room),
      "What is the weather in Paris? Use the getWeather tool.",
      "req-steps-1"
    );

    const chunks = extractChunkBodies(messages);
    const types = chunks.map((c) => c.type);

    // Multi-step responses should have step boundaries
    expect(types).toContain("start-step");
    expect(types).toContain("finish-step");

    // Should have at least 1 step (the tool call step).
    // With maxSteps=3, the model may also produce a continuation step.
    const startSteps = types.filter((t) => t === "start-step").length;
    expect(startSteps).toBeGreaterThanOrEqual(1);

    // Tool lifecycle should be present in the steps
    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-output-available");
  });

  test("clear history works after LLM conversation", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    // Have a conversation
    await sendChatAndCollect(page, wsUrl, "Hello!", "req-clear-llm");

    // Verify messages exist
    const before = await page.request.get(
      `${baseURL}/agents/llm-chat-agent/${room}/get-messages`
    );
    const beforeData = await before.json();
    expect(beforeData.length).toBeGreaterThanOrEqual(2);

    // Clear
    await page.evaluate(
      ({ url, MT }) => {
        return new Promise<void>((resolve) => {
          const ws = new WebSocket(url);
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: MT.CF_AGENT_CHAT_CLEAR }));
            setTimeout(() => {
              ws.close();
              resolve();
            }, 500);
          };
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    // Verify cleared
    const after = await page.request.get(
      `${baseURL}/agents/llm-chat-agent/${room}/get-messages`
    );
    const afterData = await after.json();
    expect(afterData.length).toBe(0);
  });

  test("multi-turn context: LLM remembers previous messages", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    // First turn: tell the model a fact
    await sendChatAndCollect(
      page,
      wsUrl,
      "My name is Alice. Remember that.",
      "req-ctx-1"
    );

    // Second turn: ask about the fact, including the first message
    // (as the client would — the full conversation history is sent)
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
                  id: "req-ctx-2",
                  init: {
                    method: "POST",
                    body: JSON.stringify({
                      messages: [
                        {
                          id: "msg-req-ctx-1",
                          role: "user",
                          parts: [
                            {
                              type: "text",
                              text: "My name is Alice. Remember that."
                            }
                          ]
                        },
                        {
                          id: "msg-req-ctx-2",
                          role: "user",
                          parts: [{ type: "text", text: "What is my name?" }]
                        }
                      ]
                    })
                  }
                })
              );

              const check = setInterval(() => {
                const done = received.find(
                  (m) =>
                    m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done === true
                );
                if (done) {
                  clearInterval(check);
                  ws.close();
                  resolve(received);
                }
              }, 100);

              setTimeout(() => {
                clearInterval(check);
                ws.close();
                resolve(received);
              }, 15000);
            };
          }
        );
      },
      { url: wsUrl, MT: MessageType }
    );

    // Extract text from the response
    const chunks = extractChunkBodies(messages);
    const fullText = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta as string)
      .join("");

    console.log("Context response:", fullText);
    // Model should mention "Alice" since it has the context
    expect(fullText.toLowerCase()).toContain("alice");
  });

  test("OpenAI metadata sanitization: no itemId in persisted messages", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();

    // Have a conversation to generate messages with OpenAI metadata
    await sendChatAndCollect(
      page,
      agentPath(baseURL!, room),
      "Tell me a short fun fact.",
      "req-sanitize"
    );

    // Fetch persisted messages
    const res = await page.request.get(
      `${baseURL}/agents/llm-chat-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);
    const persisted = await res.json();

    // Check that no part has providerMetadata.openai.itemId
    for (const msg of persisted) {
      for (const part of msg.parts || []) {
        if (part.providerMetadata?.openai) {
          expect(part.providerMetadata.openai.itemId).toBeUndefined();
          expect(
            part.providerMetadata.openai.reasoningEncryptedContent
          ).toBeUndefined();
        }
        if (part.callProviderMetadata?.openai) {
          expect(part.callProviderMetadata.openai.itemId).toBeUndefined();
        }
      }
    }

    // Also verify messages actually exist and have content
    expect(persisted.length).toBeGreaterThanOrEqual(2);
    const assistant = persisted.find(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistant).toBeTruthy();
    expect(assistant.parts.length).toBeGreaterThan(0);
  });

  test("multi-tab tool streaming: second connection sees tool-input-start and tool-output-available", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    // Open two connections to the same room.
    // ws1 sends the request, ws2 observes the broadcast.
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          ws2ChunkTypes: string[];
          ws2HasToolInputStart: boolean;
          ws2HasToolOutputAvailable: boolean;
        }>((resolve) => {
          const ws1 = new WebSocket(url);
          const ws2 = new WebSocket(url);
          const ws2ChunkTypes: string[] = [];
          let ws1Open = false;
          let ws2Open = false;

          function maybeSend() {
            if (!ws1Open || !ws2Open) return;
            setTimeout(() => {
              ws1.send(
                JSON.stringify({
                  type: MT.CF_AGENT_USE_CHAT_REQUEST,
                  id: "req-multi-tab-tool",
                  init: {
                    method: "POST",
                    body: JSON.stringify({
                      messages: [
                        {
                          id: "mtt-1",
                          role: "user",
                          parts: [
                            {
                              type: "text",
                              text: "What is the weather in Tokyo? Use the getWeather tool."
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

          // Collect chunk types from ws2 (the observer)
          ws2.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              if (
                data.type === MT.CF_AGENT_USE_CHAT_RESPONSE &&
                typeof data.body === "string" &&
                data.body.trim()
              ) {
                try {
                  const chunk = JSON.parse(data.body);
                  ws2ChunkTypes.push(chunk.type);
                } catch {
                  // not JSON body
                }
              }
            } catch {
              // ignore
            }
          };

          // Wait for ws1 to get done signal
          const ws1Messages: Array<{
            type: string;
            [k: string]: unknown;
          }> = [];
          ws1.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              ws1Messages.push(data);
            } catch {
              // ignore
            }
          };

          const check = setInterval(() => {
            const done = ws1Messages.find(
              (m) => m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done === true
            );
            if (done) {
              clearInterval(check);
              setTimeout(() => {
                ws1.close();
                ws2.close();
                resolve({
                  ws2ChunkTypes,
                  ws2HasToolInputStart:
                    ws2ChunkTypes.includes("tool-input-start"),
                  ws2HasToolOutputAvailable: ws2ChunkTypes.includes(
                    "tool-output-available"
                  )
                });
              }, 300);
            }
          }, 100);

          setTimeout(() => {
            clearInterval(check);
            ws1.close();
            ws2.close();
            resolve({
              ws2ChunkTypes,
              ws2HasToolInputStart: ws2ChunkTypes.includes("tool-input-start"),
              ws2HasToolOutputAvailable: ws2ChunkTypes.includes(
                "tool-output-available"
              )
            });
          }, 20000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    // ws2 should see the full tool lifecycle streamed to it
    expect(result.ws2ChunkTypes.length).toBeGreaterThan(0);
    // Should see tool-input-start (the tool being called)
    expect(result.ws2HasToolInputStart).toBe(true);
    // Should see tool-output-available (the tool result)
    expect(result.ws2HasToolOutputAvailable).toBe(true);
  });
});
