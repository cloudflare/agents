import { ServerCallContext, type User } from "@a2a-js/sdk/server";
import { timingSafeEqual } from "node:crypto";
import { validateOwnerName } from "./types";

const textEncoder = new TextEncoder();

class SharedSecretUser implements User {
  readonly isAuthenticated = true;

  constructor(readonly userName: string) {}
}

/** Validates a bearer token using fixed-size hashes and a timing-safe comparison. */
export async function authenticateRequest(
  request: Request,
  expectedToken: string
): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const providedToken =
    authorization?.slice(0, "Bearer ".length).toLowerCase() === "bearer "
      ? authorization.slice("Bearer ".length)
      : "";
  if (!providedToken || !expectedToken) return false;

  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(providedToken)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(expectedToken))
  ]);
  return timingSafeEqual(
    new Uint8Array(providedHash),
    new Uint8Array(expectedHash)
  );
}

/** Builds the authenticated SDK context and carries transport state to handlers. */
export function createServerCallContext(
  request: Request,
  ownerName: string,
  signal?: AbortSignal
): ServerCallContext {
  validateOwnerName(ownerName);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return new ServerCallContext({
    requestedVersion: request.headers.get("A2A-Version") ?? undefined,
    user: new SharedSecretUser(ownerName),
    state: new Map<string, unknown>([
      ["headers", headers],
      ...(signal ? [["signal", signal] as const] : [])
    ])
  });
}
