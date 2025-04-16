import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// A slight extension to the standard OAuthClientProvider interface because `redirectToAuthorization` doesn't give us the interface we need
// This allows us to track authentication for a specific server and associated dynamic client registration
export interface AgentsOAuthProvider extends OAuthClientProvider {
  authUrl: string | undefined;
  clientId: string | undefined;
  serverId: string | undefined;
}

export class DurableObjectOAuthClientProvider implements AgentsOAuthProvider {
  private authUrl_: string | undefined;
  private serverId_: string | undefined;
  private clientId_: string | undefined;

  constructor(
    public storage: DurableObjectStorage,
    public clientName: string,
    public baseRedirectUrl: string
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.clientName,
      client_uri: "example.com",
    };
  }

  get redirectUrl() {
    return `${this.baseRedirectUrl}/${this.serverId}`;
  }

  get clientId() {
    if (!this.clientId_) {
      throw new Error("Trying to access clientId before it was set");
    }
    return this.clientId_;
  }

  set clientId(clientId_: string) {
    this.clientId_ = clientId_;
  }

  get serverId() {
    if (!this.serverId_) {
      throw new Error("Trying to access serverId before it was set");
    }
    return this.serverId_;
  }

  set serverId(serverId_: string) {
    this.serverId_ = serverId_;
  }

  keyPrefix(clientId: string) {
    return `/${this.clientName}/${this.serverId}/${clientId}`;
  }

  clientInfoKey(clientId: string) {
    return `${this.keyPrefix(clientId)}/client_info/`;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (!this.clientId_) {
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
    if (!this.clientId_) {
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
    return this.authUrl_;
  }

  /**
   * Because this operates on the server side (but we need browser auth), we send this url back to the user
   * and require user interact to initiate the redirect flow
   */
  async redirectToAuthorization(authUrl: URL): Promise<void> {
    // We want to track the client ID in state here because the typescript SSE client sometimes does
    // a dynamic client registration AFTER generating this redirect URL.
    const client_id = authUrl.searchParams.get("client_id");
    if (client_id) {
      authUrl.searchParams.append("state", client_id);
    }
    this.authUrl_ = authUrl.toString();
  }

  codeVerifierKey(clientId: string) {
    return `${this.keyPrefix(clientId)}/code_verifier`;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.storage.put(this.codeVerifierKey(this.clientId), verifier);
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
