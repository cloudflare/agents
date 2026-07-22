/**
 * Deprecated transport wrappers
 */

import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type SSEClientTransportOptions,
  type StreamableHTTPClientTransportOptions
} from "@modelcontextprotocol/client";

let didWarnAboutSSEEdgeClientTransport = false;

/**
 * @deprecated Use SSEClientTransport from @modelcontextprotocol/client instead. This alias will be removed in the next major version.
 */
export class SSEEdgeClientTransport extends SSEClientTransport {
  constructor(url: URL, options: SSEClientTransportOptions) {
    super(url, options);
    if (!didWarnAboutSSEEdgeClientTransport) {
      didWarnAboutSSEEdgeClientTransport = true;
      console.warn(
        "SSEEdgeClientTransport is deprecated. Use SSEClientTransport from @modelcontextprotocol/client instead. SSEEdgeClientTransport will be removed in the next major version."
      );
    }
  }
}

let didWarnAboutStreamableHTTPEdgeClientTransport = false;

/**
 * @deprecated Use StreamableHTTPClientTransport from @modelcontextprotocol/client instead. This alias will be removed in the next major version.
 */
export class StreamableHTTPEdgeClientTransport extends StreamableHTTPClientTransport {
  constructor(url: URL, options: StreamableHTTPClientTransportOptions) {
    super(url, options);
    if (!didWarnAboutStreamableHTTPEdgeClientTransport) {
      didWarnAboutStreamableHTTPEdgeClientTransport = true;
      console.warn(
        "StreamableHTTPEdgeClientTransport is deprecated. Use StreamableHTTPClientTransport from @modelcontextprotocol/client instead. StreamableHTTPEdgeClientTransport will be removed in the next major version."
      );
    }
  }
}
