import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TelnyxJWTEndpoint,
  type TelnyxJWTEndpointConfig
} from "../../src/server/jwt-endpoint.js";

const MOCK_CONFIG: TelnyxJWTEndpointConfig = {
  apiKey: "KEY_test-api-key",
  credentialConnectionId: "conn-123-456",
  allowUnauthenticated: true
};

const MOCK_CREDENTIAL_RESPONSE = {
  data: {
    id: "cred-789",
    connection_id: "conn-123-456",
    sip_username: "gencredABC",
    sip_password: "secret",
    record_type: "telephony_credential"
  }
};

const MOCK_TOKEN_RESPONSE = {
  data: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test-jwt-payload.signature"
};

describe("TelnyxJWTEndpoint", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("stores config values", () => {
      expect(new TelnyxJWTEndpoint(MOCK_CONFIG)).toBeInstanceOf(
        TelnyxJWTEndpoint
      );
    });

    it("allows overriding base URL", () => {
      expect(
        new TelnyxJWTEndpoint({
          ...MOCK_CONFIG,
          baseUrl: "https://custom.api.telnyx.com/v2"
        })
      ).toBeDefined();
    });
  });

  describe("createToken", () => {
    it("creates a telephony credential then generates a JWT", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
        );

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const result = await endpoint.createToken();

      expect(result.token).toBe(MOCK_TOKEN_RESPONSE.data);
      expect(result.credentialId).toBe("cred-789");
      expect(result.sipUsername).toBe("gencredABC");
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const [credUrl, credOpts] = fetchSpy.mock.calls[0] as [
        string,
        RequestInit
      ];
      expect(credUrl).toBe("https://api.telnyx.com/v2/telephony_credentials");
      expect(credOpts.method).toBe("POST");
      expect((credOpts.headers as Record<string, string>).Authorization).toBe(
        "Bearer KEY_test-api-key"
      );
      expect(JSON.parse(String(credOpts.body))).toEqual({
        connection_id: "conn-123-456"
      });

      const [tokenUrl, tokenOpts] = fetchSpy.mock.calls[1] as [
        string,
        RequestInit
      ];
      expect(tokenUrl).toBe(
        "https://api.telnyx.com/v2/telephony_credentials/cred-789/token"
      );
      expect(tokenOpts.method).toBe("POST");
      expect((tokenOpts.headers as Record<string, string>).Authorization).toBe(
        "Bearer KEY_test-api-key"
      );
    });

    it("accepts a raw JWT string token response", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200
          })
        )
        .mockResolvedValueOnce(new Response("raw.jwt.token", { status: 200 }));

      const result = await new TelnyxJWTEndpoint(MOCK_CONFIG).createToken();

      expect(result.token).toBe("raw.jwt.token");
    });

    it("uses custom base URL when configured", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
        );

      const endpoint = new TelnyxJWTEndpoint({
        ...MOCK_CONFIG,
        baseUrl: "https://custom.telnyx.com/v2"
      });
      await endpoint.createToken();

      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        "https://custom.telnyx.com/v2/telephony_credentials"
      );
      expect(String(fetchSpy.mock.calls[1]?.[0])).toContain(
        "https://custom.telnyx.com/v2/telephony_credentials/"
      );
    });

    it("throws when credential creation fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ detail: "Unauthorized" }] }), {
          status: 401
        })
      );

      await expect(
        new TelnyxJWTEndpoint(MOCK_CONFIG).createToken()
      ).rejects.toThrow("Failed to create telephony credential: 401");
    });

    it("throws when token generation fails", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ errors: [{ detail: "Not found" }] }), {
            status: 404
          })
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      await expect(
        new TelnyxJWTEndpoint(MOCK_CONFIG).createToken()
      ).rejects.toThrow("Failed to generate JWT: 404");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(fetchSpy.mock.calls[2]?.[0]).toBe(
        "https://api.telnyx.com/v2/telephony_credentials/cred-789"
      );
      const [, revokeOptions] = fetchSpy.mock.calls[2] as [string, RequestInit];
      expect(revokeOptions.method).toBe("DELETE");
    });
  });

  describe("revokeCredential", () => {
    it("deletes the telephony credential", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await new TelnyxJWTEndpoint(MOCK_CONFIG).revokeCredential("cred-789");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://api.telnyx.com/v2/telephony_credentials/cred-789"
      );
      expect(opts.method).toBe("DELETE");
      expect((opts.headers as Record<string, string>).Authorization).toBe(
        "Bearer KEY_test-api-key"
      );
    });

    it("throws when deletion fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ detail: "Not found" }] }), {
          status: 404
        })
      );

      await expect(
        new TelnyxJWTEndpoint(MOCK_CONFIG).revokeCredential("bad-id")
      ).rejects.toThrow("Failed to revoke credential: 404");
    });

    it("URL-encodes credential IDs when deleting", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await new TelnyxJWTEndpoint(MOCK_CONFIG).revokeCredential("cred/789");

      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        "https://api.telnyx.com/v2/telephony_credentials/cred%2F789"
      );
    });
  });

  describe("handleRequest", () => {
    it("returns a token on POST", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
        );

      const response = await new TelnyxJWTEndpoint(MOCK_CONFIG).handleRequest(
        new Request("https://worker.example.com/jwt", { method: "POST" })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.token).toBe(MOCK_TOKEN_RESPONSE.data);
      expect(body.credentialId).toBe("cred-789");
      expect(body.sipUsername).toBe("gencredABC");
    });

    it("revokes a credential on DELETE with credentialId in body", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const response = await new TelnyxJWTEndpoint(MOCK_CONFIG).handleRequest(
        new Request("https://worker.example.com/jwt", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credentialId: "cred-789" })
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    it("returns 400 on DELETE without credentialId", async () => {
      const response = await new TelnyxJWTEndpoint(MOCK_CONFIG).handleRequest(
        new Request("https://worker.example.com/jwt", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
      );

      expect(response.status).toBe(400);
      expect((await response.json()) as Record<string, unknown>).toHaveProperty(
        "error"
      );
    });

    it("returns 405 for unsupported methods", async () => {
      const response = await new TelnyxJWTEndpoint(MOCK_CONFIG).handleRequest(
        new Request("https://worker.example.com/jwt", { method: "GET" })
      );

      expect(response.status).toBe(405);
    });

    it("returns 500 when createToken fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ detail: "Unauthorized" }] }), {
          status: 401
        })
      );

      const response = await new TelnyxJWTEndpoint(MOCK_CONFIG).handleRequest(
        new Request("https://worker.example.com/jwt", { method: "POST" })
      );

      expect(response.status).toBe(500);
      expect((await response.json()) as Record<string, unknown>).toHaveProperty(
        "error"
      );
    });

    it("returns 500 when revokeCredential fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ detail: "Not found" }] }), {
          status: 404
        })
      );

      const response = await new TelnyxJWTEndpoint(MOCK_CONFIG).handleRequest(
        new Request("https://worker.example.com/jwt", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credentialId: "bad-id" })
        })
      );

      expect(response.status).toBe(500);
    });

    it("requires authorization by default", async () => {
      const response = await new TelnyxJWTEndpoint({
        apiKey: "KEY_test-api-key",
        credentialConnectionId: "conn-123-456"
      }).handleRequest(
        new Request("https://worker.example.com/jwt", { method: "POST" })
      );

      expect(response.status).toBe(401);
    });

    it("returns 403 when authorize rejects the request", async () => {
      const response = await new TelnyxJWTEndpoint({
        apiKey: "KEY_test-api-key",
        credentialConnectionId: "conn-123-456",
        authorize: () => false
      }).handleRequest(
        new Request("https://worker.example.com/jwt", { method: "POST" })
      );

      expect(response.status).toBe(403);
    });

    it("includes configured CORS headers", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
        );

      const response = await new TelnyxJWTEndpoint({
        ...MOCK_CONFIG,
        allowedOrigins: ["https://app.example.com"]
      }).handleRequest(
        new Request("https://worker.example.com/jwt", {
          method: "POST",
          headers: { Origin: "https://app.example.com" }
        })
      );

      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com"
      );
    });

    it("handles OPTIONS preflight requests", async () => {
      const response = await new TelnyxJWTEndpoint({
        ...MOCK_CONFIG,
        allowedOrigins: ["https://app.example.com"]
      }).handleRequest(
        new Request("https://worker.example.com/jwt", {
          method: "OPTIONS",
          headers: { Origin: "https://app.example.com" }
        })
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
        "POST"
      );
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com"
      );
    });
  });
});
