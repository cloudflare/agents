import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
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

export class DurableObjectOAuthClientProvider implements AgentMcpOAuthProvider {
  private _authUrl_: string | undefined;
  private _serverId_: string | undefined;
  private _clientId_: string | undefined;

  constructor(
    public storage: DurableObjectStorage,
    public clientName: string,
    public baseRedirectUrl: string
  ) {
    if (!storage) {
      throw new Error(
        "DurableObjectOAuthClientProvider requires a valid DurableObjectStorage instance"
      );
    }
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

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (!this._clientId_) {
      return undefined;
    }
    return (
      (await this.storage.get<OAuthClientInformation>(
        this.clientInfoKey(this.clientId)
      )) ?? undefined
    );
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationFull
  ): Promise<void> {
    await this.storage.put(
      this.clientInfoKey(clientInformation.client_id),
      clientInformation
    );
    this.clientId = clientInformation.client_id;
  }

  tokenKey(clientId: string) {
    return `${this.keyPrefix(clientId)}/token`;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (!this._clientId_) {
      return undefined;
    }
    return (
      (await this.storage.get<OAuthTokens>(this.tokenKey(this.clientId))) ??
      undefined
    );
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.storage.put(this.tokenKey(this.clientId), tokens);
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
      createdAt: Date.now()
    };
    await this.storage.put(this.stateKey(nonce), storedState);
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
    await this.storage.delete(this.stateKey(parsed.nonce));
  }

  async redirectToAuthorization(authUrl: URL): Promise<void> {
    this._authUrl_ = authUrl.toString();

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
    scope: "all" | "client" | "tokens" | "verifier"
  ): Promise<void> {
    if (!this._clientId_) return;

    const deleteKeys: string[] = [];

    if (scope === "all" || scope === "client") {
      deleteKeys.push(this.clientInfoKey(this.clientId));
    }
    if (scope === "all" || scope === "tokens") {
      deleteKeys.push(this.tokenKey(this.clientId));
    }
    if (scope === "all" || scope === "verifier") {
      deleteKeys.push(
        ...(await this.codeVerifierKeys(this.clientId, {
          includeChallengeKeys: true
        }))
      );
    }

    if (deleteKeys.length > 0) {
      await this.storage.delete(deleteKeys);
    }
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
