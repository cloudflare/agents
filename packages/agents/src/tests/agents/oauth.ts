import { Agent } from "../../index.ts";
import { DurableObjectOAuthClientProvider } from "../../mcp/do-oauth-client-provider";
import type { AgentMcpOAuthProvider } from "../../mcp/do-oauth-client-provider";
import type { MCPClientConnection } from "../../mcp/client-connection";
import type { MCPClientOAuthResult } from "../../mcp/client.ts";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

async function createAuthorizationUrl(
  state: string,
  verifier: string
): Promise<URL> {
  const authUrl = new URL("https://auth.example.com/authorize");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set(
    "code_challenge",
    await createCodeChallenge(verifier)
  );
  authUrl.searchParams.set("code_challenge_method", "S256");
  return authUrl;
}

// Test Agent for OAuth client side flows
export class TestOAuthAgent extends Agent {
  async onRequest(_request: Request): Promise<Response> {
    return new Response("Test OAuth Agent");
  }

  // Allow tests to configure OAuth callback behavior
  configureOAuthForTest(config: {
    successRedirect?: string;
    errorRedirect?: string;
    useJsonHandler?: boolean; // Use built-in JSON response handler for testing
  }): void {
    if (config.useJsonHandler) {
      this.mcp.configureOAuthCallback({
        customHandler: (result: MCPClientOAuthResult) => {
          return new Response(
            JSON.stringify({
              custom: true,
              serverId: result.serverId,
              success: result.authSuccess,
              error: result.authError
            }),
            {
              status: result.authSuccess ? 200 : 401,
              headers: { "content-type": "application/json" }
            }
          );
        }
      });
    } else {
      this.mcp.configureOAuthCallback(config);
    }
  }

  private mockStateStorage: Map<
    string,
    { serverId: string; createdAt: number }
  > = new Map();

  private createMockMcpConnection(
    serverId: string,
    serverUrl: string,
    connectionState: "ready" | "authenticating" | "connecting" = "ready"
  ): MCPClientConnection {
    const self = this;
    return {
      url: new URL(serverUrl),
      connectionState,
      tools: [],
      resources: [],
      prompts: [],
      resourceTemplates: [],
      serverCapabilities: undefined,
      lastConnectedTransport: undefined,
      options: {
        transport: {
          authProvider: {
            clientId: "test-client-id",
            serverId: serverId,
            authUrl: "http://example.com/oauth/authorize",
            async checkState(
              state: string
            ): Promise<{ valid: boolean; serverId?: string; error?: string }> {
              const parts = state.split(".");
              if (parts.length !== 2) {
                return { valid: false, error: "Invalid state format" };
              }
              const [nonce, stateServerId] = parts;
              const stored = self.mockStateStorage.get(nonce);
              if (!stored) {
                return {
                  valid: false,
                  error: "State not found or already used"
                };
              }
              // Note: checkState does NOT consume the state
              if (stored.serverId !== stateServerId) {
                return { valid: false, error: "State serverId mismatch" };
              }
              const age = Date.now() - stored.createdAt;
              if (age > 10 * 60 * 1000) {
                return { valid: false, error: "State expired" };
              }
              return { valid: true, serverId: stateServerId };
            },
            async consumeState(state: string): Promise<void> {
              const parts = state.split(".");
              if (parts.length !== 2) {
                return;
              }
              const [nonce] = parts;
              self.mockStateStorage.delete(nonce);
            },
            async deleteCodeVerifier(): Promise<void> {
              // No-op for tests
            }
          }
        }
      },
      completeAuthorization: async (_code: string) => {
        this.mcp.mcpConnections[serverId].connectionState = "ready";
      },
      establishConnection: async () => {
        this.mcp.mcpConnections[serverId].connectionState = "ready";
      }
    } as unknown as MCPClientConnection;
  }

  saveStateForTest(nonce: string, serverId: string): void {
    this.mockStateStorage.set(nonce, { serverId, createdAt: Date.now() });
  }

  setupMockMcpConnection(
    serverId: string,
    serverName: string,
    serverUrl: string,
    callbackUrl: string,
    clientId?: string | null
  ): void {
    this.sql`
      INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id, name, server_url, client_id, auth_url, callback_url, server_options
      ) VALUES (
        ${serverId},
        ${serverName},
        ${serverUrl},
        ${clientId ?? null},
        ${null},
        ${callbackUrl},
        ${null}
      )
    `;
    this.mcp.mcpConnections[serverId] = this.createMockMcpConnection(
      serverId,
      serverUrl,
      "ready"
    );
  }

