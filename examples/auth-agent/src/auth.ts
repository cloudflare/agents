/**
 * better-auth server config + JWT verification.
 *
 * Creates a per-request auth instance (Workers are stateless — env bindings
 * are only available inside the fetch handler) and provides a verifyToken()
 * function that reads JWKS directly from D1 to avoid self-requesting the
 * same Worker's JWKS endpoint. See README for rationale.
 */

import { betterAuth } from "better-auth";
import { bearer, jwt } from "better-auth/plugins";
import { D1Dialect } from "kysely-d1";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Create a better-auth instance wired to D1 via kysely-d1. */
export function createAuth(env: Env) {
  return betterAuth({
    // better-auth → Kysely → kysely-d1 → D1
    database: {
      dialect: new D1Dialect({ database: env.AUTH_DB }),
      type: "sqlite"
    },
    emailAndPassword: { enabled: true },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // bearer: allows Authorization header auth alongside cookies
    // jwt: adds /api/auth/token (issue JWTs) and /api/auth/jwks (public keys)
    plugins: [bearer(), jwt()]
  });
}

/**
 * Verify a JWT by reading JWKS from D1 (not via HTTP).
 *
 * Uses createLocalJWKSet instead of createRemoteJWKSet because the JWKS
 * endpoint lives on this same Worker — same-zone subrequests bypass Workers
 * by default and hit the origin, which doesn't serve JWKS. See README.
 * Returns the payload on success, null on any failure.
 */
export async function verifyToken(
  token: string,
  env: Env
): Promise<JWTPayload | null> {
  try {
    const result = await env.AUTH_DB.prepare(
      "SELECT id, publicKey, privateKey, createdAt FROM jwks"
    ).all<{
      id: string;
      publicKey: string;
      privateKey: string;
      createdAt: string;
    }>();

    if (!result.results || result.results.length === 0) return null;

    // Build a local JWKS set — each publicKey is a JSON-stringified JWK
    const jwks = createLocalJWKSet({
      keys: result.results.map((row) => ({
        ...JSON.parse(row.publicKey),
        kid: row.id
      }))
    });

    const { payload } = await jwtVerify(token, jwks);
    return payload;
  } catch {
    return null;
  }
}
