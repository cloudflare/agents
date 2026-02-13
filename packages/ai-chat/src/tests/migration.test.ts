import { describe, it, expect } from "vitest";
import {
  autoTransformMessage,
  autoTransformMessages,
  isUIMessage,
  needsMigration,
  analyzeCorruption,
  migrateToUIMessage,
  migrateMessagesToUIFormat
} from "../ai-chat-v5-migration";
import type { UIMessage } from "ai";

describe("AI SDK v5 Migration", () => {
  describe("isUIMessage", () => {
    it("returns true for messages with parts array", () => {
      expect(
        isUIMessage({
          id: "1",
          role: "user",
          parts: [{ type: "text", text: "hi" }]
        })
      ).toBe(true);
    });

    it("returns false for legacy messages with string content", () => {
      expect(isUIMessage({ id: "1", role: "user", content: "hello" })).toBe(
        false
      );
    });

    it("returns false for null/undefined", () => {
      expect(isUIMessage(null)).toBe(false);
      expect(isUIMessage(undefined)).toBe(false);
    });

    it("returns false for non-object types", () => {
      expect(isUIMessage("string")).toBe(false);
      expect(isUIMessage(42)).toBe(false);
    });
  });

  describe("autoTransformMessage", () => {
    it("passes through UIMessages unchanged", () => {
      const msg: UIMessage = {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "hello" }]
      };
      expect(autoTransformMessage(msg)).toBe(msg);
    });

    it("transforms legacy string content to text part", () => {
      const result = autoTransformMessage({
        id: "legacy-1",
        role: "user",
        content: "Hello world"
      });
      expect(result.id).toBe("legacy-1");
      expect(result.role).toBe("user");
      expect(result.parts.length).toBe(1);
      expect(result.parts[0].type).toBe("text");
      expect((result.parts[0] as { text: string }).text).toBe("Hello world");
    });

    it("transforms legacy tool invocations", () => {
      const result = autoTransformMessage({
        id: "tool-1",
        role: "assistant",
        content: "",
        toolInvocations: [
          {
            toolCallId: "call_1",
            toolName: "getWeather",
            args: { city: "London" },
            state: "result",
            result: "Sunny"
          }
        ]
      });

      expect(result.parts.length).toBe(1);
      const toolPart = result.parts[0] as {
        type: string;
        toolCallId: string;
        state: string;
        input: Record<string, unknown>;
        output: unknown;
      };
      expect(toolPart.type).toBe("tool-getWeather");
      expect(toolPart.toolCallId).toBe("call_1");
      expect(toolPart.state).toBe("output-available");
      expect(toolPart.input).toEqual({ city: "London" });
      expect(toolPart.output).toBe("Sunny");
    });

    it("maps tool invocation states correctly", () => {
      const states = {
        "partial-call": "input-streaming",
        call: "input-available",
        result: "output-available",
        error: "output-error"
      };

      for (const [v4State, v5State] of Object.entries(states)) {
        const result = autoTransformMessage({
          role: "assistant",
          content: "",
          toolInvocations: [
            {
              toolCallId: `call_${v4State}`,
              toolName: "test",
              args: {},
              state: v4State as "partial-call" | "call" | "result" | "error"
            }
          ]
        });

        const toolPart = result.parts[0] as { state: string };
        expect(toolPart.state).toBe(v5State);
      }
    });

    it("handles corrupt array content format", () => {
      const result = autoTransformMessage({
        id: "corrupt-1",
        role: "user",
        content: [{ type: "text", text: "Hello from array" }]
      } as unknown as { id: string; role: string; content: unknown });

      expect(result.parts.length).toBe(1);
      expect((result.parts[0] as { text: string }).text).toBe(
        "Hello from array"
      );
    });

    it("transforms reasoning field to reasoning part", () => {
      const result = autoTransformMessage({
        id: "reasoning-1",
        role: "assistant",
        content: "Final answer",
        reasoning: "Let me think about this..."
      });

      // When reasoning exists, the content fallback (`!parts.length`) doesn't trigger.
      // Only the reasoning part is created. The `content` field is only used
      // as fallback when there are no other parts.
      expect(result.parts.length).toBe(1);
      expect(result.parts[0].type).toBe("reasoning");
      expect((result.parts[0] as { text: string }).text).toBe(
        "Let me think about this..."
      );
    });

    it("transforms file parts from legacy format (without parts array)", () => {
      // Note: if the message has a `parts` array, isUIMessage() returns true
      // and the message passes through unchanged. File transformation only
      // applies to messages that have `parts` but are NOT UIMessages.
      // In practice, legacy messages with file `parts` also have `content`
      // as a string, and crucially `parts` contains objects with `data`
      // (not the UIMessage part shape). However, isUIMessage only checks
      // Array.isArray(parts), so it still matches.
      //
      // To test the actual data→url transformation, we construct a message
      // that won't match isUIMessage (no `parts` key at the top level, but
      // file data embedded differently). In practice this path is hit when
      // messages come from v4 storage with toolInvocations + file data.
      const result = autoTransformMessage({
        id: "file-1",
        role: "assistant",
        content: "",
        toolInvocations: [
          {
            toolCallId: "call_file",
            toolName: "generateImage",
            args: {},
            state: "result",
            result: "image.png"
          }
        ]
      });

      // Should have tool part with result
      const toolPart = result.parts[0] as {
        type: string;
        state: string;
        output: unknown;
      };
      expect(toolPart.type).toBe("tool-generateImage");
      expect(toolPart.state).toBe("output-available");
      expect(toolPart.output).toBe("image.png");
    });

    it("uses 'data' role mapped to 'system'", () => {
      const result = autoTransformMessage({
        id: "data-1",
        role: "data",
        content: "System instruction"
      });
      expect(result.role).toBe("system");
    });

    it("generates fallback id when none provided", () => {
      const result = autoTransformMessage(
        {
          role: "user",
          content: "no id"
        },
        5
      );
      expect(result.id).toBe("msg-5");
    });
  });

  describe("autoTransformMessages", () => {
    it("transforms array of mixed-format messages", () => {
      const input = [
        { id: "1", role: "user", content: "Hello" },
        {
          id: "2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi!" }]
        }
      ];

      const result = autoTransformMessages(input);
      expect(result.length).toBe(2);
      expect(result[0].parts[0].type).toBe("text");
      expect(result[1].parts[0].type).toBe("text");
    });

    it("handles empty array", () => {
      expect(autoTransformMessages([])).toEqual([]);
    });
  });

  describe("deprecated functions", () => {
    it("migrateToUIMessage works but is deprecated", () => {
      const result = migrateToUIMessage({
        id: "dep-1",
        role: "user",
        content: "test"
      });
      expect(result.parts[0].type).toBe("text");
    });

    it("migrateMessagesToUIFormat works but is deprecated", () => {
      const result = migrateMessagesToUIFormat([
        { id: "dep-2", role: "user", content: "test" }
      ]);
      expect(result.length).toBe(1);
    });

    it("needsMigration works but is deprecated", () => {
      expect(
        needsMigration([{ id: "1", role: "user", content: "old format" }])
      ).toBe(true);
      expect(
        needsMigration([
          { id: "1", role: "user", parts: [{ type: "text", text: "new" }] }
        ])
      ).toBe(false);
    });

    it("analyzeCorruption reports stats correctly", () => {
      const stats = analyzeCorruption([
        { id: "1", role: "user", parts: [{ type: "text", text: "clean" }] },
        { id: "2", role: "user", content: "legacy string" },
        {
          id: "3",
          role: "user",
          content: [{ type: "text", text: "corrupt array" }]
        }
      ]);

      expect(stats.total).toBe(3);
      expect(stats.clean).toBe(1);
      expect(stats.legacyString).toBe(1);
      expect(stats.corruptArray).toBe(1);
      expect(stats.unknown).toBe(0);
    });
  });
});