  async setupMockOAuthState(
    serverId: string,
    _code: string,
    _state: string,
    options?: { createConnection?: boolean }
  ): Promise<void> {
    if (options?.createConnection) {
      const server = this.getMcpServerFromDb(serverId);
      if (!server) {
        throw new Error(
          `Test error: Server ${serverId} not found in DB. Set up DB record before calling setupMockOAuthState.`
        );
      }

      this.mcp.mcpConnections[serverId] = this.createMockMcpConnection(
        serverId,
        server.server_url,
        "authenticating"
      );
    } else if (this.mcp.mcpConnections[serverId]) {
      const conn = this.mcp.mcpConnections[serverId];
      conn.connectionState = "authenticating";
      conn.completeAuthorization = async (_code: string) => {
        this.mcp.mcpConnections[serverId].connectionState = "ready";
      };
    }
  }

  getMcpServerFromDb(serverId: string) {
    const servers = this.sql<{
      id: string;
      name: string;
      server_url: string;
      client_id: string | null;
      auth_url: string | null;
      callback_url: string;
      server_options: string | null;
    }>`
      SELECT id, name, server_url, client_id, auth_url, callback_url, server_options
      FROM cf_agents_mcp_servers
      WHERE id = ${serverId}
    `;
    return servers.length > 0 ? servers[0] : null;
  }

  isCallbackUrlRegistered(callbackUrl: string): boolean {
    return this.mcp.isCallbackRequest(new Request(callbackUrl));
  }

  testIsCallbackRequest(request: Request): boolean {
    return this.mcp.isCallbackRequest(request);
  }

  removeMcpConnection(serverId: string): void {
    delete this.mcp.mcpConnections[serverId];
  }

  hasMcpConnection(serverId: string): boolean {
    return !!this.mcp.mcpConnections[serverId];
  }

  resetMcpStateRestoredFlag(): void {
    // @ts-expect-error - accessing private property for testing
    this._mcpConnectionsInitialized = false;
  }

  testCreateMcpOAuthProvider(callbackUrl: string): {
    isDurableObjectProvider: boolean;
    callbackUrl: string;
  } {
    const provider = this.createMcpOAuthProvider(callbackUrl);
    return {
      isDurableObjectProvider:
        provider instanceof DurableObjectOAuthClientProvider,
      callbackUrl: String(provider.redirectUrl ?? "")
    };
  }

  async testPkceVerifierStateCorrelation(): Promise<{
    state1Verifier: string;
    state2Verifier: string;
    staleStateIgnoredVerifier: string;
    challengeVerifierAfterFallbackCleanup: string;
  }> {
    const provider = new DurableObjectOAuthClientProvider(
      this.ctx.storage,
      `pkce-correlation-${crypto.randomUUID()}`,
      "https://client.example.com/callback"
    );
    provider.serverId = `server-${crypto.randomUUID()}`;
    provider.clientId = `client-${crypto.randomUUID()}`;

    const verifier1 = `verifier-one-${crypto.randomUUID()}`;
    const verifier2 = `verifier-two-${crypto.randomUUID()}`;

    const state1 = await provider.state();
    await provider.saveCodeVerifier(verifier1);
    await provider.redirectToAuthorization(
      await createAuthorizationUrl(state1, verifier1)
    );

    const state2 = await provider.state();
    await provider.saveCodeVerifier(verifier2);
    await provider.redirectToAuthorization(
      await createAuthorizationUrl(state2, verifier2)
    );

    const statefulProvider = provider as DurableObjectOAuthClientProvider & {
      runWithCodeVerifierState?: <T>(
        state: string,
        callback: () => Promise<T>
      ) => Promise<T>;
    };
    if (!statefulProvider.runWithCodeVerifierState) {
      throw new Error("PKCE verifier state context is not available");
    }

    const state1Verifier = await statefulProvider.runWithCodeVerifierState(
      state1,
      () => provider.codeVerifier()
    );
    const state2Verifier = await statefulProvider.runWithCodeVerifierState(
      state2,
      () => provider.codeVerifier()
    );

    await provider.consumeState(state1);
    const verifier3 = `verifier-three-${crypto.randomUUID()}`;
    const state3 = await provider.state();
    await provider.saveCodeVerifier(verifier3);
    await provider.redirectToAuthorization(
      await createAuthorizationUrl(state3, verifier3)
    );
    const staleStateIgnoredVerifier =
      await statefulProvider.runWithCodeVerifierState(state3, () =>
        provider.codeVerifier()
      );

    const verifier4 = `verifier-four-${crypto.randomUUID()}`;
    const state4 = await provider.state();
    await provider.saveCodeVerifier(verifier4);
    await provider.deleteCodeVerifier();
    await provider.redirectToAuthorization(
      await createAuthorizationUrl(state4, verifier4)
    );
    const challengeVerifierAfterFallbackCleanup =
      await statefulProvider.runWithCodeVerifierState(state4, () =>
        provider.codeVerifier()
      );

    return {
      state1Verifier,
      state2Verifier,
      staleStateIgnoredVerifier,
      challengeVerifierAfterFallbackCleanup
    };
  }

