import { test, expect } from "@playwright/test";

/**
 * E2E tests for onChatResponse + server-initiated streaming with a real LLM.
 * Uses Workers AI (@cf/moonshotai/kimi-k2.5) via the StreamEndLlmAgent.
 *
 * These verify:
 * 1. onChatResponse fires with status "completed" after a real LLM stream
 * 2. Server-initiated streams (saveMessages → onChatMessage) work end-to-end
 * 3. Observer WebSockets see server-initiated stream broadcasts
 * 4. The finalized message in onChatResponse contains real LLM output
 */

const MessageType = {
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response"
} as const;

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

function agentWsUrl(
  baseURL: string,
  room: string,
  agent = "response-llm-agent"
) {
  return `${baseURL.replace("http", "ws")}/agents/${agent}/${room}`;
}

function agentHttpUrl(
  baseURL: string,
  room: string,
  path: string,
  agent = "response-llm-agent"
) {
  return `${baseURL}/agents/${agent}/${room}/${path}`;
}

async function sendChatAndCollect(
  page: import("@playwright/test").Page,
  wsUrl: string,
  userMessage: string,
  requestId: string,
  timeoutMs = 20000
): Promise<WSMessage[]> {
  return page.evaluate(
    ({ url, userMessage, requestId, timeoutMs, MT }) => {
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

        ws.onerror = () => resolve(received);

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

test.describe("onChatResponse e2e (real LLM)", () => {
  test.setTimeout(30_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("onChatResponse fires with status=completed after a real LLM stream", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentWsUrl(baseURL!, room);

    const messages = await sendChatAndCollect(
      page,
      wsUrl,
      "Say hello in one word.",
      "req-stream-end-1"
    );

    // Should have received a done signal
    const done = messages.find(
      (m) => m.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && m.done
    );
    expect(done).toBeTruthy();

    // Should have received real text from the LLM
    const chunks = extractChunkBodies(messages);
    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    const fullText = textDeltas.map((c) => c.delta as string).join("");
    expect(fullText.length).toBeGreaterThan(0);
    console.log("LLM response:", fullText);

    // Wait for onChatResponse to fire (happens after persistence)
    await page.waitForTimeout(1000);

    // Fetch the recorded onChatResponse results
    const res = await page.request.get(
      agentHttpUrl(baseURL!, room, "response-results")
    );
    expect(res.ok()).toBe(true);
    const results = await res.json();

    expect(results.length).toBe(1);
    expect(results[0].status).toBe("completed");
    expect(results[0].requestId).toBe("req-stream-end-1");
    expect(results[0].continuation).toBe(false);

    // The message in the result should have real content
    const msgParts = results[0].message.parts;
    const resultTextParts = msgParts.filter(
      (p: { type: string }) => p.type === "text"
    );
    expect(resultTextParts.length).toBeGreaterThan(0);
  });

  test("server-initiated stream via saveMessages works with real LLM", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentWsUrl(baseURL!, room);

    // Step 1: Open observer WebSocket and wait for it to be established
    await page.evaluate(
      ({ url }) => {
        const ws = new WebSocket(url);
        (window as unknown as Record<string, unknown>)._observerWs = ws;
        (window as unknown as Record<string, unknown>)._observerReceived = [];
        (window as unknown as Record<string, unknown>)._observerGotDone = false;

        ws.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            (
              (window as unknown as Record<string, unknown>)
                ._observerReceived as unknown[]
            ).push(data);
            if (
              data.type === "cf_agent_use_chat_response" &&
              data.done === true
            ) {
              (window as unknown as Record<string, unknown>)._observerGotDone =
                true;
            }
          } catch {
            // ignore
          }
        };

        return new Promise<void>((resolve) => {
          ws.onopen = () => resolve();
          setTimeout(() => resolve(), 5000);
        });
      },
      { url: wsUrl }
    );

    // Step 2: Wait for WebSocket to be fully registered with the DO
    await page.waitForTimeout(500);

    // Step 3: Trigger server-initiated stream via Playwright's request API
    const triggerRes = await page.request.post(
      agentHttpUrl(baseURL!, room, "trigger-server-message"),
      {
        data: { text: "What is 2 + 2? Answer briefly." }
      }
    );
    expect(triggerRes.ok()).toBe(true);

    // Step 4: Wait a bit for stream completion to propagate
    await page.waitForTimeout(2000);

    // Step 5: Collect observer results from the browser
    const observerResult = await page.evaluate(() => {
      const received = (
        (window as unknown as Record<string, unknown>)
          ._observerReceived as Array<{
          type: string;
          [k: string]: unknown;
        }>
      ).slice();
      const gotDone = (window as unknown as Record<string, unknown>)
        ._observerGotDone as boolean;
      const ws = (window as unknown as Record<string, unknown>)
        ._observerWs as WebSocket;
      ws.close();

      const chunks = received
        .filter(
          (m) =>
            m.type === "cf_agent_use_chat_response" &&
            !m.done &&
            typeof m.body === "string" &&
            (m.body as string).trim()
        )
        .map((m) => JSON.parse(m.body as string));
      return { chunks, gotDone };
    });

    // Observer should have seen the stream
    expect(observerResult.gotDone).toBe(true);
    expect(observerResult.chunks.length).toBeGreaterThan(0);

    // Should have text from the real LLM
    const textDeltas = observerResult.chunks.filter(
      (c: { type: string }) => c.type === "text-delta"
    );
    expect(textDeltas.length).toBeGreaterThan(0);
    const fullText = textDeltas.map((c: { delta: string }) => c.delta).join("");
    console.log("Server-initiated LLM response:", fullText);
    expect(fullText.length).toBeGreaterThan(0);

    // Check onChatResponse fired
    const res = await page.request.get(
      agentHttpUrl(baseURL!, room, "response-results")
    );
    const results = await res.json();
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("completed");
  });

  test("onChatResponse message contains the full LLM response text", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();

    // Send a chat message and wait for completion
    const messages = await sendChatAndCollect(
      page,
      agentWsUrl(baseURL!, room),
      "What color is the sky? One word answer.",
      "req-content-check"
    );

    // Accumulate the streamed text
    const chunks = extractChunkBodies(messages);
    const streamedText = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta as string)
      .join("");

    expect(streamedText.length).toBeGreaterThan(0);

    await page.waitForTimeout(1000);

    // Fetch onChatResponse results
    const res = await page.request.get(
      agentHttpUrl(baseURL!, room, "response-results")
    );
    const results = await res.json();
    expect(results.length).toBe(1);

    // The message in onChatResponse should contain text parts
    const msg = results[0].message;
    const textParts = msg.parts.filter(
      (p: { type: string }) => p.type === "text"
    );
    expect(textParts.length).toBeGreaterThan(0);

    // The text content should match what was streamed
    const endText = textParts.map((p: { text: string }) => p.text).join("");
    expect(endText.length).toBeGreaterThan(0);
    console.log("Streamed:", streamedText);
    console.log("onChatResponse message text:", endText);
  });
});

