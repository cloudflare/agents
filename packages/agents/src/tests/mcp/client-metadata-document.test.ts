import { auth } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableObjectOAuthClientProvider } from "../../mcp/client/do-oauth-client-provider";

const SERVER_URL = "https://mcp.example.com/mcp";
const ISSUER = "https://auth.example.com";
const CLIENT_METADATA_URL = "https://client.example.com/oauth/client.json";
const CALLBACK_URL = "https://agent.example.com/mcp-callback";

/**
 * A protected resource whose authorization server advertises (or not)
 * Client ID Metadata Document support. Records every request URL.
 */
function oauthServers(cimdSupported: boolean) {
  const requests: string[] = [];
  const fetchFn = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url.href);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        resource: SERVER_URL,
        authorization_servers: [ISSUER]
      });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: cimdSupported
      });
    }
    if (url.pathname === "/register") {
      return Response.json(
        { client_id: "registered-client", redirect_uris: [CALLBACK_URL] },
        { status: 201 }
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { requests, fetchFn };
}

function withProvider<T>(
  run: (provider: DurableObjectOAuthClientProvider) => Promise<T>
): Promise<T> {
  const stub = env.TestOAuthAgent.get(
    env.TestOAuthAgent.idFromName(`cimd-${crypto.randomUUID()}`)
  );
  return runInDurableObject(stub, async (_instance, ctx) => {
    const provider = new DurableObjectOAuthClientProvider(
      ctx.storage,
      "cimd-test",
      CALLBACK_URL,
      { clientMetadataUrl: CLIENT_METADATA_URL }
    );
    provider.serverId = "server-1";
    return run(provider);
  });
}

describe("DurableObjectOAuthClientProvider Client ID Metadata Documents", () => {
  it("uses the metadata URL as client_id when the authorization server supports CIMD", async () => {
    const { requests, fetchFn } = oauthServers(true);
    const result = await withProvider(async (provider) => {
      const outcome = await auth(provider, { serverUrl: SERVER_URL, fetchFn });
      return {
        outcome,
        authUrl: provider.authUrl,
        clientInformation: await provider.clientInformation()
      };
    });

    expect(result.outcome).toBe("REDIRECT");
    expect(new URL(result.authUrl!).searchParams.get("client_id")).toBe(
      CLIENT_METADATA_URL
    );
    expect(result.clientInformation?.client_id).toBe(CLIENT_METADATA_URL);
    expect(requests.some((url) => url.endsWith("/register"))).toBe(false);
  });

  it("falls back to dynamic client registration when CIMD is not advertised", async () => {
    const { requests, fetchFn } = oauthServers(false);
    const authUrl = await withProvider(async (provider) => {
      await auth(provider, { serverUrl: SERVER_URL, fetchFn });
      return provider.authUrl;
    });

    expect(new URL(authUrl!).searchParams.get("client_id")).toBe(
      "registered-client"
    );
    expect(requests.some((url) => url.endsWith("/register"))).toBe(true);
  });

  it("serves a metadata document whose client_id is the metadata URL", async () => {
    const document = await withProvider(
      async (provider) => provider.clientMetadataDocument
    );

    expect(document).toMatchObject({
      client_id: CLIENT_METADATA_URL,
      redirect_uris: [CALLBACK_URL],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none"
    });
  });

  it("rejects a metadata URL that is not HTTPS with a path", async () => {
    await expect(
      withProvider(async (provider) => {
        return new DurableObjectOAuthClientProvider(
          provider.storage,
          "cimd-test",
          CALLBACK_URL,
          { clientMetadataUrl: "http://client.example.com/client.json" }
        );
      })
    ).rejects.toThrow(/clientMetadataUrl must be a valid HTTPS URL/);
  });
});
