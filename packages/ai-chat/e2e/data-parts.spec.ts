import { test, expect } from "@playwright/test";

/**
 * E2E tests for data-* parts in the streaming protocol.
 *
 * Data parts are developer-defined typed JSON blobs that flow through the
 * SSE stream. They come in two flavors:
 * - Persistent: added to message.parts and stored in SQLite
 * - Transient: broadcast to connected clients but NOT persisted
 *
 * Uses DataPartsAgent which emits a custom SSE stream with both types.
 */

const MessageType = {
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response"
} as const;

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

function agentPath(baseURL: string, room: string) {
  return `${baseURL.replace("http", "ws")}/agents/data-parts-agent/${room}`;
}

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

test.describe("Data parts e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("transient data parts appear in stream but not in persisted messages", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    const messages = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<WSMessage[]>((resolve) => {
          const ws = new WebSocket(url);
          const received: WSMessage[] = [];

          ws.onmessage = (e) => {
            try {
              received.push(JSON.parse(e.data as string));
            } catch {
              // ignore
            }
          };

          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-data-1",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "msg-data-1",
                        role: "user",
                        parts: [{ type: "text", text: "Give me data" }]
                      }
                    ]
                  })
                }
              })
            );

            const check = setInterval(() => {
              const doneMsg = received.find(
                (m) =>
                  m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && m.done === true
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
            }, 10000);
          };
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    const chunks = extractChunkBodies(messages);
    const chunkTypes = chunks.map((c) => c.type);

    // Should have text content
    expect(chunkTypes).toContain("text-start");
    expect(chunkTypes).toContain("text-delta");
    expect(chunkTypes).toContain("text-end");

    // The transient data-progress chunk should appear in the stream
    const progressChunk = chunks.find((c) => c.type === "data-progress");
    expect(progressChunk).toBeTruthy();
    expect(progressChunk!.transient).toBe(true);
    expect(progressChunk!.data).toEqual({ percent: 50 });

    // The persistent data-result chunk should appear in the stream
    const resultChunk = chunks.find((c) => c.type === "data-result");
    expect(resultChunk).toBeTruthy();
    expect(resultChunk!.data).toEqual({ answer: 42 });

    // Now check persistence
    const res = await page.request.get(
      `${baseURL}/agents/data-parts-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);

    const persisted = await res.json();
    const assistantMsg = persisted.find(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistantMsg).toBeTruthy();

    // Persistent data-result part should be in the stored message
    const dataResultPart = assistantMsg.parts.find(
      (p: { type: string }) => p.type === "data-result"
    );
    expect(dataResultPart).toBeTruthy();
    expect(dataResultPart.data).toEqual({ answer: 42 });

    // Transient data-progress part should NOT be in the stored message
    const dataProgressPart = assistantMsg.parts.find(
      (p: { type: string }) => p.type === "data-progress"
    );
    expect(dataProgressPart).toBeUndefined();
  });

  test("second connection receives data parts via broadcast", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          ws2DataChunks: Array<{ type: string; [k: string]: unknown }>;
        }>((resolve) => {
          const ws1 = new WebSocket(url);
          const ws2 = new WebSocket(url);
          const ws2DataChunks: Array<{ type: string; [k: string]: unknown }> =
            [];
          let ws1Open = false;
          let ws2Open = false;

          function maybeSend() {
            if (!ws1Open || !ws2Open) return;
            setTimeout(() => {
              ws1.send(
                JSON.stringify({
                  type: MT.CF_AGENT_USE_CHAT_REQUEST,
                  id: "req-data-broadcast",
                  init: {
                    method: "POST",
                    body: JSON.stringify({
                      messages: [
                        {
                          id: "msg-db-1",
                          role: "user",
                          parts: [{ type: "text", text: "Give me data" }]
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
                  if (chunk.type.startsWith("data-")) {
                    ws2DataChunks.push(chunk);
                  }
                } catch {
                  // not JSON body
                }
              }
            } catch {
              // ignore
            }
          };

          const ws1Messages: WSMessage[] = [];
          ws1.onmessage = (e) => {
            try {
              ws1Messages.push(JSON.parse(e.data));
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
                resolve({ ws2DataChunks });
              }, 300);
            }
          }, 100);

          setTimeout(() => {
            clearInterval(check);
            ws1.close();
            ws2.close();
            resolve({ ws2DataChunks });
          }, 10000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    // ws2 should have seen data chunks via broadcast.
    // Both transient and persistent data parts are broadcast to observers.
    expect(result.ws2DataChunks.length).toBeGreaterThanOrEqual(1);

    const hasAnyDataPart = result.ws2DataChunks.some(
      (c) => c.type === "data-progress" || c.type === "data-result"
    );
    expect(hasAnyDataPart).toBe(true);
  });
});
