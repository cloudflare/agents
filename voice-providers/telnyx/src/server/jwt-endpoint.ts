/**
 * Server-side JWT endpoint for Telnyx WebRTC authentication.
 *
 * Wraps the Telnyx telephony credentials API so that the browser
 * can obtain a JWT without ever seeing the API key. Mount the
 * `handleRequest` method in a Cloudflare Worker route.
 *
 * Usage in a Cloudflare Worker:
 * ```typescript
 * import { TelnyxJWTEndpoint } from "@cloudflare/voice-telnyx";
 *
 * const jwt = new TelnyxJWTEndpoint({
 *   apiKey: env.TELNYX_API_KEY,
 *   credentialConnectionId: env.TELNYX_CREDENTIAL_CONNECTION_ID,
 * });
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     if (new URL(request.url).pathname === "/telnyx-token") {
 *       return jwt.handleRequest(request);
 *     }
 *     // ... other routes
 *   },
 * };
 * ```
 */

export interface TelnyxJWTEndpointConfig {
  /** Telnyx API key (server-side secret — never send to the browser). */
  apiKey: string;
  /** The credential connection ID that new telephony credentials are created under. */
  credentialConnectionId: string;
  /** Override the Telnyx API base URL. @default "https://api.telnyx.com/v2" */
  baseUrl?: string;
}

export class TelnyxJWTEndpoint {
  private readonly apiKey: string;
  private readonly credentialConnectionId: string;
  private readonly baseUrl: string;

  constructor(config: TelnyxJWTEndpointConfig) {
    this.apiKey = config.apiKey;
    this.credentialConnectionId = config.credentialConnectionId;
    this.baseUrl = config.baseUrl ?? "https://api.telnyx.com/v2";
  }

  /**
   * Create a telephony credential and generate a JWT token.
   * This calls two Telnyx APIs in sequence:
   * 1. POST /v2/telephony_credentials — creates a credential under the connection
   * 2. POST /v2/telephony_credentials/:id/token — generates a short-lived JWT
   *
   * @returns The JWT token string and the credential ID (for later revocation).
   */
  async createToken(): Promise<{
    token: string;
    credentialId: string;
    sipUsername: string;
  }> {
    // Step 1: Create telephony credential
    const credResponse = await fetch(`${this.baseUrl}/telephony_credentials`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        connection_id: this.credentialConnectionId
      })
    });

    if (!credResponse.ok) {
      throw new Error(
        `Failed to create telephony credential: ${credResponse.status}`
      );
    }

    const credBody = (await credResponse.json()) as {
      data: { id: string; sip_username: string };
    };
    const credentialId = credBody.data.id;
    const sipUsername = credBody.data.sip_username;

    // Step 2: Generate JWT from the credential
    const tokenResponse = await fetch(
      `${this.baseUrl}/telephony_credentials/${credentialId}/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!tokenResponse.ok) {
      throw new Error(`Failed to generate JWT: ${tokenResponse.status}`);
    }

    // The Telnyx token endpoint may return a raw JWT string or a JSON
    // wrapper like { data: "eyJ..." }. Handle both.
    const tokenText = await tokenResponse.text();
    let token: string;
    try {
      const parsed = JSON.parse(tokenText);
      token = typeof parsed === "string" ? parsed : parsed.data;
    } catch {
      // Raw JWT string (not JSON-wrapped)
      token = tokenText;
    }

    return { token, credentialId, sipUsername };
  }

  /**
   * Delete a telephony credential, invalidating its JWT.
   * Call this when a session ends to clean up server-side resources.
   */
  async revokeCredential(credentialId: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/telephony_credentials/${credentialId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to revoke credential: ${response.status}`);
    }
  }

  /**
   * HTTP request handler for Cloudflare Workers (or any Request/Response runtime).
   *
   * - `POST`    → creates a credential + JWT, returns `{ token, credentialId }`
   * - `DELETE`  → revokes a credential (body: `{ credentialId }`)
   * - `OPTIONS` → CORS preflight
   */
  async handleRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (request.method === "POST") {
      try {
        const result = await this.createToken();
        return Response.json(result, {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return Response.json(
          { error: (err as Error).message },
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (request.method === "DELETE") {
      try {
        const body = (await request.json()) as {
          credentialId?: string;
        };
        if (!body.credentialId) {
          return Response.json(
            { error: "Missing credentialId in request body" },
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        await this.revokeCredential(body.credentialId);
        return Response.json(
          { ok: true },
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        return Response.json(
          { error: (err as Error).message },
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { "Content-Type": "application/json" } }
    );
  }
}