  // --- Provider-level PKCE branch coverage helpers ---

  private newPkceProvider(): DurableObjectOAuthClientProvider {
    const provider = new DurableObjectOAuthClientProvider(
      this.ctx.storage,
      `pkce-branch-${crypto.randomUUID()}`,
      "https://client.example.com/callback"
    );
    provider.serverId = `server-${crypto.randomUUID()}`;
    provider.clientId = `client-${crypto.randomUUID()}`;
    return provider;
  }

  private async storageHas(
    provider: DurableObjectOAuthClientProvider,
    key: string
  ): Promise<boolean> {
    return (await provider.storage.get(key)) !== undefined;
  }

  // redirectToAuthorization must NOT bind the verifier when the state's serverId
  // belongs to a different server (cross-server binding guard).
  async testRedirectIgnoresServerIdMismatch(): Promise<{
    challengeBefore: boolean;
    challengeStillPresent: boolean;
    stateVerifierCreated: boolean;
  }> {
    const provider = this.newPkceProvider();
    const verifier = `verifier-${crypto.randomUUID()}`;
    const challenge = await createCodeChallenge(verifier);
    await provider.saveCodeVerifier(verifier);
    const challengeKey = provider.challengeCodeVerifierKey(
      provider.clientId,
      challenge
    );
    const challengeBefore = await this.storageHas(provider, challengeKey);

    const nonce = `nonce-${crypto.randomUUID()}`;
    const foreignState = `${nonce}.other-server-${crypto.randomUUID()}`;
    const authUrl = new URL("https://auth.example.com/authorize");
    authUrl.searchParams.set("state", foreignState);
    authUrl.searchParams.set("code_challenge", challenge);
    await provider.redirectToAuthorization(authUrl);

    const stateKey = provider.stateCodeVerifierKey(provider.clientId, nonce);
    return {
      challengeBefore,
      challengeStillPresent: await this.storageHas(provider, challengeKey),
      stateVerifierCreated: await this.storageHas(provider, stateKey)
    };
  }

  // Positive control for the binding guard: a matching serverId MUST promote the
  // verifier from the challenge key to the state-nonce key (and delete the
  // challenge key). Pairs with the negative guard tests so those cannot pass
  // simply because promotion is broken everywhere.
  async testRedirectPromotesMatchingServerId(): Promise<{
    challengeBefore: boolean;
    stateBefore: boolean;
    challengeAfter: boolean;
    stateAfter: boolean;
    storedVerifierMatches: boolean;
  }> {
    const provider = this.newPkceProvider();
    const verifier = `verifier-${crypto.randomUUID()}`;
    const challenge = await createCodeChallenge(verifier);
    const state = await provider.state();
    const [nonce] = state.split(".");
    if (!nonce) {
      throw new Error("Test setup failed to derive nonce from state");
    }
    await provider.saveCodeVerifier(verifier);

    const challengeKey = provider.challengeCodeVerifierKey(
      provider.clientId,
      challenge
    );
    const stateKey = provider.stateCodeVerifierKey(provider.clientId, nonce);
    const challengeBefore = await this.storageHas(provider, challengeKey);
    const stateBefore = await this.storageHas(provider, stateKey);

    await provider.redirectToAuthorization(
      await createAuthorizationUrl(state, verifier)
    );

    const stored = await provider.storage.get<{ verifier: string }>(stateKey);
    return {
      challengeBefore,
      stateBefore,
      challengeAfter: await this.storageHas(provider, challengeKey),
      stateAfter: await this.storageHas(provider, stateKey),
      storedVerifierMatches: stored?.verifier === verifier
    };
  }

