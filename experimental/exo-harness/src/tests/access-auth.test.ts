import { env, exports } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import {
  accessSubjectAgentName,
  createAccessRequestAuthenticator
} from "../access-auth";

const ACCESS_CONFIG = {
  mode: "access",
  teamDomain: "https://exo-test.cloudflareaccess.com",
  audience: "exo-harness-test"
} as const;

async function accessTokenSigner(keyId: string = crypto.randomUUID()) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = keyId;
  return {
    keySet: createLocalJWKSet({ keys: [publicJwk] }),
    sign(options?: {
      subject?: string;
      email?: string;
      issuer?: string;
      audience?: string;
      expiresAt?: string;
    }) {
      return new SignJWT({
        email: options?.email ?? "agent@cloudflare.com"
      })
        .setProtectedHeader({ alg: "RS256", kid: keyId })
        .setSubject(options?.subject ?? "access-user-123")
        .setIssuer(options?.issuer ?? ACCESS_CONFIG.teamDomain)
        .setAudience(options?.audience ?? ACCESS_CONFIG.audience)
        .setIssuedAt()
        .setExpirationTime(options?.expiresAt ?? "5m")
        .sign(privateKey);
    }
  };
}

interface IsolatedKernelStub {
  boot(): Promise<unknown>;
  prompt(text: string): Promise<unknown>;
  getFileContent(path: string): Promise<string | null>;
}

describe("Cloudflare Access authentication", () => {
  it("verifies an application token and derives its isolated agent name", async () => {
    const signer = await accessTokenSigner();
    const token = await signer.sign();
    const authenticate = createAccessRequestAuthenticator(
      ACCESS_CONFIG,
      signer.keySet
    );

    const result = await authenticate(
      new Request("https://exo.example/agent", {
        headers: { "Cf-Access-Jwt-Assertion": token }
      })
    );

    expect(result).toEqual({
      ok: true,
      identity: {
        subject: "access-user-123",
        email: "agent@cloudflare.com"
      }
    });
    if (result.ok) {
      expect(accessSubjectAgentName(result.identity.subject)).toBe(
        "user-access-user-123"
      );
    }
  });

  it("rejects missing and invalid application tokens without echoing them", async () => {
    const signer = await accessTokenSigner("valid-key");
    const invalidSigner = await accessTokenSigner("invalid-key");
    const wrongIssuer = await signer.sign({
      issuer: "https://attacker.example"
    });
    const wrongAudience = await signer.sign({ audience: "wrong-app" });
    const expired = await signer.sign({ expiresAt: "0s" });
    const invalidSignature = await invalidSigner.sign();
    const authenticate = createAccessRequestAuthenticator(
      ACCESS_CONFIG,
      signer.keySet
    );

    const missing = await authenticate(
      new Request("https://exo.example/agent")
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(401);
      expect(await missing.response.text()).toBe(
        "Cloudflare Access authentication required"
      );
    }

    for (const token of [
      wrongIssuer,
      wrongAudience,
      expired,
      invalidSignature,
      "secret-invalid-token"
    ]) {
      const invalid = await authenticate(
        new Request("https://exo.example/agent", {
          headers: { "Cf-Access-Jwt-Assertion": token }
        })
      );
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.response.status).toBe(403);
        const body = await invalid.response.text();
        expect(body).toBe("Cloudflare Access authentication invalid");
        expect(body).not.toContain(token);
      }
    }

    const runtimeFailure = await authenticate(
      new Request("https://exo.example/agent"),
      {
        aud: ACCESS_CONFIG.audience,
        async getIdentity() {
          throw new Error("runtime identity unavailable");
        }
      }
    );
    expect(runtimeFailure.ok).toBe(false);
    if (!runtimeFailure.ok) {
      expect(runtimeFailure.response.status).toBe(403);
    }
  });

  it("maps different verified subjects to isolated durable agents", async () => {
    const signer = await accessTokenSigner();
    const authenticate = createAccessRequestAuthenticator(
      ACCESS_CONFIG,
      signer.keySet
    );
    const identities = await Promise.all(
      ["isolated-user-a", "isolated-user-b"].map(async (subject) => {
        const token = await signer.sign({ subject });
        return authenticate(
          new Request("https://exo.example/agent", {
            headers: { "Cf-Access-Jwt-Assertion": token }
          })
        );
      })
    );
    if (!identities[0]?.ok || !identities[1]?.ok) {
      throw new Error("Access identity isolation test authentication failed");
    }

    const firstName = accessSubjectAgentName(identities[0].identity.subject);
    const secondName = accessSubjectAgentName(identities[1].identity.subject);
    expect([firstName, secondName]).toEqual([
      "user-isolated-user-a",
      "user-isolated-user-b"
    ]);

    // Narrowing the recursive ExoKernel RPC stub avoids a TypeScript expansion
    // limit while retaining the exact public methods exercised by this test.
    const first = (await getAgentByName(
      env.ExoKernel,
      firstName
    )) as unknown as IsolatedKernelStub;
    const second = (await getAgentByName(
      env.ExoKernel,
      secondName
    )) as unknown as IsolatedKernelStub;
    await Promise.all([first.boot(), second.boot()]);
    await first.prompt(
      '!tool write_file {"path":"/memory/isolation.txt","content":"first user only"}'
    );

    expect(await first.getFileContent("/memory/isolation.txt")).toBe(
      "first user only"
    );
    expect(await second.getFileContent("/memory/isolation.txt")).toBeNull();
  });

  it("uses the runtime-verified Access identity when it is available", async () => {
    const authenticate = createAccessRequestAuthenticator(ACCESS_CONFIG);
    const result = await authenticate(
      new Request("https://exo.example/agent"),
      {
        aud: ACCESS_CONFIG.audience,
        async getIdentity() {
          return {
            user_uuid: "runtime-user-456",
            email: "runtime@cloudflare.com"
          };
        }
      }
    );

    expect(result).toEqual({
      ok: true,
      identity: {
        subject: "runtime-user-456",
        email: "runtime@cloudflare.com"
      }
    });
  });
});

describe("authenticated agent routing", () => {
  it("serves the fixed agent route and does not expose client-selected routes", async () => {
    const connected = await exports.default.fetch(
      "http://example.com/agent?agent=someone-else",
      { headers: { Upgrade: "websocket" } }
    );
    expect([101, 426]).toContain(connected.status);
    if (connected.webSocket) {
      connected.webSocket.accept();
      connected.webSocket.close();
    }

    const [clientSelected, suffixed] = await Promise.all([
      exports.default.fetch(
        "http://example.com/agents/exo-kernel/someone-else",
        { headers: { Upgrade: "websocket" } }
      ),
      exports.default.fetch("http://example.com/agent/someone-else", {
        headers: { Upgrade: "websocket" }
      })
    ]);
    expect(clientSelected.status).toBe(404);
    expect(suffixed.status).toBe(404);
  });
});
