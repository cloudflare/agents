import { test, expect } from "@playwright/test";

/**
 * E2E tests for CF_AGENT_STREAM_RESUME_NONE — the server's fast
 * "no active stream" response to a client resume request.
 *
 * Before this feature, the client had to wait for a 5-second timeout
 * to discover there was nothing to resume. Now the server responds
 * immediately with RESUME_NONE.
 */

const MessageType = {
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response",
  CF_AGENT_STREAM_RESUME_REQUEST: "cf_agent_stream_resume_request",
  CF_AGENT_STREAM_RESUME_NONE: "cf_agent_stream_resume_none",
  CF_AGENT_STREAM_RESUMING: "cf_agent_stream_resuming"
} as const;

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

function agentPath(baseURL: string, room: string) {
  return `${baseURL.replace("http", "ws")}/agents/chat-agent/${room}`;
}

test.describe("CF_AGENT_STREAM_RESUME_NONE e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("fresh room: RESUME_REQUEST gets RESUME_NONE immediately", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          messages: WSMessage[];
          gotResumeNone: boolean;
          gotResuming: boolean;
          elapsedMs: number;
        }>((resolve) => {
          const ws = new WebSocket(url);
          const messages: WSMessage[] = [];
          let gotResumeNone = false;
          let gotResuming = false;
          const startTime = Date.now();

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data) as WSMessage;
              messages.push(data);

              if (data.type === MT.CF_AGENT_STREAM_RESUME_NONE) {
                gotResumeNone = true;
                ws.close();
                resolve({
                  messages,
                  gotResumeNone,
                  gotResuming,
                  elapsedMs: Date.now() - startTime
                });
              }

              if (data.type === MT.CF_AGENT_STREAM_RESUMING) {
                gotResuming = true;
              }
            } catch {
              // ignore
            }
          };

          ws.onopen = () => {
            ws.send(
              JSON.stringify({ type: MT.CF_AGENT_STREAM_RESUME_REQUEST })
            );
          };

          setTimeout(() => {
            ws.close();
            resolve({
              messages,
              gotResumeNone,
              gotResuming,
              elapsedMs: Date.now() - startTime
            });
          }, 5000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    expect(result.gotResumeNone).toBe(true);
    expect(result.gotResuming).toBe(false);
    // Should arrive well under the old 5-second timeout
    expect(result.elapsedMs).toBeLessThan(3000);
  });

  test("after completed stream: RESUME_REQUEST gets RESUME_NONE", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = agentPath(baseURL!, room);

    // First: have a complete conversation
    await page.evaluate(
      ({ url, MT }) => {
        return new Promise<void>((resolve) => {
          const ws = new WebSocket(url);
          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              if (
                data.type === MT.CF_AGENT_USE_CHAT_RESPONSE &&
                data.done === true
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
                id: "req-setup",
                init: {
                  method: "POST",
                  body: JSON.stringify({
                    messages: [
                      {
                        id: "msg-setup",
                        role: "user",
                        parts: [{ type: "text", text: "Hello" }]
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
          }, 5000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    // Now reconnect and request resume — should get NONE since stream is done
    const result = await page.evaluate(
      ({ url, MT }) => {
        return new Promise<{
          gotResumeNone: boolean;
          gotResuming: boolean;
          elapsedMs: number;
        }>((resolve) => {
          const ws = new WebSocket(url);
          let gotResumeNone = false;
          let gotResuming = false;
          const startTime = Date.now();

          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);

              if (data.type === MT.CF_AGENT_STREAM_RESUME_NONE) {
                gotResumeNone = true;
                ws.close();
                resolve({
                  gotResumeNone,
                  gotResuming,
                  elapsedMs: Date.now() - startTime
                });
              }

              if (data.type === MT.CF_AGENT_STREAM_RESUMING) {
                gotResuming = true;
              }
            } catch {
              // ignore
            }
          };

          ws.onopen = () => {
            ws.send(
              JSON.stringify({ type: MT.CF_AGENT_STREAM_RESUME_REQUEST })
            );
          };

          setTimeout(() => {
            ws.close();
            resolve({
              gotResumeNone,
              gotResuming,
              elapsedMs: Date.now() - startTime
            });
          }, 5000);
        });
      },
      { url: wsUrl, MT: MessageType }
    );

    expect(result.gotResumeNone).toBe(true);
    expect(result.gotResuming).toBe(false);
    expect(result.elapsedMs).toBeLessThan(3000);
  });
});
