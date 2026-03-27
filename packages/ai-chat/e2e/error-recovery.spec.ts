import { test, expect } from "@playwright/test";

/**
 * E2E tests for error recovery — verifying that connections remain
 * usable after stream errors and that broadcasts aren't permanently
 * blocked.
 *
 * Covers the fix in 0.2.6 where _pendingResumeConnections was not
 * cleared on stream error, permanently excluding connections from
 * broadcasts.
 */

const MessageType = {
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response"
} as const;

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

test.describe("Stream error recovery e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("connection remains usable after stream error", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = `${baseURL!.replace("http", "ws")}/agents/bad-key-agent/${room}`;

    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          firstRequestGotResponse: boolean;
          firstRequestError: boolean;
          secondRequestGotResponse: boolean;
          secondRequestError: boolean;
        }>((resolve) => {
          const ws = new WebSocket(url);
          const messages: WSMessage[] = [];
          let firstRequestGotResponse = false;
          let firstRequestError = false;
          let secondRequestGotResponse = false;
          let secondRequestError = false;

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data) as WSMessage;
              messages.push(data);

              if (data.type === MT.CF_AGENT_USE_CHAT_RESPONSE) {
                if (data.id === "req-err-1") {
                  firstRequestGotResponse = true;
                  if (data.error) firstRequestError = true;
                  if (data.done || data.error) {
                    // Send second request after first completes/errors
                    setTimeout(() => {
                      ws.send(
                        JSON.stringify({
                          type: MT.CF_AGENT_USE_CHAT_REQUEST,
                          id: "req-err-2",
                          init: {
                            method: "POST",
                            body: JSON.stringify({
                              messages: [
                                {
                                  id: "err-msg-1",
                                  role: "user",
                                  parts: [
                                    { type: "text", text: "First message" }
                                  ]
                                },
                                {
                                  id: "err-msg-2",
                                  role: "user",
                                  parts: [
                                    { type: "text", text: "Second attempt" }
                                  ]
                                }
                              ]
                            })
                          }
                        })
                      );
                    }, 500);
                  }
                }

                if (data.id === "req-err-2") {
                  secondRequestGotResponse = true;
                  if (data.error) secondRequestError = true;
                  if (data.done || data.error) {
                    setTimeout(() => {
                      ws.close();
                      resolve({
                        firstRequestGotResponse,
                        firstRequestError,
                        secondRequestGotResponse,
                        secondRequestError
                      });
                    }, 200);
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
                id: "req-err-1",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "err-msg-1",
                        role: "user",
                        parts: [{ type: "text", text: "This will fail" }]
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
              firstRequestGotResponse,
              firstRequestError,
              secondRequestGotResponse,
              secondRequestError
            });
          }, 20000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    // First request should have errored (bad API key)
    expect(result.firstRequestGotResponse).toBe(true);
    expect(result.firstRequestError).toBe(true);

    // Second request should also get a response (connection not stuck)
    // It will also error because BadKeyAgent always uses a bad key,
    // but the point is the connection is still alive and processing.
    expect(result.secondRequestGotResponse).toBe(true);
  });

  test("observer connection receives broadcasts after sender stream error", async ({
    page,
    baseURL
  }) => {
    const badRoom = crypto.randomUUID();
    const badWsUrl = `${baseURL!.replace("http", "ws")}/agents/bad-key-agent/${badRoom}`;

    // Send a failing request
    await page.evaluate(
      ({ url, MT }) => {
        return new Promise<void>((resolve) => {
          const ws = new WebSocket(url);
          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              if (
                data.type === MT.CF_AGENT_USE_CHAT_RESPONSE &&
                (data.done || data.error)
              ) {
                ws.close();
                resolve();
              }
            } catch {
              // ignore
            }
          };

          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: MT.CF_AGENT_USE_CHAT_REQUEST,
                id: "req-bad-1",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "bad-1",
                        role: "user",
                        parts: [{ type: "text", text: "Fail please" }]
                      }
                    ]
                  })
                }
              })
            );
          };

          setTimeout(() => {
            ws.close();
            resolve();
          }, 15000);
        });
      },
      { url: badWsUrl, MT: MessageType }
    );

    // Now open two connections on the same bad-key room and verify
    // the second connection still receives broadcasts
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          ws2GotBroadcast: boolean;
        }>((resolve) => {
          const ws1 = new WebSocket(url);
          const ws2 = new WebSocket(url);
          let ws1Open = false;
          let ws2Open = false;
          let ws2GotBroadcast = false;

          function maybeSend() {
            if (!ws1Open || !ws2Open) return;
            setTimeout(() => {
              ws1.send(
                JSON.stringify({
                  type: MT.CF_AGENT_USE_CHAT_REQUEST,
                  id: "req-after-err",
                  init: {
                    method: "POST",
                    body: JSON.stringify({
                      messages: [
                        {
                          id: "after-err-1",
                          role: "user",
                          parts: [{ type: "text", text: "After error" }]
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
                data.type === MT.CF_AGENT_USE_CHAT_RESPONSE ||
                data.type === "cf_agent_chat_messages"
              ) {
                ws2GotBroadcast = true;
              }
            } catch {
              // ignore
            }
          };

          const ws1Msgs: WSMessage[] = [];
          ws1.onmessage = (e) => {
            try {
              ws1Msgs.push(JSON.parse(e.data));
            } catch {
              // ignore
            }
          };

          const check = setInterval(() => {
            const done = ws1Msgs.find(
              (m) =>
                m.type === MT.CF_AGENT_USE_CHAT_RESPONSE && (m.done || m.error)
            );
            if (done) {
              clearInterval(check);
              setTimeout(() => {
                ws1.close();
                ws2.close();
                resolve({ ws2GotBroadcast });
              }, 500);
            }
          }, 100);

          setTimeout(() => {
            clearInterval(check);
            ws1.close();
            ws2.close();
            resolve({ ws2GotBroadcast });
          }, 15000);
        });
      },
      { url: badWsUrl, MT: MessageType }
    );

    // ws2 should receive broadcasts even after the previous error
    expect(result.ws2GotBroadcast).toBe(true);
  });
});
