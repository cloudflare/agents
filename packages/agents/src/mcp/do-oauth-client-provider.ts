import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { nanoid } from "nanoid";

const STATE_EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes

interface StoredState {
  nonce: string;
  serverId: string;
  createdAt: number;
}

// A slight extension to the standard OAuthClientProvider interface because `redirectToAuthorization` doesn't give us the interface we need
// This allows us to track authentication for a specific server and associated dynamic client registration
export interface AgentsOAuthProvider extends OAuthClientProvider {
  authUrl: string | undefined;
  clientId: string | undefined;
  serverId: string | undefined;
  checkState(
    state: string
  ): Promise<{ valid: boolean; serverId?: string; error?: string }>;
  consumeState(state: string): Promise<void>;
  deleteCodeVerifier(): Promise<void>;
}

export class DurableObjectOAuthClientProvider implements AgentsOAuthProvider {
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
    const parts = state.split(".");
    if (parts.length !== 2) {
      return { valid: false, error: "Invalid state format" };
    }

    const [nonce, serverId] = parts;
    const key = this.stateKey(nonce);
    const storedState = await this.storage.get<StoredState>(key);

    if (!storedState) {
      return { valid: false, error: "State not found or already used" };
    }

    if (storedState.serverId !== serverId) {
      await this.storage.delete(key);
      return { valid: false, error: "State serverId mismatch" };
    }

    const age = Date.now() - storedState.createdAt;
    if (age > STATE_EXPIRATION_MS) {
      await this.storage.delete(key);
      return { valid: false, error: "State expired" };
    }

    return { valid: true, serverId };
  }

  async consumeState(state: string): Promise<void> {
    const parts = state.split(".");
    if (parts.length !== 2) {
      // This should never happen since checkState validates format first.
      // Log for debugging but don't throw - state consumption is best-effort.
      console.warn(
        `[OAuth] consumeState called with invalid state format: ${state.substring(0, 20)}...`
      );
      return;
    }
    const [nonce] = parts;
    await this.storage.delete(this.stateKey(nonce));
  }

  async redirectToAuthorization(authUrl: URL): Promise<void> {
    this._authUrl_ = authUrl.toString();
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
      deleteKeys.push(this.codeVerifierKey(this.clientId));
    }

    if (deleteKeys.length > 0) {
      await this.storage.delete(deleteKeys);
    }
  }

  codeVerifierKey(clientId: string) {
    return `${this.keyPrefix(clientId)}/code_verifier`;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    const key = this.codeVerifierKey(this.clientId);

    // Don't overwrite existing verifier to preserve first PKCE verifier
    const existing = await this.storage.get<string>(key);
    if (existing) {
      return;
    }

    await this.storage.put(key, verifier);
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = await this.storage.get<string>(
      this.codeVerifierKey(this.clientId)
    );
    if (!codeVerifier) {
      throw new Error("No code verifier found");
    }
    return codeVerifier;
  }

  async deleteCodeVerifier(): Promise<void> {
    await this.storage.delete(this.codeVerifierKey(this.clientId));
  }
}
