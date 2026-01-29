/**
 * Email routing types, resolvers, and signing utilities for Agents
 */

// Re-export AgentEmail type
export type { AgentEmail } from "./internal_context";

// ============================================================================
// Signing utilities
// ============================================================================

/** Default signature expiration: 30 days in seconds */
export const DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Maximum allowed clock skew for future timestamps: 5 minutes */
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

/**
 * Compute HMAC-SHA256 signature for agent routing headers
 * @param secret - Secret key for HMAC
 * @param agentName - Name of the agent
 * @param agentId - ID of the agent instance
 * @param timestamp - Unix timestamp in seconds
 * @returns Base64-encoded HMAC signature
 */
async function computeAgentSignature(
  secret: string,
  agentName: string,
  agentId: string,
  timestamp: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = encoder.encode(`${agentName}:${agentId}:${timestamp}`);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Result of signature verification
 */
type SignatureVerificationResult =
  | { valid: true }
  | { valid: false; reason: "expired" | "invalid" | "malformed_timestamp" };

/**
 * Verify HMAC-SHA256 signature for agent routing headers
 * @param secret - Secret key for HMAC
 * @param agentName - Name of the agent
 * @param agentId - ID of the agent instance
 * @param signature - Base64-encoded signature to verify
 * @param timestamp - Unix timestamp in seconds when signature was created
 * @param maxAgeSeconds - Maximum age of signature in seconds (default: 30 days)
 * @returns Verification result with reason if invalid
 */
async function verifyAgentSignature(
  secret: string,
  agentName: string,
  agentId: string,
  signature: string,
  timestamp: string,
  maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS
): Promise<SignatureVerificationResult> {
  try {
    // Validate timestamp format
    const timestampNum = Number.parseInt(timestamp, 10);
    if (Number.isNaN(timestampNum)) {
      return { valid: false, reason: "malformed_timestamp" };
    }

    // Check timestamp validity
    const now = Math.floor(Date.now() / 1000);

    // Reject timestamps too far in the future (prevents extending signature validity)
    if (timestampNum > now + MAX_CLOCK_SKEW_SECONDS) {
      return { valid: false, reason: "invalid" };
    }

    // Check if signature has expired
    if (now - timestampNum > maxAgeSeconds) {
      return { valid: false, reason: "expired" };
    }

    const expected = await computeAgentSignature(
      secret,
      agentName,
      agentId,
      timestamp
    );
    // Constant-time comparison to prevent timing attacks
    if (expected.length !== signature.length) {
      return { valid: false, reason: "invalid" };
    }
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
      result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    if (result !== 0) {
      return { valid: false, reason: "invalid" };
    }
    return { valid: true };
  } catch (error) {
    console.warn("[agents] Signature verification error:", error);
    return { valid: false, reason: "invalid" };
  }
}

/**
 * Sign agent routing headers for secure reply flows.
 * Use this when sending outbound emails to ensure replies can be securely routed back.
 *
 * @param secret - Secret key for HMAC signing (store in environment variables)
 * @param agentName - Name of the agent
 * @param agentId - ID of the agent instance
 * @returns Headers object with X-Agent-Name, X-Agent-ID, X-Agent-Sig, and X-Agent-Sig-Ts
 *
 * @example
 * ```typescript
 * const headers = await signAgentHeaders(env.EMAIL_SECRET, "MyAgent", this.name);
 * // Use these headers when sending outbound emails
 * ```
 */
export async function signAgentHeaders(
  secret: string,
  agentName: string,
  agentId: string
): Promise<Record<string, string>> {
  if (!secret) {
    throw new Error("secret is required for signing agent headers");
  }
  if (!agentName) {
    throw new Error("agentName is required for signing agent headers");
  }
  if (!agentId) {
    throw new Error("agentId is required for signing agent headers");
  }
  // Reject colons to prevent signature confusion attacks
  // (signature payload uses colon as delimiter: "agentName:agentId:timestamp")
  if (agentName.includes(":")) {
    throw new Error("agentName cannot contain colons");
  }
  if (agentId.includes(":")) {
    throw new Error("agentId cannot contain colons");
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await computeAgentSignature(
    secret,
    agentName,
    agentId,
    timestamp
  );
  return {
    "X-Agent-Name": agentName,
    "X-Agent-ID": agentId,
    "X-Agent-Sig": signature,
    "X-Agent-Sig-Ts": timestamp
  };
}

// ============================================================================
// Email routing types and resolvers
// ============================================================================

export type EmailResolverResult = {
  agentName: string;
  agentId: string;
  /** @internal Indicates this resolver requires secure reply signing */
  _secureRouted?: boolean;
} | null;

export type EmailResolver<Env> = (
  email: ForwardableEmailMessage,
  env: Env
) => Promise<EmailResolverResult>;

/**
 * Reason for signature verification failure
 */
export type SignatureFailureReason =
  | "missing_headers"
  | "expired"
  | "invalid"
  | "malformed_timestamp";

/**
 * Options for createSecureReplyEmailResolver
 */
export type SecureReplyResolverOptions = {
  /**
   * Maximum age of signature in seconds.
   * Signatures older than this will be rejected.
   * Default: 30 days (2592000 seconds)
   */
  maxAge?: number;
  /**
   * Callback invoked when signature verification fails.
   * Useful for logging and debugging.
   */
  onInvalidSignature?: (
    email: ForwardableEmailMessage,
    reason: SignatureFailureReason
  ) => void;
};

/**
 * @deprecated REMOVED due to security vulnerability (IDOR via spoofed headers).
 * @throws Always throws an error with migration guidance.
 */
export function createHeaderBasedEmailResolver<Env>(): EmailResolver<Env> {
  throw new Error(
    "createHeaderBasedEmailResolver has been removed due to a security vulnerability. " +
      "It trusted attacker-controlled email headers for routing, enabling IDOR attacks. " +
      "Migration options:\n" +
      "  - For inbound mail: use createAddressBasedEmailResolver(agentName)\n" +
      "  - For reply flows: use createSecureReplyEmailResolver(secret) with signed headers"
  );
}

/**
 * Create a resolver for routing email replies with signature verification.
 * This resolver verifies that replies contain a valid HMAC signature, preventing
 * attackers from routing emails to arbitrary agent instances.
 *
 * @param secret - Secret key for HMAC verification (must match the key used with signAgentHeaders)
 * @param options - Optional configuration for signature verification
 * @returns A function that resolves the agent to route the email to, or null if signature is invalid
 *
 * @example
 * ```typescript
 * // In your email handler
 * const secureResolver = createSecureReplyEmailResolver(env.EMAIL_SECRET, {
 *   maxAge: 7 * 24 * 60 * 60, // 7 days
 *   onInvalidSignature: (email, reason) => {
 *     console.warn(`Invalid signature from ${email.from}: ${reason}`);
 *   }
 * });
 * const addressResolver = createAddressBasedEmailResolver("MyAgent");
 *
 * await routeAgentEmail(email, env, {
 *   resolver: async (email, env) => {
 *     // Try secure reply routing first
 *     const replyRouting = await secureResolver(email, env);
 *     if (replyRouting) return replyRouting;
 *     // Fall back to address-based routing
 *     return addressResolver(email, env);
 *   }
 * });
 * ```
 */
export function createSecureReplyEmailResolver<Env>(
  secret: string,
  options?: SecureReplyResolverOptions
): EmailResolver<Env> {
  if (!secret) {
    throw new Error("secret is required for createSecureReplyEmailResolver");
  }

  const maxAge = options?.maxAge ?? DEFAULT_MAX_AGE_SECONDS;
  const onInvalidSignature = options?.onInvalidSignature;

  return async (email: ForwardableEmailMessage, _env: Env) => {
    const agentName = email.headers.get("x-agent-name");
    const agentId = email.headers.get("x-agent-id");
    const signature = email.headers.get("x-agent-sig");
    const timestamp = email.headers.get("x-agent-sig-ts");

    if (!agentName || !agentId || !signature || !timestamp) {
      onInvalidSignature?.(email, "missing_headers");
      return null;
    }

    const result = await verifyAgentSignature(
      secret,
      agentName,
      agentId,
      signature,
      timestamp,
      maxAge
    );

    if (!result.valid) {
      onInvalidSignature?.(email, result.reason);
      return null;
    }

    return { agentName, agentId, _secureRouted: true };
  };
}

/**
 * Create a resolver that uses the email address to determine the agent to route the email to
 * @param defaultAgentName The default agent name to use if the email address does not contain a sub-address
 * @returns A function that resolves the agent to route the email to
 */
export function createAddressBasedEmailResolver<Env>(
  defaultAgentName: string
): EmailResolver<Env> {
  return async (email: ForwardableEmailMessage, _env: Env) => {
    // Length limits per RFC 5321: local part max 64 chars, domain max 253 chars
    const emailMatch = email.to.match(
      /^([^+@]{1,64})(?:\+([^@]{1,64}))?@(.{1,253})$/
    );
    if (!emailMatch) {
      return null;
    }

    const [, localPart, subAddress] = emailMatch;

    if (subAddress) {
      return {
        agentName: localPart,
        agentId: subAddress
      };
    }

    // Option 2: Use defaultAgentName namespace, localPart as agentId
    // Common for catch-all email routing to a single EmailAgent namespace
    return {
      agentName: defaultAgentName,
      agentId: localPart
    };
  };
}

/**
 * Create a resolver that uses the agentName and agentId to determine the agent to route the email to
 * @param agentName The name of the agent to route the email to
 * @param agentId The id of the agent to route the email to
 * @returns A function that resolves the agent to route the email to
 */
export function createCatchAllEmailResolver<Env>(
  agentName: string,
  agentId: string
): EmailResolver<Env> {
  return async () => ({ agentName, agentId });
}
