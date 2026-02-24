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

/** Check whether the stored JWT has expired (or is missing/malformed). */
export function isTokenExpired(): boolean {
  const token = localStorage.getItem("jwt_token");
  if (!token) return true;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    // base64url → base64 → decode
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload: { exp?: number } = JSON.parse(atob(base64));
    if (typeof payload.exp !== "number") return true;
    // Expired if exp (seconds) is before now. No grace buffer — the server
    // is the source of truth; we just avoid obviously-stale tokens.
    return payload.exp * 1000 < Date.now();
  } catch {
    return true; // malformed token → treat as expired
  }
}

export const { signIn, signUp, signOut } = authClient;
