import { describe, expect, it } from "vitest";
import {
  isTransportNotImplemented,
  isUnauthorized,
  toErrorMessage
} from "../../mcp/errors";

// Helper to create error-like objects with code property (like StreamableHTTPError/SseError)
function createErrorWithCode(code: number, message: string) {
  const error = new Error(message) as Error & { code: number };
  error.code = code;
  return error;
}

describe("MCP Error Utilities", () => {
  describe("toErrorMessage", () => {
    it("should extract message from Error objects", () => {
      expect(toErrorMessage(new Error("test error"))).toBe("test error");
    });

    it("should convert non-Error values to string", () => {
      expect(toErrorMessage("string error")).toBe("string error");
      expect(toErrorMessage(404)).toBe("404");
      expect(toErrorMessage({ code: 404 })).toBe("[object Object]");
    });
  });

  describe("isUnauthorized", () => {
    it("should detect 401 error code", () => {
      expect(isUnauthorized(createErrorWithCode(401, "Unauthorized"))).toBe(
        true
      );
      expect(isUnauthorized(createErrorWithCode(401, ""))).toBe(true);
    });

    it("should detect Unauthorized in message", () => {
      expect(isUnauthorized(new Error("Unauthorized"))).toBe(true);
      expect(isUnauthorized(new Error("Request Unauthorized"))).toBe(true);
    });

    it("should detect 401 in message", () => {
      expect(isUnauthorized(new Error("HTTP 401"))).toBe(true);
      expect(isUnauthorized(new Error("Error: 401 Unauthorized"))).toBe(true);
    });

    it("should return false for other errors", () => {
      expect(isUnauthorized(new Error("Not Found"))).toBe(false);
      expect(isUnauthorized(new Error("500 Internal Server Error"))).toBe(
        false
      );
      expect(isUnauthorized(createErrorWithCode(404, "Not Found"))).toBe(false);
    });
  });

  describe("isTransportNotImplemented", () => {
    it("should detect 404 error code (MCP SDK StreamableHTTPError)", () => {
      // StreamableHTTPError from MCP SDK v1.24.0+
      expect(
        isTransportNotImplemented(
          createErrorWithCode(
            404,
            "Streamable HTTP error: Error POSTing to endpoint: Not Found"
          )
        )
      ).toBe(true);
      expect(
        isTransportNotImplemented(createErrorWithCode(404, "Not Found"))
      ).toBe(true);
    });

    it("should detect 405 error code", () => {
      expect(
        isTransportNotImplemented(
          createErrorWithCode(405, "Method Not Allowed")
        )
      ).toBe(true);
    });

    it("should detect 404 status code in message (legacy format)", () => {
      expect(isTransportNotImplemented(new Error("HTTP 404"))).toBe(true);
      expect(isTransportNotImplemented(new Error("Error: 404"))).toBe(true);
      expect(
        isTransportNotImplemented(new Error("Non-200 status code (404)"))
      ).toBe(true);
    });

    it("should detect 405 status code in message", () => {
      expect(isTransportNotImplemented(new Error("HTTP 405"))).toBe(true);
      expect(
        isTransportNotImplemented(new Error("Method Not Allowed 405"))
      ).toBe(true);
    });

    it("should detect 'Not Implemented' text", () => {
      expect(isTransportNotImplemented(new Error("Not Implemented"))).toBe(
        true
      );
      expect(isTransportNotImplemented(new Error("501 Not Implemented"))).toBe(
        true
      );
    });

    it("should detect 'not implemented' (lowercase)", () => {
      expect(
        isTransportNotImplemented(new Error("Transport not implemented"))
      ).toBe(true);
      expect(
        isTransportNotImplemented(new Error("Feature not implemented yet"))
      ).toBe(true);
    });

    it("should NOT match 'Not Found' text without 404 code", () => {
      // This ensures we don't incorrectly treat "Resource Not Found" errors
      // as transport-not-implemented when the code is different (e.g., session not found)
      expect(isTransportNotImplemented(new Error("Not Found"))).toBe(false);
      expect(isTransportNotImplemented(new Error("Resource Not Found"))).toBe(
        false
      );
      expect(
        isTransportNotImplemented(createErrorWithCode(400, "Session Not Found"))
      ).toBe(false);
    });

    it("should return false for other errors", () => {
      expect(isTransportNotImplemented(new Error("Unauthorized"))).toBe(false);
      expect(
        isTransportNotImplemented(new Error("500 Internal Server Error"))
      ).toBe(false);
      expect(isTransportNotImplemented(new Error("Connection refused"))).toBe(
        false
      );
      expect(isTransportNotImplemented(new Error("Timeout"))).toBe(false);
      expect(
        isTransportNotImplemented(createErrorWithCode(500, "Server Error"))
      ).toBe(false);
    });
  });
});
