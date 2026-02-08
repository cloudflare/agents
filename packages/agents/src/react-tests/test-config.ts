/**
 * Test configuration for React/Client integration tests.
 * The __TEST_WORKER_URL__ is defined by vitest.config.ts via the `define` option.
 */

declare const __TEST_WORKER_URL__: string;

export function getTestWorkerUrl(): string {
  return __TEST_WORKER_URL__;
}

/**
 * Get PartySocket connection options for the test worker.
 * PartySocket expects host to include the port, and protocol must be specified
 * explicitly for non-HTTPS connections.
 */
export function getTestWorkerHost(): {
  host: string;
  protocol: "ws" | "wss";
} {
  const url = new URL(getTestWorkerUrl());
  return {
    // PartySocket expects host:port format
    host: `${url.hostname}:${url.port}`,
    // Use ws:// for local development (not wss://)
    protocol: "ws"
  };
}
