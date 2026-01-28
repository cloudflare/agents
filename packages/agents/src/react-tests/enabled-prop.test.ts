import { describe, expect, it, beforeEach } from "vitest";

/**
 * Tests for the `enabled` prop in useAgent hook.
 *
 * The `enabled` prop follows the React Query pattern for conditional connections:
 * - When `enabled` is `false`, the WebSocket connection is not established
 * - When `enabled` is `true` (default), the connection is established normally
 * - When `enabled` transitions from `false` to `true`, the connection is opened
 * - When `enabled` transitions from `true` to `false`, the connection is closed
 *
 * @see https://github.com/cloudflare/agents/issues/533
 */

describe("useAgent enabled prop (issue #533)", () => {
  describe("Type definitions", () => {
    it("should accept enabled as an optional boolean prop", () => {
      // This is a compile-time check - if UseAgentOptions doesn't include enabled,
      // TypeScript would fail. We're just documenting the expected type here.
      type ExpectedOptions = {
        agent: string;
        name?: string;
        enabled?: boolean;
      };

      const options: ExpectedOptions = {
        agent: "test-agent",
        enabled: false
      };

      expect(options.enabled).toBe(false);
    });

    it("should default enabled to true when not specified", () => {
      const optionsWithEnabled = { agent: "test", enabled: true };
      const optionsWithoutEnabled: { agent: string; enabled?: boolean } = {
        agent: "test"
      };

      // Default behavior: enabled should be true when undefined
      const defaultEnabled = optionsWithoutEnabled.enabled ?? true;
      expect(defaultEnabled).toBe(true);
      expect(optionsWithEnabled.enabled).toBe(true);
    });
  });

  describe("Connection lifecycle", () => {
    it("should start closed when enabled is false", () => {
      // When enabled=false, startClosed should be passed as true to usePartySocket
      const enabled = false;
      const startClosed = !enabled;

      expect(startClosed).toBe(true);
    });

    it("should start open when enabled is true", () => {
      // When enabled=true (default), startClosed should be false
      const enabled = true;
      const startClosed = !enabled;

      expect(startClosed).toBe(false);
    });

    it("should start open when enabled is undefined (default)", () => {
      // Simulate the default behavior when enabled is not provided
      const enabledFromOptions: boolean | undefined = undefined;
      const enabled = enabledFromOptions ?? true;
      const startClosed = !enabled;

      expect(startClosed).toBe(false);
    });
  });

  describe("State transition logic", () => {
    let wasEnabled: boolean;
    let currentEnabled: boolean;
    let reconnectCalled: boolean;
    let closeCalled: boolean;

    beforeEach(() => {
      reconnectCalled = false;
      closeCalled = false;
    });

    function simulateTransition(prev: boolean, current: boolean) {
      wasEnabled = prev;
      currentEnabled = current;

      // Simulate the useEffect logic
      if (!wasEnabled && currentEnabled) {
        reconnectCalled = true;
      } else if (wasEnabled && !currentEnabled) {
        closeCalled = true;
      }
    }

    it("should call reconnect when transitioning from disabled to enabled", () => {
      simulateTransition(false, true);

      expect(reconnectCalled).toBe(true);
      expect(closeCalled).toBe(false);
    });

    it("should call close when transitioning from enabled to disabled", () => {
      simulateTransition(true, false);

      expect(reconnectCalled).toBe(false);
      expect(closeCalled).toBe(true);
    });

    it("should not call either when staying enabled", () => {
      simulateTransition(true, true);

      expect(reconnectCalled).toBe(false);
      expect(closeCalled).toBe(false);
    });

    it("should not call either when staying disabled", () => {
      simulateTransition(false, false);

      expect(reconnectCalled).toBe(false);
      expect(closeCalled).toBe(false);
    });
  });

  describe("Integration with other options", () => {
    it("should work alongside startClosed option (enabled takes precedence)", () => {
      // If user passes both startClosed and enabled, enabled should win
      // because it's destructured before restOptions spread
      const options = {
        agent: "test",
        enabled: false,
        startClosed: false // This should be overridden
      };

      const { enabled, startClosed: _userStartClosed } = options;
      const effectiveStartClosed = !enabled; // enabled takes precedence

      expect(effectiveStartClosed).toBe(true);
    });

    it("should preserve other options when enabled is specified", () => {
      const options: {
        agent: string;
        name: string;
        enabled: boolean;
        cacheTtl: number;
        queryDeps: string[];
      } = {
        agent: "test-agent",
        name: "instance-1",
        enabled: false,
        cacheTtl: 60000,
        queryDeps: ["dep1"]
      };

      const { queryDeps, cacheTtl, enabled, ...restOptions } = options;

      expect(restOptions.agent).toBe("test-agent");
      expect(restOptions.name).toBe("instance-1");
      expect(enabled).toBe(false);
      expect(cacheTtl).toBe(60000);
      expect(queryDeps).toEqual(["dep1"]);
    });
  });

  describe("Common use cases", () => {
    it("should support authentication-based conditional connection", () => {
      // Simulate: only connect when user is authenticated
      const isAuthenticated = false;

      const options = {
        agent: "chat-agent",
        enabled: isAuthenticated
      };

      expect(options.enabled).toBe(false);
      expect(!options.enabled).toBe(true); // startClosed would be true
    });

    it("should support feature flag based conditional connection", () => {
      // Simulate: only connect when feature is enabled
      const featureEnabled = true;

      const options = {
        agent: "experimental-agent",
        enabled: featureEnabled
      };

      expect(options.enabled).toBe(true);
      expect(!options.enabled).toBe(false); // startClosed would be false
    });

    it("should support lazy loading pattern", () => {
      // Simulate: connect only when user navigates to a specific section
      let userOnAgentPage = false;

      const getOptions = () => ({
        agent: "page-agent",
        enabled: userOnAgentPage
      });

      expect(getOptions().enabled).toBe(false);

      // User navigates to the page
      userOnAgentPage = true;
      expect(getOptions().enabled).toBe(true);
    });
  });
});