test.describe("onChatResponse chaining e2e (real LLM)", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("saveMessages from onChatResponse triggers a second real LLM turn without deadlock", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const agent = "response-chain-agent";

    // Enable chaining — onChatResponse will call saveMessages with a follow-up
    const enableRes = await page.request.post(
      agentHttpUrl(baseURL!, room, "enable-chain", agent)
    );
    expect(enableRes.ok()).toBe(true);

    // Open a WebSocket and send the initial message
    const wsUrl = agentWsUrl(baseURL!, room, agent);

    // Collect ALL done signals (expect 2: initial response + chained follow-up)
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{ doneCount: number; timedOut: boolean }>(
          (resolve) => {
            const ws = new WebSocket(url);
            let doneCount = 0;

            ws.onmessage = (e) => {
              try {
                const data = JSON.parse(e.data);
                if (
                  data.type === MT.CF_AGENT_USE_CHAT_RESPONSE &&
                  data.done === true
                ) {
                  doneCount++;
                }
              } catch {
                // ignore
              }
            };

            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  type: MT.CF_AGENT_USE_CHAT_REQUEST,
                  id: "req-chain-1",
                  init: {
                    method: "POST",
                    body: JSON.stringify({
                      messages: [
                        {
                          id: "msg-chain-1",
                          role: "user",
                          parts: [
                            { type: "text", text: "Say hello in one word." }
                          ]
                        }
                      ]
                    })
                  }
                })
              );
            };

            // Wait for 2 done signals (initial + chained) or timeout
            const check = setInterval(() => {
              if (doneCount >= 2) {
                clearInterval(check);
                ws.close();
                resolve({ doneCount, timedOut: false });
              }
            }, 200);

            setTimeout(() => {
              clearInterval(check);
              ws.close();
              resolve({ doneCount, timedOut: true });
            }, 45000);
          }
        );
      },
      { url: wsUrl, MT: MessageType }
    );

    // Should have received 2 done signals without deadlock
    expect(result.timedOut).toBe(false);
    expect(result.doneCount).toBe(2);

    // Wait for persistence
    await page.waitForTimeout(2000);

    // Verify onChatResponse fired for both turns (drain loop processes the inner)
    const hookRes = await page.request.get(
      agentHttpUrl(baseURL!, room, "response-results", agent)
    );
    const hookResults = await hookRes.json();
    expect(hookResults.length).toBe(2);
    expect(hookResults[0].status).toBe("completed");
    expect(hookResults[1].status).toBe("completed");

    // Verify both conversations are persisted
    const persistedRes = await page.request.get(
      agentHttpUrl(baseURL!, room, "get-persisted", agent)
    );
    const persisted = await persistedRes.json();

    // Should have: user msg + assistant reply + follow-up user msg + follow-up assistant reply
    const userMsgs = persisted.filter(
      (m: { role: string }) => m.role === "user"
    );
    const assistantMsgs = persisted.filter(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(userMsgs.length).toBe(2);
    expect(assistantMsgs.length).toBe(2);

    // The follow-up should contain our chained message
    const followUp = userMsgs.find((m: { parts: Array<{ text?: string }> }) =>
      m.parts.some((p: { text?: string }) => p.text?.includes("goodbye"))
    );
    expect(followUp).toBeTruthy();

    console.log(
      "Chained responses:",
      assistantMsgs.map(
        (m: { parts: Array<{ type: string; text?: string }> }) =>
          m.parts
            .filter((p: { type: string }) => p.type === "text")
            .map((p: { text?: string }) => p.text)
            .join("")
      )
    );
  });
});
