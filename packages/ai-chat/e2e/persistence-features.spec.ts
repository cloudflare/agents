import { test, expect } from "@playwright/test";

/**
 * E2E tests for persistence-related features:
 * - sanitizeMessageForPersistence hook
 * - maxPersistedMessages trimming
 * - regenerate message flow (_deleteStaleRows)
 */

const MessageType = {
  CF_AGENT_USE_CHAT_REQUEST: "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE: "cf_agent_use_chat_response"
} as const;

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

/** Send a chat request and wait for completion. */
async function sendAndWait(
  page: import("@playwright/test").Page,
  wsUrl: string,
  messages: Array<{
    id: string;
    role: string;
    parts: unknown[];
  }>,
  requestId: string,
  timeoutMs = 10000
): Promise<WSMessage[]> {
  return page.evaluate(
    ({ url, messages, requestId, timeoutMs, MT }) => {
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
              id: requestId,
              init: {
                method: "POST",
                body: JSON.stringify({ messages })
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
    { url: wsUrl, messages, requestId, timeoutMs, MT: MessageType }
  );
}

// ── sanitizeMessageForPersistence ─────────────────────────────────

test.describe("sanitizeMessageForPersistence e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("custom sanitize hook redacts content before persistence", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = `${baseURL!.replace("http", "ws")}/agents/sanitize-agent/${room}`;

    await sendAndWait(
      page,
      wsUrl,
      [
        {
          id: "msg-sanitize-1",
          role: "user",
          parts: [{ type: "text", text: "Tell me the secret" }]
        }
      ],
      "req-sanitize-1"
    );

    const res = await page.request.get(
      `${baseURL}/agents/sanitize-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);

    const persisted = await res.json();
    expect(persisted.length).toBeGreaterThanOrEqual(2);

    const assistantMsg = persisted.find(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistantMsg).toBeTruthy();

    const textPart = assistantMsg.parts.find(
      (p: { type: string }) => p.type === "text"
    );
    expect(textPart).toBeTruthy();
    // The SanitizeAgent returns "Reply with [SECRET] data included"
    // The hook should have replaced [SECRET] with [REDACTED]
    expect(textPart.text).toContain("[REDACTED]");
    expect(textPart.text).not.toContain("[SECRET]");
  });
});

// ── maxPersistedMessages ──────────────────────────────────────────

test.describe("maxPersistedMessages e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("messages are trimmed to maxPersistedMessages limit", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = `${baseURL!.replace("http", "ws")}/agents/max-persisted-agent/${room}`;

    // MaxPersistedAgent has maxPersistedMessages=4.
    // Each turn fetches current server state and appends the new user message,
    // mimicking what a real client does. After 3 turns (6 total messages),
    // only the most recent 4 should remain.

    // Turn 1: send [user-1]
    await sendAndWait(
      page,
      wsUrl,
      [
        {
          id: "mp-user-1",
          role: "user",
          parts: [{ type: "text", text: "First" }]
        }
      ],
      "req-mp-1"
    );

    // Fetch server state after turn 1 to build turn 2's message array
    const afterTurn1 = await page.request.get(
      `${baseURL}/agents/max-persisted-agent/${room}/get-messages`
    );
    const turn1Data = await afterTurn1.json();
    expect(turn1Data.length).toBe(2); // user-1 + assistant-1

    // Turn 2: send server history + user-2
    const turn2Messages = [
      ...turn1Data.map((m: { id: string; role: string; parts: unknown[] }) => ({
        id: m.id,
        role: m.role,
        parts: m.parts
      })),
      {
        id: "mp-user-2",
        role: "user",
        parts: [{ type: "text", text: "Second" }]
      }
    ];
    await sendAndWait(page, wsUrl, turn2Messages, "req-mp-2");

    // Fetch server state after turn 2
    const afterTurn2 = await page.request.get(
      `${baseURL}/agents/max-persisted-agent/${room}/get-messages`
    );
    const turn2Data = await afterTurn2.json();
    // 4 messages: user-1, assistant-1, user-2, assistant-2 — exactly at the limit
    expect(turn2Data.length).toBe(4);

    // Turn 3: send server history + user-3
    const turn3Messages = [
      ...turn2Data.map((m: { id: string; role: string; parts: unknown[] }) => ({
        id: m.id,
        role: m.role,
        parts: m.parts
      })),
      {
        id: "mp-user-3",
        role: "user",
        parts: [{ type: "text", text: "Third" }]
      }
    ];
    await sendAndWait(page, wsUrl, turn3Messages, "req-mp-3");

    const res = await page.request.get(
      `${baseURL}/agents/max-persisted-agent/${room}/get-messages`
    );
    expect(res.ok()).toBe(true);

    const persisted = await res.json();
    // Should have exactly 4 messages (the limit, after trimming the 2 oldest)
    expect(persisted.length).toBe(4);

    // The most recent user message (mp-user-3) should be present
    const hasLatestUser = persisted.some(
      (m: { id: string }) => m.id === "mp-user-3"
    );
    expect(hasLatestUser).toBe(true);

    // The oldest user message (mp-user-1) should be trimmed
    const hasOldestUser = persisted.some(
      (m: { id: string }) => m.id === "mp-user-1"
    );
    expect(hasOldestUser).toBe(false);
  });
});

// ── Regenerate message flow ───────────────────────────────────────

test.describe("Regenerate message flow e2e", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("regenerate replaces old assistant message with new one", async ({
    page,
    baseURL
  }) => {
    const room = crypto.randomUUID();
    const wsUrl = `${baseURL!.replace("http", "ws")}/agents/chat-agent/${room}`;

    // Send initial message
    await sendAndWait(
      page,
      wsUrl,
      [
        {
          id: "regen-user-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      ],
      "req-regen-1"
    );

    // Get the persisted messages and note the assistant message ID
    const beforeRes = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    const beforeData = await beforeRes.json();
    expect(beforeData.length).toBeGreaterThanOrEqual(2);

    const originalAssistant = beforeData.find(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(originalAssistant).toBeTruthy();
    const originalAssistantId = originalAssistant.id;

    // Regenerate: send only the user message (without assistant)
    // This mimics what the client does on regenerate — it drops the last
    // assistant message from the array, which triggers _deleteStaleRows
    // to remove the old assistant row.
    await sendAndWait(
      page,
      wsUrl,
      [
        {
          id: "regen-user-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      ],
      "req-regen-2"
    );

    // Verify the new persisted state
    const afterRes = await page.request.get(
      `${baseURL}/agents/chat-agent/${room}/get-messages`
    );
    const afterData = await afterRes.json();

    // Should still have exactly 2 messages (user + new assistant)
    expect(afterData.length).toBe(2);

    // User message should be the same
    const userMsg = afterData.find(
      (m: { id: string }) => m.id === "regen-user-1"
    );
    expect(userMsg).toBeTruthy();

    // Should have a new assistant message
    const newAssistant = afterData.find(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(newAssistant).toBeTruthy();

    // The old assistant message should be gone (replaced by the new one)
    const oldAssistantStillExists = afterData.some(
      (m: { id: string }) => m.id === originalAssistantId
    );
    // The new response may reuse the same server-generated ID depending on
    // reconciliation. What matters is there's exactly one assistant message.
    const assistantCount = afterData.filter(
      (m: { role: string }) => m.role === "assistant"
    ).length;
    expect(assistantCount).toBe(1);

    // If it's a genuinely new ID, verify the old one is gone
    if (newAssistant.id !== originalAssistantId) {
      expect(oldAssistantStillExists).toBe(false);
    }
  });
});
