import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { nanoid } from "nanoid";

// A slight extension to the standard OAuthClientProvider interface because `redirectToAuthorization` doesn't give us the interface we need
// This allows us to track authentication for a specific server and associated dynamic client registration
export interface AgentsOAuthProvider extends OAuthClientProvider {
  authUrl: string | undefined;
  clientId: string | undefined;
  serverId: string | undefined;
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
    return `${this.baseRedirectUrl}/${this.serverId}`;
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

  /**
   * Because this operates on the server side (but we need browser auth), we send this url back to the user
   * and require user interact to initiate the redirect flow
   */
  async redirectToAuthorization(authUrl: URL): Promise<void> {
    // Generate secure random token for state parameter
    const stateToken = nanoid();
    authUrl.searchParams.set("state", stateToken);
    this._authUrl_ = authUrl.toString();
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
}
