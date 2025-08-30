import {
  OAuthProvider,
  type OAuthHelpers
} from "@cloudflare/workers-oauth-provider";
import { WhoamiMCP, AddMCP } from "./mcp";

type Env = {
  OAUTH_PROVIDER: OAuthHelpers;
};

// Dumb handler that authorizes all requests that include an `email` parameter.
// Instead of replying with a redirect, it returns a JSON with the authorization values
// so it's easier to use in our test cases.
const defaultHandler = {
  async fetch(request: Request, env: unknown) {
    const url = new URL(request.url);
    const provider = (env as Env).OAUTH_PROVIDER;
    // Health check
    if (url.pathname === "/health") {
      return new Response("OK");
    }

    if (new URL(request.url).pathname === "/authorize") {
      const oauthReq = await provider.parseAuthRequest(request);

      // accept any email/password (from query or JSON)
      const url = new URL(request.url);
      let email = url.searchParams.get("email") ?? undefined;
      if (!email && request.method !== "GET") {
        try {
          email = (await request.json<{ email?: string }>())?.email;
        } catch {}
      }
      if (!email)
        return new Response("LOGIN REQUIRED", {
          status: 401
        });

      const { redirectTo } = await provider.completeAuthorization({
        request: oauthReq,
        userId: email,
        scope: [],
        props: { email },
        metadata: undefined
      });

      // Read the parameters off the redirect URL and return them in a JSON
      const u = new URL(redirectTo);
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state") ?? "";
      const fragment = u.hash.startsWith("#") ? u.hash.slice(1) : "";
      const body = { email, code, state, fragment };
      return Response.json(body);
    }

    return new Response("NOT FOUND", {
      status: 404
    });
  }
};

// Export the OAuthProvider as the Worker entrypoint.
export default new OAuthProvider({
  // Expose both the MCP SSE endpoint and a simple REST API under OAuth
  apiHandlers: {
    "/whoami/sse": WhoamiMCP.serveSSE("/whoami/sse", { binding: "WHOAMI_MCP" }),
    "/whoami/mcp": WhoamiMCP.serve("/whoami/mcp", { binding: "WHOAMI_MCP" }),
    "/add/sse": {
      // These run after the OAuthProvider sets the props, so we can safely append
      // our custom props to them before routing to the MCP
      fetch(request: Request, env: unknown, ctx: ExecutionContext) {
        ctx.props = {
          ...ctx.props,
          echoAvailable: !!request.headers.get("x-my-feature-flag")
        };
        return AddMCP.serveSSE("/add/sse", { binding: "ADD_MCP" }).fetch(
          request,
          env,
          ctx
        );
      }
    },
    "/add/mcp": {
      fetch(request: Request, env: unknown, ctx: ExecutionContext) {
        ctx.props = {
          ...ctx.props,
          echoAvailable: !!request.headers.get("x-my-feature-flag")
        };
        return AddMCP.serve("/add/mcp", { binding: "ADD_MCP" }).fetch(
          request,
          env,
          ctx
        );
      }
    }
  },
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  allowImplicitFlow: true
});

export { WhoamiMCP, AddMCP } from "./mcp";
