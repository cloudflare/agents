const GITHUB_STATE_COOKIE = "gh_oauth_state";
const GITHUB_TOKEN_COOKIE = "gh_access_token";
const GITHUB_SCOPE = "read:user";
const GITHUB_API_VERSION = "2022-11-28";

export type GitHubUser = {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
};

type CookieOptions = {
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
};

function getGitHubConfig(env: Env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error(
      "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env before starting the example."
    );
  }

  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET
  };
}

function shouldUseSecureCookies(request: Request) {
  return new URL(request.url).protocol === "https:";
}

function buildCookie(name: string, value: string, options: CookieOptions = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    `SameSite=${options.sameSite ?? "Lax"}`
  ];

  if (options.httpOnly ?? true) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  return parts.join("; ");
}

function clearCookie(name: string, request: Request) {
  return buildCookie(name, "", {
    httpOnly: true,
    maxAge: 0,
    secure: shouldUseSecureCookies(request)
  });
}

function getCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...rest] = cookie.trim().split("=");
    if (rawName !== name) continue;
    return decodeURIComponent(rest.join("="));
  }

  return null;
}

function createNoStoreHeaders(headers?: HeadersInit) {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  return result;
}

function getRedirectUri(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/auth/callback`;
}

function getAuthorizeUrl(request: Request, env: Env, state: string) {
  const { clientId } = getGitHubConfig(env);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getRedirectUri(request));
  url.searchParams.set("scope", GITHUB_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

function createGitHubHeaders(token?: string) {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "cloudflare-auth-agent",
    "X-GitHub-Api-Version": GITHUB_API_VERSION
  });

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}

async function exchangeCodeForToken(request: Request, env: Env, code: string) {
  const { clientId, clientSecret } = getGitHubConfig(env);
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "cloudflare-auth-agent"
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: getRedirectUri(request)
    })
  });

  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    const message =
      payload.error_description ??
      payload.error ??
      "GitHub token exchange failed";
    throw new Error(message);
  }

  return payload.access_token;
}

async function fetchGitHubUser(token: string): Promise<GitHubUser | null> {
  const response = await fetch("https://api.github.com/user", {
    headers: createGitHubHeaders(token)
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub user lookup failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    id?: number;
    login?: string;
    name?: string | null;
    avatar_url?: string;
  };

  if (
    typeof payload.id !== "number" ||
    typeof payload.login !== "string" ||
    typeof payload.avatar_url !== "string"
  ) {
    throw new Error("GitHub user response was missing required fields");
  }

  return {
    id: payload.id,
    login: payload.login,
    name: payload.name ?? null,
    avatarUrl: payload.avatar_url
  };
}

export function createUnauthorizedResponse(request: Request) {
  const headers = createNoStoreHeaders();
  headers.append("Set-Cookie", clearCookie(GITHUB_TOKEN_COOKIE, request));
  return new Response("Unauthorized", { status: 401, headers });
}

export async function getGitHubUserFromRequest(
  request: Request
): Promise<GitHubUser | null> {
  const token = getCookie(request, GITHUB_TOKEN_COOKIE);
  if (!token) return null;
  return fetchGitHubUser(token);
}

export function handleGitHubLogin(request: Request, env: Env) {
  const state = crypto.randomUUID();
  const headers = createNoStoreHeaders({
    Location: getAuthorizeUrl(request, env, state)
  });

  headers.append(
    "Set-Cookie",
    buildCookie(GITHUB_STATE_COOKIE, state, {
      httpOnly: true,
      maxAge: 600,
      secure: shouldUseSecureCookies(request)
    })
  );

  return new Response(null, { status: 302, headers });
}

export async function handleGitHubCallback(request: Request, env: Env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const expectedState = getCookie(request, GITHUB_STATE_COOKIE);
  const oauthError = url.searchParams.get("error");

  const headers = createNoStoreHeaders();
  headers.append("Set-Cookie", clearCookie(GITHUB_STATE_COOKIE, request));

  if (oauthError) {
    return new Response(`GitHub OAuth failed: ${oauthError}`, {
      status: 400,
      headers
    });
  }

  if (!code || !returnedState || returnedState !== expectedState) {
    return new Response("Invalid GitHub OAuth callback", {
      status: 400,
      headers
    });
  }

  const token = await exchangeCodeForToken(request, env, code);
  const user = await fetchGitHubUser(token);

  if (!user) {
    return new Response("GitHub access token was rejected", {
      status: 401,
      headers
    });
  }

  headers.set("Location", "/");
  headers.append(
    "Set-Cookie",
    buildCookie(GITHUB_TOKEN_COOKIE, token, {
      httpOnly: true,
      secure: shouldUseSecureCookies(request)
    })
  );

  return new Response(null, { status: 302, headers });
}

export function handleLogout(request: Request) {
  const headers = createNoStoreHeaders();
  headers.append("Set-Cookie", clearCookie(GITHUB_STATE_COOKIE, request));
  headers.append("Set-Cookie", clearCookie(GITHUB_TOKEN_COOKIE, request));
  return new Response(null, { status: 204, headers });
}
