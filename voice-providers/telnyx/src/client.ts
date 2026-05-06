/**
 * Shared Telnyx client configuration.
 * All providers use this for authentication and connection setup.
 */

export interface TelnyxClientConfig {
  /** Telnyx API key (from portal or API key management) */
  apiKey: string;
  /** Optional: Override base URL for Telnyx API */
  baseUrl?: string;
}

export class TelnyxClient {
  readonly apiKey: string;
  readonly baseUrl: string;

  constructor(config: TelnyxClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.telnyx.com/v2";
  }
}
