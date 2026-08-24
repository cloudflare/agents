import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

const accessSubjectSchema = z.string().trim().min(1).brand<"AccessSubject">();
const accessEmailSchema = z.string().email();

/** Stable Cloudflare Access user identifier used to select an isolated agent. */
export type AccessSubject = z.infer<typeof accessSubjectSchema>;

/** Minimum verified Access identity required by the Exo application. */
export interface AccessIdentity {
  readonly subject: AccessSubject;
  readonly email: string;
}

/** Production Access verification or an explicit local-development identity. */
export type AccessAuthenticationConfig =
  | {
      readonly mode: "access";
      readonly teamDomain: string;
      readonly audience: string;
    }
  | {
      readonly mode: "development";
      readonly identity: AccessIdentity;
    };

/** Raw Worker environment values used to configure Access authentication. */
export interface AccessAuthenticationEnv {
  readonly AUTH_MODE: string;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  readonly DEVELOPMENT_ACCESS_SUBJECT: string;
  readonly DEVELOPMENT_ACCESS_EMAIL: string;
}

/** Expected invalid authentication configuration at the Worker entrypoint. */
export class AccessAuthenticationConfigError extends Error {
  readonly _tag = "AccessAuthenticationConfigError" as const;

  constructor() {
    super("Access authentication configuration invalid");
  }
}

/** Result of parsing Access authentication configuration at the Worker boundary. */
export type AccessAuthenticationConfigResult =
  | { readonly ok: true; readonly config: AccessAuthenticationConfig }
  | { readonly ok: false; readonly error: AccessAuthenticationConfigError };

/** Parse Worker values into fail-closed Access or local-development authentication. */
export function parseAccessAuthenticationConfig(
  env: AccessAuthenticationEnv
): AccessAuthenticationConfigResult {
  if (env.AUTH_MODE === "development") {
    const identity = parseAccessIdentity({
      subject: env.DEVELOPMENT_ACCESS_SUBJECT,
      email: env.DEVELOPMENT_ACCESS_EMAIL
    });
    return identity
      ? { ok: true, config: { mode: "development", identity } }
      : { ok: false, error: new AccessAuthenticationConfigError() };
  }

  if (env.AUTH_MODE !== "access") {
    return { ok: false, error: new AccessAuthenticationConfigError() };
  }

  const teamDomain = parseAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audience = env.ACCESS_AUD.trim();
  if (!teamDomain || !audience) {
    return { ok: false, error: new AccessAuthenticationConfigError() };
  }
  return {
    ok: true,
    config: { mode: "access", teamDomain, audience }
  };
}

/** Authentication outcome already translated for the Worker HTTP boundary. */
export type AccessAuthenticationResult =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | { readonly ok: false; readonly response: Response };

/** Create a request authenticator that caches one Access JWKS resolver. */
export function createAccessRequestAuthenticator(
  config: AccessAuthenticationConfig,
  keySet?: JWTVerifyGetKey
): (
  request: Request,
  runtimeAccess?: CloudflareAccessContext
) => Promise<AccessAuthenticationResult> {
  if (config.mode === "development") {
    return async () => ({ ok: true, identity: config.identity });
  }

  const resolvedKeySet =
    keySet ??
    createRemoteJWKSet(
      new URL("/cdn-cgi/access/certs", `${config.teamDomain}/`)
    );

  return async (request, runtimeAccess) => {
    if (runtimeAccess) {
      if (runtimeAccess.aud !== config.audience) {
        return invalidAccessAuthentication();
      }
      try {
        const identity = await runtimeAccess.getIdentity();
        const parsed = identity
          ? parseAccessIdentity({
              subject: identity.user_uuid,
              email: identity.email
            })
          : null;
        return parsed
          ? { ok: true, identity: parsed }
          : invalidAccessAuthentication();
      } catch {
        return invalidAccessAuthentication();
      }
    }

    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) {
      return {
        ok: false,
        response: new Response("Cloudflare Access authentication required", {
          status: 401
        })
      };
    }

    try {
      const verified = await jwtVerify(token, resolvedKeySet, {
        issuer: config.teamDomain,
        audience: config.audience
      });
      const identity = parseAccessIdentity({
        subject: verified.payload.sub,
        email: verified.payload.email
      });
      return identity ? { ok: true, identity } : invalidAccessAuthentication();
    } catch {
      return invalidAccessAuthentication();
    }
  };
}

/** Derive the persistent ExoKernel name from a verified Access subject. */
export function accessSubjectAgentName(subject: AccessSubject): string {
  return `user-${subject}`;
}

function parseAccessIdentity(input: {
  subject: unknown;
  email: unknown;
}): AccessIdentity | null {
  const subject = accessSubjectSchema.safeParse(input.subject);
  const email = accessEmailSchema.safeParse(input.email);
  return subject.success && email.success
    ? { subject: subject.data, email: email.data }
    : null;
}

function parseAccessTeamDomain(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function invalidAccessAuthentication(): AccessAuthenticationResult {
  return {
    ok: false,
    response: new Response("Cloudflare Access authentication invalid", {
      status: 403
    })
  };
}
