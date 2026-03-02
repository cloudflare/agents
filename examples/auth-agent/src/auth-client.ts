/**
 * Minimal auth client — fetches a JWT from /api/token and stores it
 * in localStorage. Replace /api/token with your own auth service.
 */

/** Fetch a JWT for the given user name and cache it in localStorage. */
export async function fetchToken(name: string): Promise<string> {
  const res = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!res.ok) throw new Error("Failed to get token");
  const { token } = (await res.json()) as { token: string };
  localStorage.setItem("auth_token", token);
  localStorage.setItem("auth_name", name);
  return token;
}

/** Return the cached JWT, or null if missing. */
export function getToken(): string | null {
  return localStorage.getItem("auth_token");
}

/** Return the authenticated user's name. */
export function getUserName(): string | null {
  return localStorage.getItem("auth_name");
}

/** Clear stored token and name. */
export function clearAuth() {
  localStorage.removeItem("auth_token");
  localStorage.removeItem("auth_name");
}

/** Check whether the stored JWT has expired (or is missing/malformed). */
export function isTokenExpired(): boolean {
  const token = getToken();
  if (!token) return true;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload: { exp?: number } = JSON.parse(atob(base64));
    if (typeof payload.exp !== "number") return true;
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}
