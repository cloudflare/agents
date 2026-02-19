/**
 * better-auth React client.
 *
 * Flow: sign in → session cookie set → fetchAndStoreJwt() gets a JWT via
 * the cookie → JWT stored in localStorage → passed to WebSocket as ?token=.
 */

import { createAuthClient } from "better-auth/react";
import { jwtClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [jwtClient()]
});

/** Fetch a JWT from /api/auth/token (cookie-authenticated) and cache it. */
export async function fetchAndStoreJwt(): Promise<string | null> {
  const result = await authClient.token();
  if (result.data?.token) {
    localStorage.setItem("jwt_token", result.data.token);
    return result.data.token;
  }
  return null;
}

/** Clear stored JWT. Called on sign-out. */
export function clearTokens() {
  localStorage.removeItem("jwt_token");
}

export const { signIn, signUp, signOut } = authClient;