  // redirectToAuthorization is a no-op when the authorization URL lacks state or
  // code_challenge; the verifier stays orphaned under the challenge key and no
  // state-nonce key is created (distinguishes a correct early-return from a
  // silently broken promotion).
  async testRedirectWithoutStateOrChallengeKeepsOrphan(): Promise<{
    challengeAfterNoState: boolean;
    stateAfterNoState: boolean;
    challengeAfterNoChallenge: boolean;
    stateAfterNoChallenge: boolean;
  }> {
    const provider = this.newPkceProvider();
    const verifier = `verifier-${crypto.randomUUID()}`;
    const challenge = await createCodeChallenge(verifier);
    await provider.saveCodeVerifier(verifier);
    const challengeKey = provider.challengeCodeVerifierKey(
      provider.clientId,
      challenge
    );

    const noStateNonce = `nonce-${crypto.randomUUID()}`;
    const noState = new URL("https://auth.example.com/authorize");
    noState.searchParams.set("code_challenge", challenge);
    // Even though this URL has no state param, assert nothing was promoted under
    // a nonce we control for comparison.
    await provider.redirectToAuthorization(noState);
    const challengeAfterNoState = await this.storageHas(provider, challengeKey);
    const stateAfterNoState = await this.storageHas(
      provider,
      provider.stateCodeVerifierKey(provider.clientId, noStateNonce)
    );

    const noChallengeNonce = `nonce-${crypto.randomUUID()}`;
    const noChallenge = new URL("https://auth.example.com/authorize");
    noChallenge.searchParams.set(
      "state",
      `${noChallengeNonce}.${provider.serverId}`
    );
    await provider.redirectToAuthorization(noChallenge);
    const challengeAfterNoChallenge = await this.storageHas(
      provider,
      challengeKey
    );
    const stateAfterNoChallenge = await this.storageHas(
      provider,
      provider.stateCodeVerifierKey(provider.clientId, noChallengeNonce)
    );

    return {
      challengeAfterNoState,
      stateAfterNoState,
      challengeAfterNoChallenge,
      stateAfterNoChallenge
    };
  }

  async testRedirectWithoutIdsDoesNotThrow(): Promise<{ authUrl: string }> {
    const provider = new DurableObjectOAuthClientProvider(
      this.ctx.storage,
      `pkce-branch-${crypto.randomUUID()}`,
      "https://client.example.com/callback"
    );
    const authUrl = new URL("https://auth.example.com/authorize");
    authUrl.searchParams.set("state", `nonce-${crypto.randomUUID()}.server`);
    authUrl.searchParams.set(
      "code_challenge",
      `challenge-${crypto.randomUUID()}`
    );

    await provider.redirectToAuthorization(authUrl);

    return { authUrl: provider.authUrl ?? "" };
  }

