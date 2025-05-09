import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

export class SSEEdgeClientTransport extends SSEClientTransport {
  private authProvider: OAuthClientProvider | undefined;
  /**
   * Creates a new EdgeSSEClientTransport, which overrides fetch to be compatible with the CF workers environment
   */
  constructor(url: URL, options: SSEClientTransportOptions) {
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
          ...headers,
        },
      };

      // Remove unsupported properties
      // biome-ignore lint/performance/noDelete: workaround for workers environment
      delete workerOptions.mode;

      // Call the original fetch with fixed options
      return (
        (options.eventSourceInit?.fetch?.(
          fetchUrl as URL | string,
          // @ts-expect-error Expects FetchLikeInit from EventSource but is compatible with RequestInit
          workerOptions
        ) as Promise<Response>) || fetch(fetchUrl, workerOptions)
      );
    };

    super(url, {
      ...options,
      eventSourceInit: {
        ...options.eventSourceInit,
        fetch: fetchOverride,
      },
    });
    this.authProvider = options.authProvider;
  }

  async authHeaders() {
    if (this.authProvider) {
      const tokens = await this.authProvider.tokens();
      if (tokens) {
        return {
          Authorization: `Bearer ${tokens.access_token}`,
        };
      }
    }
  }
}
