import { expect, test } from "vitest";
import { webBinding } from "./bindings/web";
import { withDestination } from "./helpers";

test("shares one Web conversation while keeping its client tool owner-scoped", async () => {
  await withDestination(webBinding, async (channel) => {
    await expect(channel.sharedConversationRoundTrip()).resolves.toEqual({
      tool: {
        name: "describeBrowser",
        input: { prompt: "Run the Web client-tool live test" }
      },
      member: {
        priorHistory: ["Prior canonical question", "Prior canonical answer"],
        userMessage: "Run the Web client-tool live test",
        text:
          "Waiting for browser context" +
          'Client tool result received: {"language":"en-US","timezone":"Etc/UTC"}',
        reasoning: [
          "The browser executed the advertised tool and returned its context."
        ],
        toolCalls: 0
      },
      continuation: {
        reasoning: [
          "The browser executed the advertised tool and returned its context."
        ],
        text: 'Client tool result received: {"language":"en-US","timezone":"Etc/UTC"}'
      }
    });
  });
});
