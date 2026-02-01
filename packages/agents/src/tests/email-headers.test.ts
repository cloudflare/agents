import { describe, expect, it } from "vitest";
import {
  parseEmailHeaders,
  getEmailHeader,
  hasEmailHeader,
  hasAnyEmailHeader,
  getAllEmailHeaders,
  isAutoReplyEmail,
  type EmailHeader
} from "../email";

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

describe("Email Header Parsing Utilities", () => {
  describe("parseEmailHeaders", () => {
    it("should convert postal-mime headers to a simple object", () => {
      const headers = createHeaders({
        "Content-Type": "text/plain; charset=utf-8",
        Subject: "Hello World",
        From: "sender@example.com"
      });

      const result = parseEmailHeaders(headers);

      expect(result).toEqual({
        "content-type": "text/plain; charset=utf-8",
        subject: "Hello World",
        from: "sender@example.com"
      });
    });

    it("should handle empty headers array", () => {
      const result = parseEmailHeaders([]);
      expect(result).toEqual({});
    });

    it("should use last value for duplicate headers", () => {
      const headers: EmailHeader[] = [
        { key: "x-custom", value: "first" },
        { key: "x-custom", value: "second" }
      ];

      const result = parseEmailHeaders(headers);
      expect(result["x-custom"]).toBe("second");
    });
  });

  describe("getEmailHeader", () => {
    const headers = createHeaders({
      "Content-Type": "text/html",
      "X-Priority": "1"
    });

    it("should get header value by name (case-insensitive)", () => {
      expect(getEmailHeader(headers, "Content-Type")).toBe("text/html");
      expect(getEmailHeader(headers, "content-type")).toBe("text/html");
      expect(getEmailHeader(headers, "CONTENT-TYPE")).toBe("text/html");
    });

    it("should return undefined for missing headers", () => {
      expect(getEmailHeader(headers, "X-Missing")).toBeUndefined();
    });
  });

  describe("hasEmailHeader", () => {
    const headers = createHeaders({
      "Content-Type": "text/plain",
      "X-Priority": "1"
    });

    it("should return true for existing headers (case-insensitive)", () => {
      expect(hasEmailHeader(headers, "Content-Type")).toBe(true);
      expect(hasEmailHeader(headers, "content-type")).toBe(true);
      expect(hasEmailHeader(headers, "CONTENT-TYPE")).toBe(true);
      expect(hasEmailHeader(headers, "X-Priority")).toBe(true);
    });

    it("should return false for missing headers", () => {
      expect(hasEmailHeader(headers, "X-Missing")).toBe(false);
    });
  });

  describe("hasAnyEmailHeader", () => {
    const headers = createHeaders({
      "Content-Type": "text/plain",
      Precedence: "bulk"
    });

    it("should return true if any header exists", () => {
      expect(hasAnyEmailHeader(headers, ["X-Missing", "Precedence"])).toBe(
        true
      );
      expect(hasAnyEmailHeader(headers, ["PRECEDENCE", "X-MISSING"])).toBe(
        true
      );
    });

    it("should return false if no headers exist", () => {
      expect(hasAnyEmailHeader(headers, ["X-Missing", "X-Also-Missing"])).toBe(
        false
      );
    });

    it("should handle empty names array", () => {
      expect(hasAnyEmailHeader(headers, [])).toBe(false);
    });
  });

  describe("getAllEmailHeaders", () => {
    const headers: EmailHeader[] = [
      { key: "received", value: "from server1" },
      { key: "received", value: "from server2" },
      { key: "received", value: "from server3" },
      { key: "content-type", value: "text/plain" }
    ];

    it("should return all values for a header that appears multiple times", () => {
      const result = getAllEmailHeaders(headers, "Received");
      expect(result).toEqual(["from server1", "from server2", "from server3"]);
    });

    it("should return single-element array for unique headers", () => {
      const result = getAllEmailHeaders(headers, "Content-Type");
      expect(result).toEqual(["text/plain"]);
    });

    it("should return empty array for missing headers", () => {
      const result = getAllEmailHeaders(headers, "X-Missing");
      expect(result).toEqual([]);
    });
  });

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

    it("should detect auto-reply subject patterns", () => {
      const testCases = [
        "Auto-Reply: Out of Office",
        "Re: Auto-reply: Thanks",
        "Out of Office: Jane Doe",
        "Automatic reply: Meeting"
      ];

      for (const subject of testCases) {
        const headers = createHeaders({});
        expect(isAutoReplyEmail(headers, subject)).toBe(true);
      }
    });

    it("should detect autoreply (no hyphen) in subject", () => {
      const headers = createHeaders({});
      expect(isAutoReplyEmail(headers, "Autoreply: Thanks")).toBe(true);
    });

    it("should return false for normal emails", () => {
      const headers = createHeaders({
        From: "user@example.com",
        Subject: "Meeting Tomorrow"
      });
      expect(isAutoReplyEmail(headers, "Meeting Tomorrow")).toBe(false);
    });

    it("should return false for empty headers and no subject", () => {
      expect(isAutoReplyEmail([])).toBe(false);
    });
  });
});
