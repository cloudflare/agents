import { describe, expect, it } from "vitest";
import { isAutoReplyEmail, type EmailHeader } from "../email";

// Helper to create a mock headers array in postal-mime format
function createHeaders(
  headers: Record<string, string | string[]>
): EmailHeader[] {
  const result: EmailHeader[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        result.push({ key: key.toLowerCase(), value: v });
      }
    } else {
      result.push({ key: key.toLowerCase(), value });
    }
  }
  return result;
}

describe("isAutoReplyEmail", () => {
  it("should detect Auto-Submitted header", () => {
    const headers = createHeaders({
      "Auto-Submitted": "auto-replied"
    });
    expect(isAutoReplyEmail(headers)).toBe(true);
  });

  it("should detect X-Auto-Response-Suppress header", () => {
    const headers = createHeaders({
      "X-Auto-Response-Suppress": "All"
    });
    expect(isAutoReplyEmail(headers)).toBe(true);
  });

  it("should detect Precedence header", () => {
    const headers = createHeaders({
      Precedence: "bulk"
    });
    expect(isAutoReplyEmail(headers)).toBe(true);
  });

  it("should return false for normal emails", () => {
    const headers = createHeaders({
      From: "user@example.com",
      Subject: "Meeting Tomorrow"
    });
    expect(isAutoReplyEmail(headers)).toBe(false);
  });

  it("should return false for empty headers", () => {
    expect(isAutoReplyEmail([])).toBe(false);
  });
});
