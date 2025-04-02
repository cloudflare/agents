import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";

export class SSEEdgeClientTransport extends SSEClientTransport {
  /**
   * Creates a new EdgeSSEClientTransport, which overrides fetch to be compatible with the CF workers environment
   */
  constructor(
    private url: URL,
    options: SSEClientTransportOptions
  ) {
    // biome-ignore lint/suspicious/noExplicitAny: Overriding fetch, type doesn't matter here
    const fetchOverride = (url: any, options = {}) => {
      const workerOptions = {
        ...options,
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
  }
}
