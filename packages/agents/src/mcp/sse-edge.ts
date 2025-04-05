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
    // biome-ignore lint/suspicious/noExplicitAny: Overriding fetch, type doesn't matter here
    const fetchOverride = async (url: any, fetchOpts: any = {}) => {
      // add auth headers
      const headers = await this.authHeaders();
      const workerOptions = {
        ...fetchOpts,
        headers: {
          ...(fetchOpts.headers ?? {}),
          ...headers,
        },
      };

      // Remove unsupported properties
      // @ts-ignore
      // biome-ignore lint/performance/noDelete: workaround for workers environment
      delete workerOptions.mode;

      // Call the original fetch with fixed options
      return global.fetch(url, workerOptions);
    };

    super(url, {
      ...options,
      eventSourceInit: {
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
    return {};
  }
}
