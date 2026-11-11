import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens
} from "@modelcontextprotocol/client";
import { validateClientMetadataUrl } from "@modelcontextprotocol/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";

const STATE_EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes

const codeVerifierStateStorage = new AsyncLocalStorage<{
  state: string;
  servedKey?: string;
}>();

interface StoredState {
  nonce: string;
  serverId: string;
  /** The client the link was issued for; absent on states stored before. */
  clientId?: string;
  createdAt: number;
}

interface StoredCodeVerifier {
  verifier: string;
  createdAt: number;
}

// A slight extension to the standard OAuthClientProvider interface because `redirectToAuthorization` doesn't give us the interface we need
// This allows us to track authentication for a specific server and associated dynamic client registration
export interface AgentMcpOAuthProvider extends OAuthClientProvider {
  authUrl: string | undefined;
  clientId: string | undefined;
  serverId: string | undefined;
  checkState(
    state: string
  ): Promise<{ valid: boolean; serverId?: string; error?: string }>;
  consumeState(state: string): Promise<void>;
  runWithCodeVerifierState?<T>(
    state: string,
    callback: () => Promise<T>
  ): Promise<T>;
  deleteCodeVerifier(): Promise<void>;
}

function parseOAuthState(
  state: string
): { nonce: string; serverId: string } | undefined {
  const parts = state.split(".");
  if (parts.length !== 2) {
    return undefined;
  }

  const [nonce, serverId] = parts;
  if (!nonce || !serverId) {
    return undefined;
  }

  return { nonce, serverId };
}

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

function isExpired(createdAt: number): boolean {
  return Date.now() - createdAt > STATE_EXPIRATION_MS;
}

/**
 * @deprecated Use {@link AgentMcpOAuthProvider} instead.
 */
export type AgentsOAuthProvider = AgentMcpOAuthProvider;

export interface DurableObjectOAuthClientProviderOptions {
  /**
   * HTTPS URL of this client's OAuth Client ID Metadata Document.
   *
   * When an authorization server advertises
   * `client_id_metadata_document_supported`, the client uses this URL as its
   * `client_id` instead of dynamic client registration. Other servers still
   * use dynamic client registration. Serve
   * {@link DurableObjectOAuthClientProvider.clientMetadataDocument} at this
   * URL, and use a stable `callbackPath` so the document's `redirect_uris`
   * match every authorization request.
   */
  clientMetadataUrl?: string;
}

export class DurableObjectOAuthClientProvider implements AgentMcpOAuthProvider {
  private _authUrl_: string | undefined;
  private _serverId_: string | undefined;
  private _clientId_: string | undefined;
  /**
   * Set once this provider's server was removed (clearServerStorage), or
   * its connection replaced by a new one (retire). Work it started may
   * still be running, such as a token refresh: what it would save
   * afterwards is dropped, and it deletes nothing, so it neither outlives
   * the removal nor touches the new connection's grant.
   */
  private _retired_ = false;
  /** Tokens saved after retiring: kept in memory only, for work in flight. */
  private _retiredTokens_: StoredOAuthTokens | undefined;
  readonly clientMetadataUrl: string | undefined;

  constructor(
    public storage: DurableObjectStorage,
    public clientName: string,
    public baseRedirectUrl: string,
    options: DurableObjectOAuthClientProviderOptions = {}
  ) {
    if (!storage) {
      throw new Error(
        "DurableObjectOAuthClientProvider requires a valid DurableObjectStorage instance"
      );
    }
    validateClientMetadataUrl(options.clientMetadataUrl);
    this.clientMetadataUrl = options.clientMetadataUrl || undefined;
  }

  /**
   * The Client ID Metadata Document to serve at `clientMetadataUrl`.
   * Throws when the provider has no `clientMetadataUrl`.
   */
  get clientMetadataDocument(): OAuthClientMetadata & { client_id: string } {
    if (!this.clientMetadataUrl) {
      throw new Error(
        "clientMetadataDocument requires a clientMetadataUrl option"
      );
    }
    return { client_id: this.clientMetadataUrl, ...this.clientMetadata };
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      client_uri: this.clientUri,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }

  get clientUri() {
    return new URL(this.redirectUrl).origin;
  }

  get redirectUrl() {
    return this.baseRedirectUrl;
  }

  get clientId() {
    if (!this._clientId_) {
      throw new Error("Trying to access clientId before it was set");
    }
    return this._clientId_;
  }

  set clientId(clientId_: string) {
    this._clientId_ = clientId_;
  }

  get serverId() {
    if (!this._serverId_) {
      throw new Error("Trying to access serverId before it was set");
    }
    return this._serverId_;
  }

