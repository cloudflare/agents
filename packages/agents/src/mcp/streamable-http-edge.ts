import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class StreamableHTTPEdgeClientTransport extends StreamableHTTPClientTransport {
  private authProvider: OAuthClientProvider | undefined;

  /**
   * Creates a new StreamableHTTPEdgeClientTransport, which overrides fetch to be compatible with the CF workers environment
   */
  constructor(url: URL, options: StreamableHTTPClientTransportOptions) {
    const fetchOverride: typeof fetch = async (
      fetchUrl: RequestInfo | URL,
      fetchInit: RequestInit = {}
    ) => {
      // add auth headers
      const headers = await this.authHeaders();
      const workerOptions = {
        ...fetchInit,
        headers: {
          ...options.requestInit?.headers,
          ...fetchInit?.headers,
          ...headers
        }
      };

      // Remove unsupported properties
      delete workerOptions.mode;

      // Call the original fetch with fixed options
      return (
        // @ts-expect-error Custom fetch function for Cloudflare Workers compatibility
        (options.requestInit?.fetch?.(
          fetchUrl as URL | string,
          workerOptions
        ) as Promise<Response>) || fetch(fetchUrl, workerOptions)
      );
    };

    super(url, {
      ...options,
      requestInit: {
        ...options.requestInit,
        // @ts-expect-error Custom fetch override for Cloudflare Workers
        fetch: fetchOverride
      }
    });
    this.authProvider = options.authProvider;
  }

  async authHeaders() {
    if (this.authProvider) {
      const tokens = await this.authProvider.tokens();
      if (tokens) {
        return {
          Authorization: `Bearer ${tokens.access_token}`
        };
      }
    }
  }
}
