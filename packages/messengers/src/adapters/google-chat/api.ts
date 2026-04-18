/**
 * Minimal Google Chat REST API client.
 *
 * Uses service account credentials (client_email + private_key) to
 * obtain an OAuth2 access token via JWT bearer flow. All API calls
 * use the standard fetch API — no Node.js or gRPC dependencies.
 *
 * Inspired by @cloudflare/pages-plugin-google-chat's GoogleChatAPI
 * but rewritten for Workers without jsrsasign.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/chat.bot";

export interface GoogleChatCredentials {
  clientEmail: string;
  privateKey: string;
}

export class GoogleChatAPIClient {
  readonly #credentials: GoogleChatCredentials;
  #accessToken: string | null = null;
  #tokenExpiry = 0;

  constructor(credentials: GoogleChatCredentials) {
    this.#credentials = credentials;
  }

  async createMessage(
    spaceName: string,
    message: { text?: string; cardsV2?: unknown[] },
    options?: { threadKey?: string }
  ): Promise<GoogleChatMessageResponse> {
    const params = new URLSearchParams();
    if (options?.threadKey) {
      params.set("threadKey", options.threadKey);
      params.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    }

    const suffix = params.toString() ? `?${params}` : "";
    return this.request(`${CHAT_API_BASE}/${spaceName}/messages${suffix}`, {
      method: "POST",
      body: JSON.stringify(message)
    });
  }

  async updateMessage(
    messageName: string,
    message: { text?: string; cardsV2?: unknown[] },
    updateMask?: string
  ): Promise<GoogleChatMessageResponse> {
    const params = new URLSearchParams();
    if (updateMask) {
      params.set("updateMask", updateMask);
    }

    const suffix = params.toString() ? `?${params}` : "";
    return this.request(`${CHAT_API_BASE}/${messageName}${suffix}`, {
      method: "PUT",
      body: JSON.stringify(message)
    });
  }

  async deleteMessage(messageName: string): Promise<void> {
    await this.request(`${CHAT_API_BASE}/${messageName}`, {
      method: "DELETE"
    });
  }

  async getMessage(messageName: string): Promise<GoogleChatMessageResponse> {
    return this.request(`${CHAT_API_BASE}/${messageName}`);
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...((init?.headers as Record<string, string>) ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Chat API ${response.status}: ${body}`);
    }

    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  private async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.#accessToken && now < this.#tokenExpiry - 60) {
      return this.#accessToken;
    }

    const jwt = await this.createServiceAccountJWT(now);

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to obtain access token: ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.#accessToken = data.access_token;
    this.#tokenExpiry = now + data.expires_in;
    return data.access_token;
  }

  private async createServiceAccountJWT(now: number): Promise<string> {
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: this.#credentials.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const key = await importPKCS8Key(this.#credentials.privateKey);
    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      new TextEncoder().encode(signingInput)
    );

    const encodedSignature = bufferToBase64Url(signature);
    return `${signingInput}.${encodedSignature}`;
  }
}

export interface GoogleChatMessageResponse {
  name?: string;
  text?: string;
  sender?: { name?: string; displayName?: string };
  createTime?: string;
  thread?: { name?: string };
}

async function importPKCS8Key(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