  set serverId(serverId_: string) {
    this._serverId_ = serverId_;
  }

  keyPrefix(clientId: string) {
    return `/${this.clientName}/${this.serverId}/${clientId}`;
  }

  clientInfoKey(clientId: string) {
    return `${this.keyPrefix(clientId)}/client_info/`;
  }

  discoveryStateKey() {
    return `/${this.clientName}/${this.serverId}/oauth_discovery`;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    if (this._retired_) return;
    await this.storage.put(this.discoveryStateKey(), state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (
      (await this.storage.get<OAuthDiscoveryState>(this.discoveryStateKey())) ??
      undefined
    );
  }

  async clientInformation(
    _context?: OAuthClientInformationContext
  ): Promise<StoredOAuthClientInformation | undefined> {
    if (!this._clientId_) return undefined;
    return (
      (await this.storage.get<StoredOAuthClientInformation>(
        this.clientInfoKey(this.clientId)
      )) ?? undefined
    );
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    _context?: OAuthClientInformationContext
  ): Promise<void> {
    this.clientId = clientInformation.client_id;
    if (this._retired_) return;
    // Round-trip the SDK's issuer stamp verbatim. The SDK treats a credential
    // stamped for another issuer as absent, so one durable slot per MCP server
    // is both sufficient and safer than maintaining our own issuer index.
    await this.storage.put(
      this.clientInfoKey(clientInformation.client_id),
      clientInformation
    );
  }

  tokenKey(clientId: string) {
    return `${this.keyPrefix(clientId)}/token`;
  }

  async tokens(
    _context?: OAuthClientInformationContext
  ): Promise<StoredOAuthTokens | undefined> {
    if (this._retired_) return this._retiredTokens_;
    if (!this._clientId_) return undefined;
    return (
      (await this.storage.get<StoredOAuthTokens>(
        this.tokenKey(this.clientId)
      )) ?? undefined
    );
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    _context?: OAuthClientInformationContext
  ): Promise<void> {
    // Keep the SDK-owned issuer stamp intact for SEP-2352 validation. Discovery
    // is needed across the browser redirect, but once token issuance succeeds
    // it must not pin later re-authorization to this AS: a subsequent 401 must
    // re-read PRM so an authorization-server migration can be observed.
    if (this._retired_) {
      this._retiredTokens_ = tokens;
      return;
    }
    await this.storage.put(this.tokenKey(this.clientId), tokens);
    // A link still waiting for its callback (a step-up while the session
    // refreshes its token) needs the discovery state on the callback leg:
    // the SDK refuses to exchange its code without it.
    if (await this.hasPendingLink()) return;
    await this.storage.delete(this.discoveryStateKey());
  }

  /** Whether a link other than the one being redeemed awaits its callback. */
  private async hasPendingLink(): Promise<boolean> {
    const served = codeVerifierStateStorage.getStore()?.servedKey;
    const pending = await this.storage.list<StoredCodeVerifier>({
      prefix: this.stateCodeVerifierPrefix(this.clientId)
    });
    for (const [key, verifier] of pending) {
      if (key !== served && !isExpired(verifier.createdAt)) return true;
    }
    return false;
  }

  get authUrl() {
    return this._authUrl_;
  }

  stateKey(nonce: string) {
    return `/${this.clientName}/${this.serverId}/state/${nonce}`;
  }

  async state(): Promise<string> {
    const nonce = nanoid();
    const state = `${nonce}.${this.serverId}`;
    const storedState: StoredState = {
      nonce,
      serverId: this.serverId,
      clientId: this._clientId_,
      createdAt: Date.now()
    };
    if (!this._retired_) {
      await this.storage.put(this.stateKey(nonce), storedState);
    }
    return state;
  }

  async checkState(
    state: string
  ): Promise<{ valid: boolean; serverId?: string; error?: string }> {
    const parsed = parseOAuthState(state);
    if (!parsed) {
      return { valid: false, error: "Invalid state format" };
    }

    const { nonce, serverId } = parsed;
    const key = this.stateKey(nonce);
    const storedState = await this.storage.get<StoredState>(key);

    if (!storedState) {
      return { valid: false, error: "State not found or already used" };
    }

    if (storedState.serverId !== serverId) {
      await this.storage.delete(key);
      return { valid: false, error: "State serverId mismatch" };
    }

    // Issued for another client: a connection this one replaced (closed and
    // registered again). Its verifier belongs to that client, so the code
    // could never be exchanged here.
    if (
      storedState.clientId !== undefined &&
      storedState.clientId !== this._clientId_
    ) {
      return { valid: false, error: "State was issued for another client" };
    }

    if (isExpired(storedState.createdAt)) {
      const deleteKeys = [key];
      if (this._clientId_) {
        deleteKeys.push(this.stateCodeVerifierKey(this.clientId, nonce));
      }
      await this.storage.delete(deleteKeys);
      return { valid: false, error: "State expired" };
    }

    return { valid: true, serverId };
  }

  async consumeState(state: string): Promise<void> {
    const parsed = parseOAuthState(state);
    if (!parsed) {
      // This should never happen since checkState validates format first.
      // Log for debugging but don't throw - state consumption is best-effort.
      console.warn(`[OAuth] consumeState called with invalid state format`);
      return;
    }
    if (this._retired_) return;
    await this.storage.delete(this.stateKey(parsed.nonce));
  }

  async redirectToAuthorization(authUrl: URL): Promise<void> {
    this._authUrl_ = authUrl.toString();
    if (this._retired_) return;

    const clientId = this._clientId_;
    const serverId = this._serverId_;
    if (!clientId || !serverId) {
      return;
    }

    const state = authUrl.searchParams.get("state");
    const codeChallenge = authUrl.searchParams.get("code_challenge");
    if (!state || !codeChallenge) {
      return;
    }

    const parsed = parseOAuthState(state);
    if (!parsed || parsed.serverId !== serverId) {
      return;
    }

    const challengeKey = this.challengeCodeVerifierKey(clientId, codeChallenge);
    const pendingVerifier =
      await this.storage.get<StoredCodeVerifier>(challengeKey);
    if (!pendingVerifier) {
      return;
    }

    if (isExpired(pendingVerifier.createdAt)) {
      await this.storage.delete(challengeKey);
      return;
    }

    await this.storage.put(
      this.stateCodeVerifierKey(clientId, parsed.nonce),
      pendingVerifier
    );
    await this.storage.delete(challengeKey);
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ): Promise<void> {
    // Storage belongs to the connection that replaced this one, or is gone.
    if (this._retired_) {
      if (scope === "all" || scope === "tokens") {
        this._retiredTokens_ = undefined;
      }
      return;
    }
    const deleteKeys: string[] = [];

    if (scope === "all" || scope === "discovery") {
      deleteKeys.push(this.discoveryStateKey());
    }

    if (this._clientId_) {
      const clientId = this.clientId;
      if (scope === "all" || scope === "client") {
        deleteKeys.push(this.clientInfoKey(clientId));
      }
      if (scope === "all" || scope === "tokens") {
        deleteKeys.push(this.tokenKey(clientId));
      }
      if (scope === "all" || scope === "verifier") {
        deleteKeys.push(
          ...(await this.codeVerifierKeys(clientId, {
            includeChallengeKeys: true
          }))
        );
      }
    }

    if (deleteKeys.length > 0) {
      await this.storage.delete([...new Set(deleteKeys)]);
    }
  }

  /**
   * Delete every key this provider stores for its server: tokens and client
   * info for any client ID, verifiers, pending states and discovery state.
   * Used when the server is removed. Other servers' keys are untouched.
   * From then on, this provider stores nothing.
   */
  async clearServerStorage(): Promise<void> {
    this.retire();
    const keys = [
      ...(
        await this.storage.list({
          prefix: `/${this.clientName}/${this.serverId}/`
        })
      ).keys()
    ];
    // DO storage caps a multi-key delete at 128 keys.
    for (let i = 0; i < keys.length; i += 128) {
      await this.storage.delete(keys.slice(i, i + 128));
    }
  }

  /**
   * @internal Store nothing more: the connection using this provider was
   * replaced or its server removed, while its work may still be running.
   */
  retire(): void {
    this._retired_ = true;
  }

  /** @internal Store again: a new connection was registered with this provider. */
  revive(): void {
    this._retired_ = false;
    this._retiredTokens_ = undefined;
  }

  codeVerifierKey(clientId: string) {
    return `${this.keyPrefix(clientId)}/code_verifier`;
  }

  stateCodeVerifierPrefix(clientId: string) {
    return `${this.keyPrefix(clientId)}/code_verifier/`;
  }

  stateCodeVerifierKey(clientId: string, nonce: string) {
    return `${this.stateCodeVerifierPrefix(clientId)}${nonce}`;
  }

  challengeCodeVerifierPrefix(clientId: string) {
    return `${this.keyPrefix(clientId)}/code_verifier_challenge/`;
  }

  challengeCodeVerifierKey(clientId: string, codeChallenge: string) {
    return `${this.challengeCodeVerifierPrefix(clientId)}${codeChallenge}`;
  }

  async codeVerifierKeys(
    clientId: string,
    options: { includeChallengeKeys?: boolean } = {}
  ): Promise<string[]> {
    const legacyKey = this.codeVerifierKey(clientId);
    const keys: string[] = [];

    if (await this.storage.get(legacyKey)) {
      keys.push(legacyKey);
    }

    const stateKeys = await this.storage.list({
      prefix: this.stateCodeVerifierPrefix(clientId)
    });
    keys.push(...stateKeys.keys());

    if (options.includeChallengeKeys) {
      const challengeKeys = await this.storage.list({
        prefix: this.challengeCodeVerifierPrefix(clientId)
      });
      keys.push(...challengeKeys.keys());
    }

    return keys;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (this._retired_) return;
    await this.deleteExpiredChallengeCodeVerifiers(this.clientId);

    const codeChallenge = await createCodeChallenge(verifier);
    const storedVerifier: StoredCodeVerifier = {
      verifier,
      createdAt: Date.now()
    };

    await this.storage.put(
      this.challengeCodeVerifierKey(this.clientId, codeChallenge),
      storedVerifier
    );
  }

  private async deleteExpiredChallengeCodeVerifiers(
    clientId: string
  ): Promise<void> {
    const challengeVerifiers = await this.storage.list<StoredCodeVerifier>({
      prefix: this.challengeCodeVerifierPrefix(clientId)
    });
    const expiredKeys = [...challengeVerifiers.entries()]
      .filter(([, storedVerifier]) => isExpired(storedVerifier.createdAt))
      .map(([key]) => key);
    if (expiredKeys.length > 0) {
      await this.storage.delete(expiredKeys);
    }
  }

  async codeVerifier(): Promise<string> {
    const context = codeVerifierStateStorage.getStore();
    if (context) {
      const stateVerifier = await this.codeVerifierForState(context.state);
      if (stateVerifier) {
        context.servedKey = stateVerifier.key;
        return stateVerifier.verifier;
      }
    }

    const legacyVerifier = await this.storage.get<string>(
      this.codeVerifierKey(this.clientId)
    );
    if (legacyVerifier) {
      if (context) {
        context.servedKey = this.codeVerifierKey(this.clientId);
      }
      return legacyVerifier;
    }

    if (context) {
      throw new Error("No code verifier found for OAuth state");
    }

    const pendingVerifiers = await this.storage.list<StoredCodeVerifier>({
      prefix: this.stateCodeVerifierPrefix(this.clientId)
    });
    const unexpiredPendingVerifiers = [...pendingVerifiers.entries()].filter(
      ([, storedVerifier]) => !isExpired(storedVerifier.createdAt)
    );
    const expiredKeys = [...pendingVerifiers.entries()]
      .filter(([, storedVerifier]) => isExpired(storedVerifier.createdAt))
      .map(([key]) => key);
    if (expiredKeys.length > 0) {
      await this.storage.delete(expiredKeys);
    }

    if (unexpiredPendingVerifiers.length === 1) {
      const [[, storedVerifier]] = unexpiredPendingVerifiers;
      return storedVerifier.verifier;
    }

    if (unexpiredPendingVerifiers.length > 1) {
      throw new Error(
        "Multiple OAuth code verifiers are pending; complete authorization with the callback state"
      );
    }

    throw new Error("No code verifier found");
  }

  private async codeVerifierForState(
    state: string
  ): Promise<{ key: string; verifier: string } | undefined> {
    const parsed = parseOAuthState(state);
    if (!parsed) {
      throw new Error("Invalid state format");
    }

    const key = this.stateCodeVerifierKey(this.clientId, parsed.nonce);
    const storedVerifier = await this.storage.get<StoredCodeVerifier>(key);
    if (!storedVerifier) {
      return undefined;
    }

    if (isExpired(storedVerifier.createdAt)) {
      await this.storage.delete(key);
      throw new Error("Code verifier expired");
    }

    return { key, verifier: storedVerifier.verifier };
  }

  async runWithCodeVerifierState<T>(
    state: string,
    callback: () => Promise<T>
  ): Promise<T> {
    return codeVerifierStateStorage.run({ state }, callback);
  }

  async deleteCodeVerifier(): Promise<void> {
    if (this._retired_) return;
    const context = codeVerifierStateStorage.getStore();
    if (context?.servedKey) {
      await this.storage.delete(context.servedKey);
      return;
    }

    if (context) {
      const parsed = parseOAuthState(context.state);
      if (parsed) {
        await this.storage.delete(
          this.stateCodeVerifierKey(this.clientId, parsed.nonce)
        );
        return;
      }
    }

    const keys = await this.codeVerifierKeys(this.clientId);
    if (keys.length > 0) {
      await this.storage.delete(keys);
    }
  }
}