  // codeVerifier() with no ALS context and multiple pending verifiers must fail
  // loudly rather than guess (this replaces the old silent wrong-verifier bug).
  async testCodeVerifierMultiplePendingThrows(): Promise<{
    threw: boolean;
    message: string;
  }> {
    const provider = this.newPkceProvider();
    const v1 = `verifier-one-${crypto.randomUUID()}`;
    const v2 = `verifier-two-${crypto.randomUUID()}`;
    const s1 = await provider.state();
    await provider.saveCodeVerifier(v1);
    await provider.redirectToAuthorization(
      await createAuthorizationUrl(s1, v1)
    );
    const s2 = await provider.state();
    await provider.saveCodeVerifier(v2);
    await provider.redirectToAuthorization(
      await createAuthorizationUrl(s2, v2)
    );

    try {
      await provider.codeVerifier();
      return { threw: false, message: "" };
    } catch (err) {
      return {
        threw: true,
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // codeVerifier() with no ALS context and exactly one pending verifier resolves
  // it (the deprecated reconnect path's happy case).
  async testCodeVerifierSinglePendingFallback(): Promise<{
    resolved: string;
    expected: string;
  }> {
    const provider = this.newPkceProvider();
    const v1 = `verifier-only-${crypto.randomUUID()}`;
    const s1 = await provider.state();
    await provider.saveCodeVerifier(v1);
    await provider.redirectToAuthorization(
      await createAuthorizationUrl(s1, v1)
    );
    const resolved = await provider.codeVerifier();
    return { resolved, expected: v1 };
  }

  // codeVerifier() inside a state context with no stored verifier throws a
  // state-specific error rather than falling back.
  async testCodeVerifierStateContextNoVerifierThrows(): Promise<{
    threw: boolean;
    message: string;
  }> {
    const provider = this.newPkceProvider();
    const state = await provider.state();
    try {
      await provider.runWithCodeVerifierState(state, () =>
        provider.codeVerifier()
      );
      return { threw: false, message: "" };
    } catch (err) {
      return {
        threw: true,
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // checkState() on an expired state also deletes the bound state verifier
  // (the closest thing to a client-side verifier TTL).
  async testCheckStateExpiredDeletesVerifier(): Promise<{
    valid: boolean;
    error: string;
    stateKeyExists: boolean;
    verifierKeyExists: boolean;
  }> {
    const provider = this.newPkceProvider();
    const nonce = `nonce-${crypto.randomUUID()}`;
    const old = Date.now() - 11 * 60 * 1000;
    await provider.storage.put(provider.stateKey(nonce), {
      nonce,
      serverId: provider.serverId,
      createdAt: old
    });
    const verifierKey = provider.stateCodeVerifierKey(provider.clientId, nonce);
    await provider.storage.put(verifierKey, {
      verifier: "stale-verifier",
      createdAt: old
    });

    const result = await provider.checkState(`${nonce}.${provider.serverId}`);
    return {
      valid: result.valid,
      error: result.error ?? "",
      stateKeyExists: await this.storageHas(provider, provider.stateKey(nonce)),
      verifierKeyExists: await this.storageHas(provider, verifierKey)
    };
  }

  // codeVerifier() resolving an expired state verifier deletes it and throws.
  async testCodeVerifierStateExpiredThrows(): Promise<{
    threw: boolean;
    message: string;
    verifierKeyExists: boolean;
  }> {
    const provider = this.newPkceProvider();
    const nonce = `nonce-${crypto.randomUUID()}`;
    const old = Date.now() - 11 * 60 * 1000;
    const verifierKey = provider.stateCodeVerifierKey(provider.clientId, nonce);
    await provider.storage.put(verifierKey, {
      verifier: "stale-verifier",
      createdAt: old
    });

    let threw = false;
    let message = "";
    try {
      await provider.runWithCodeVerifierState(
        `${nonce}.${provider.serverId}`,
        () => provider.codeVerifier()
      );
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    return {
      threw,
      message,
      verifierKeyExists: await this.storageHas(provider, verifierKey)
    };
  }

  // invalidateCredentials("verifier") sweeps every pending verifier (both bound
  // state verifiers and orphaned challenge verifiers), not just one slot.
  // Also pins that codeVerifierKeys excludes orphaned challenge keys by default
  // (so a no-context deleteCodeVerifier cannot nuke another flow's pending
  // challenge verifier) but includes them under includeChallengeKeys.
  async testInvalidateVerifierDeletesAllPending(): Promise<{
    defaultBefore: number;
    withChallengeBefore: number;
    after: number;
  }> {
    const provider = this.newPkceProvider();
    const v1 = `verifier-one-${crypto.randomUUID()}`;
    const v2 = `verifier-two-${crypto.randomUUID()}`;
    const s1 = await provider.state();
    await provider.saveCodeVerifier(v1);
    await provider.redirectToAuthorization(
      await createAuthorizationUrl(s1, v1)
    );
    const s2 = await provider.state();
    await provider.saveCodeVerifier(v2);
    await provider.redirectToAuthorization(
      await createAuthorizationUrl(s2, v2)
    );
    // An orphaned challenge verifier (saved but never redirected).
    await provider.saveCodeVerifier(`verifier-three-${crypto.randomUUID()}`);

    // Default excludes the orphaned challenge key: only the 2 promoted state
    // verifiers are counted.
    const defaultBefore = (await provider.codeVerifierKeys(provider.clientId))
      .length;
    // With challenge keys included, the orphan is counted too -> 3.
    const withChallengeBefore = (
      await provider.codeVerifierKeys(provider.clientId, {
        includeChallengeKeys: true
      })
    ).length;
    await provider.invalidateCredentials("verifier");
    const after = (
      await provider.codeVerifierKeys(provider.clientId, {
        includeChallengeKeys: true
      })
    ).length;
    return { defaultBefore, withChallengeBefore, after };
  }

  async testSaveCodeVerifierDeletesExpiredChallengeOrphans(): Promise<{
    expiredBefore: boolean;
    expiredAfter: boolean;
    freshAfter: boolean;
  }> {
    const provider = this.newPkceProvider();
    const expiredKey = provider.challengeCodeVerifierKey(
      provider.clientId,
      `expired-challenge-${crypto.randomUUID()}`
    );
    await provider.storage.put(expiredKey, {
      verifier: "expired-verifier",
      createdAt: Date.now() - 11 * 60 * 1000
    });

    const freshVerifier = `fresh-verifier-${crypto.randomUUID()}`;
    const freshChallenge = await createCodeChallenge(freshVerifier);
    const freshKey = provider.challengeCodeVerifierKey(
      provider.clientId,
      freshChallenge
    );

    const expiredBefore = await this.storageHas(provider, expiredKey);
    await provider.saveCodeVerifier(freshVerifier);

    return {
      expiredBefore,
      expiredAfter: await this.storageHas(provider, expiredKey),
      freshAfter: await this.storageHas(provider, freshKey)
    };
  }
}

// Test Agent that overrides createMcpOAuthProvider with a custom implementation
export class TestCustomOAuthAgent extends Agent {
  private _customProviderCallbackUrl: string | undefined;

  createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    this._customProviderCallbackUrl = callbackUrl;
    // Return a minimal mock that satisfies the interface
    return {
      authUrl: undefined,
      clientId: "custom-client-id",
      serverId: undefined,
      redirectUrl: callbackUrl,
      get clientMetadata() {
        return { redirect_uris: [callbackUrl] };
      },
      get clientUri() {
        return callbackUrl;
      },
      checkState: async () => ({ valid: false }),
      consumeState: async () => {},
      deleteCodeVerifier: async () => {},
      clientInformation: async () => undefined,
      saveClientInformation: async () => {},
      tokens: async () => undefined,
      saveTokens: async () => {},
      state: async () => "mock-state",
      redirectToAuthorization: async () => {},
      invalidateCredentials: async () => {},
      saveCodeVerifier: async () => {},
      codeVerifier: async () => "mock-verifier"
    } as AgentMcpOAuthProvider;
  }

  testCreateMcpOAuthProvider(callbackUrl: string): {
    isDurableObjectProvider: boolean;
    clientId: string | undefined;
    callbackUrl: string | undefined;
  } {
    const provider = this.createMcpOAuthProvider(callbackUrl);
    return {
      isDurableObjectProvider:
        provider instanceof DurableObjectOAuthClientProvider,
      clientId: provider.clientId,
      callbackUrl: this._customProviderCallbackUrl
    };
  }

  async testRestoreUsesOverride(): Promise<{
    overrideWasCalled: boolean;
    restoredProviderClientId: string | undefined;
  }> {
    const serverId = "restore-override-test";
    const callbackUrl = "http://example.com/restore-callback";

    this.sql`
      INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id, name, server_url, client_id, auth_url, callback_url, server_options
      ) VALUES (
        ${serverId},
        ${"Restore Test Server"},
        ${"http://restore-test.com"},
        ${null},
        ${"https://auth.example.com/authorize"},
        ${callbackUrl},
        ${null}
      )
    `;

    // Reset restored flag so restoreConnectionsFromStorage runs again
    // @ts-expect-error - accessing private property for testing
    this.mcp._isRestored = false;
    // Clear any existing connection for this server
    delete this.mcp.mcpConnections[serverId];

    this._customProviderCallbackUrl = undefined;
    await this.mcp.restoreConnectionsFromStorage(this.name);

    const conn = this.mcp.mcpConnections[serverId];
    return {
      overrideWasCalled: this._customProviderCallbackUrl === callbackUrl,
      restoredProviderClientId: conn?.options.transport.authProvider?.clientId
    };
  }
}
