/**
 * better-auth config + JWT verification.
 *
 * Uses `import { env } from "cloudflare:workers"` for module-level access
 * to bindings (D1, secrets). verifyToken() reads JWKS directly from D1
 * to avoid self-requesting the same Worker's JWKS endpoint. See README.
 *
 * IMPORTANT: betterAuth() is created lazily (on first request) rather than
 * at module level because its internal init() triggers async I/O
 * (telemetry filesystem detection via dynamic import("fs/promises")) that
 * cannot resolve outside a request context on Workers. Calling betterAuth()
 * at module scope causes auth.handler() to hang indefinitely.
 */

import { betterAuth } from "better-auth";
import { bearer, jwt } from "better-auth/plugins";
import { D1Dialect } from "kysely-d1";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "cloudflare:workers";

/**
 * Lazy singleton — betterAuth() is called on first use (inside a request
 * context) instead of at module evaluation time.
 */
let _auth: ReturnType<typeof betterAuth>;
export function getAuth() {
  return (_auth ??= betterAuth({
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
  }));
}

/**
 * Verify a JWT by reading JWKS from D1 (not via HTTP).
 *
 * Uses createLocalJWKSet instead of createRemoteJWKSet because the JWKS
 * endpoint lives on this same Worker — same-zone subrequests bypass Workers
 * by default and hit the origin, which doesn't serve JWKS. See README.
 */
export async function verifyToken(token: string): Promise<JWTPayload | null> {
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
