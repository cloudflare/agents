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
  codeChallenge: string | undefined;
}

export class DurableObjectOAuthClientProvider implements AgentsOAuthProvider {
  private _authUrl: string | undefined;
  private _serverId: string | undefined;
  private _clientId: string | undefined;
  private _codeChallenge: string | undefined;

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
    if (!this._clientId) {
      throw new Error("Trying to access clientId before it was set");
    }
    return this._clientId;
  }

  set clientId(clientId_: string) {
    this._clientId = clientId_;
  }

  get serverId() {
    if (!this._serverId) {
      throw new Error("Trying to access serverId before it was set");
    }
    return this._serverId;
  }

  set serverId(serverId_: string) {
    this._serverId = serverId_;
  }

  keyPrefix(clientId: string) {
    return `/${this.clientName}/${this.serverId}/${clientId}`;
  }

  clientInfoKey(clientId: string) {
    return `${this.keyPrefix(clientId)}/client_info/`;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (!this._clientId) {
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
    if (!this._clientId) {
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
    return this._authUrl;
  }

  /**
   * Because this operates on the server side (but we need browser auth), we send this url back to the user
   * and require user interact to initiate the redirect flow
   */
  async redirectToAuthorization(authUrl: URL): Promise<void> {
    // We want to track the client ID & code challenge in state here because the typescript SSE client sometimes does
    // a dynamic client registration AFTER generating this redirect URL. This prevents us from:
    // 1) using the wrong client information
    // 2) using the wrong PKCE code challenge
    const client_id = authUrl.searchParams.get("client_id");
    const code_challenge = authUrl.searchParams.get("code_challenge");
    if (client_id && code_challenge) {
      this.codeChallenge = code_challenge;
      authUrl.searchParams.append("state", `${client_id}:${code_challenge}`);
    }
    this._authUrl = authUrl.toString();
  }

  get codeChallenge() {
    if (!this._codeChallenge) {
      throw new Error("Trying to access codeChallenge before it was set");
    }
    return this._codeChallenge;
  }

  set codeChallenge(codeChallenge_: string) {
    this._codeChallenge = codeChallenge_;
  }

  codeVerifierKey(clientId: string, codeChallenge: string) {
    return `${this.keyPrefix(clientId)}/code_verifier/${codeChallenge}`;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.codeChallenge = await getCodeChallenge(verifier);
    await this.storage.put(
      this.codeVerifierKey(this.clientId, this.codeChallenge),
      verifier
    );
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = await this.storage.get<string>(
      this.codeVerifierKey(this.clientId, this.codeChallenge)
    );
    if (!codeVerifier) {
      throw new Error("No code verifier found");
    }
    return codeVerifier;
  }
}

// OAuth utilities
async function getCodeChallenge(codeVerifier: string) {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  const hash = new Uint8Array(buffer);
  let binary = "";
  const hashLength = hash.byteLength;
  for (let i = 0; i < hashLength; i++) {
    binary += String.fromCharCode(hash[i]);
  }
  const codeChallenge = base64urlEncode(binary);
  return codeChallenge;
}

function base64urlEncode(value: string): string {
  let base64 = btoa(value);
  base64 = base64.replace(/\+/g, "-");
  base64 = base64.replace(/\//g, "_");
  base64 = base64.replace(/=/g, "");
  return base64;
}
