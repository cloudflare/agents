import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
// The package subpath released packages load: the built entry point.
import * as chat from "agents/chat";
import { SQLITE_ROW_BYTES } from "../internal/platform-limits";

/**
 * Released packages whose peer range admits this `agents` import these
 * names from `agents/chat`; a missing one fails their module load.
 */
describe("agents/chat names released packages import", () => {
  it("still exports enforceRowSizeLimit (think 0.21-0.24, ai-chat 0.10-0.11) and sanitizeMessage (ai-chat 0.10-0.12)", () => {
    expect(typeof chat.enforceRowSizeLimit).toBe("function");
    expect(typeof chat.sanitizeMessage).toBe("function");
    const small: UIMessage = {
      id: "s",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    };
    expect(chat.enforceRowSizeLimit(small)).toBe(small);
    // think 0.24 and ai-chat 0.12 construct one.
    expect(typeof chat.TurnQueue).toBe("function");
    const big: UIMessage = {
      id: "b",
      role: "user",
      parts: [{ type: "text", text: "x".repeat(SQLITE_ROW_BYTES) }]
    };
    const cut = chat.enforceRowSizeLimit(big);
    expect(JSON.stringify(cut).length).toBeLessThan(SQLITE_ROW_BYTES);
  });
});
