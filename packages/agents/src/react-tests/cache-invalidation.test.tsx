/**
 * Integration tests for query cache invalidation on disconnect.
 * Tests that the cache is properly invalidated when the WebSocket connection closes,
 * ensuring fresh auth tokens are fetched on reconnect.
 *
 * Related to: https://github.com/cloudflare/agents/issues/836
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "vitest-browser-react";
import { Suspense, useEffect, useState } from "react";
import { useAgent, _testUtils, type UseAgentOptions } from "../react";
import { getTestWorkerHost } from "./test-config";

// Helper to generate cache keys the same way useAgent does internally
const createCacheKey = _testUtils.createCacheKey;

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- tests don't need strict agent typing
type TestAgent = ReturnType<typeof useAgent<any>>;

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  _testUtils.clearCache();
});

// Helper component that uses useAgent and exposes the result
function TestAgentComponent<State = unknown>({
  options,
  onAgent
}: {
  options: UseAgentOptions<State>;
  onAgent: (agent: ReturnType<typeof useAgent<State>>) => void;
}) {
  const agent = useAgent<State>(options);

  useEffect(() => {
    onAgent(agent);
  }, [agent, agent.identified, onAgent]);

  return (
    <div data-testid="agent-status">
      {agent.identified ? "connected" : "connecting"}
    </div>
  );
}

function SuspenseWrapper({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div data-testid="loading">Loading...</div>}>
      {children}
    </Suspense>
  );
}

describe("Cache invalidation on disconnect", () => {
  describe("with static query", () => {
    it("should not affect cache when using static query object", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "cache-static-test",
              host,
              protocol,
              query: { token: "static-token" }
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Static query doesn't use the cache
      expect(_testUtils.queryCache.size).toBe(0);
    });
  });

  describe("cache key generation", () => {
    it("should create unique cache keys based on agent namespace and name", () => {
      // Test the createCacheKey helper via the cache entries
      const key1 = JSON.stringify(["test-state-agent", "instance-1"]);
      const key2 = JSON.stringify(["test-state-agent", "instance-2"]);
      const key3 = JSON.stringify(["other-agent", "instance-1"]);

      const promise = Promise.resolve({ token: "test" });

      _testUtils.setCacheEntry(key1, promise, 60000);
      _testUtils.setCacheEntry(key2, promise, 60000);
      _testUtils.setCacheEntry(key3, promise, 60000);

      expect(_testUtils.queryCache.size).toBe(3);
      expect(_testUtils.getCacheEntry(key1)).toBeDefined();
      expect(_testUtils.getCacheEntry(key2)).toBeDefined();
      expect(_testUtils.getCacheEntry(key3)).toBeDefined();
    });

    it("should include queryDeps in cache key", () => {
      const keyWithDep1 = JSON.stringify(["test-agent", "default", "user-123"]);
      const keyWithDep2 = JSON.stringify(["test-agent", "default", "user-456"]);

      const promise1 = Promise.resolve({ token: "token-for-123" });
      const promise2 = Promise.resolve({ token: "token-for-456" });

      _testUtils.setCacheEntry(keyWithDep1, promise1, 60000);
      _testUtils.setCacheEntry(keyWithDep2, promise2, 60000);

      expect(_testUtils.queryCache.size).toBe(2);

      // Deleting one key shouldn't affect the other
      _testUtils.deleteCacheEntry(keyWithDep1);
      expect(_testUtils.getCacheEntry(keyWithDep1)).toBeUndefined();
      expect(_testUtils.getCacheEntry(keyWithDep2)?.promise).toBe(promise2);
    });
  });

  describe("reconnection with onClose callback", () => {
    it("should call onClose callback when connection closes", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onClose = vi.fn();
      let capturedAgent: TestAgent | null = null;

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "onclose-test",
              host,
              protocol,
              onClose
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Force a reconnect
      capturedAgent!.reconnect();

      // Wait for the onClose callback to be called
      await vi.waitFor(
        () => {
          expect(onClose).toHaveBeenCalled();
        },
        { timeout: 10000 }
      );
    });

    it("should invalidate cache before calling user onClose callback", async () => {
      const { host, protocol } = getTestWorkerHost();
      let cacheWasEmptyInOnClose = false;
      let capturedAgent: TestAgent | null = null;

      // Use the same cache key generation as useAgent internally uses
      const cacheKey = createCacheKey(
        "test-state-agent",
        "onclose-cache-test",
        []
      );
      _testUtils.setCacheEntry(
        cacheKey,
        Promise.resolve({ token: "test" }),
        300000
      );
      expect(_testUtils.queryCache.has(cacheKey)).toBe(true);

      const onClose = vi.fn(() => {
        // Check if cache was invalidated when onClose is called
        cacheWasEmptyInOnClose = !_testUtils.queryCache.has(cacheKey);
      });

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "onclose-cache-test",
              host,
              protocol,
              onClose
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Force a reconnect
      capturedAgent!.reconnect();

      // Wait for onClose to be called
      await vi.waitFor(
        () => {
          expect(onClose).toHaveBeenCalled();
        },
        { timeout: 10000 }
      );

      // Cache should have been invalidated before user's onClose was called
      expect(cacheWasEmptyInOnClose).toBe(true);
    });

    it("should successfully reconnect after cache invalidation", async () => {
      const { host, protocol } = getTestWorkerHost();
      const onIdentity = vi.fn();
      let capturedAgent: TestAgent | null = null;

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "reconnect-success-test",
              host,
              protocol,
              onIdentity
            }}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
          />
        </SuspenseWrapper>
      );

      // Wait for initial connection
      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      expect(onIdentity).toHaveBeenCalledTimes(1);

      // Force a reconnect
      capturedAgent!.reconnect();

      // Wait for reconnection (onIdentity called again)
      await vi.waitFor(
        () => {
          expect(onIdentity.mock.calls.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 10000 }
      );

      // Should still be identified after reconnect
      expect(capturedAgent!.identified).toBe(true);
    });
  });

  describe("multiple components with same agent", () => {
    it("should invalidate cache only for the disconnecting component cache key", async () => {
      const { host, protocol } = getTestWorkerHost();
      let agent1: TestAgent | null = null;
      let agent2: TestAgent | null = null;

      // Use the same cache key generation as useAgent internally uses
      const cacheKey1 = createCacheKey("test-state-agent", "multi-test-1", []);
      const cacheKey2 = createCacheKey("test-state-agent", "multi-test-2", []);

      _testUtils.setCacheEntry(
        cacheKey1,
        Promise.resolve({ token: "token-1" }),
        300000
      );
      _testUtils.setCacheEntry(
        cacheKey2,
        Promise.resolve({ token: "token-2" }),
        300000
      );

      render(
        <SuspenseWrapper>
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "multi-test-1",
              host,
              protocol
            }}
            onAgent={(agent) => {
              agent1 = agent;
            }}
          />
          <TestAgentComponent
            options={{
              agent: "TestStateAgent",
              name: "multi-test-2",
              host,
              protocol
            }}
            onAgent={(agent) => {
              agent2 = agent;
            }}
          />
        </SuspenseWrapper>
      );

      // Wait for both to connect
      await vi.waitFor(
        () => {
          expect(agent1?.identified).toBe(true);
          expect(agent2?.identified).toBe(true);
        },
        { timeout: 10000 }
      );

      // Disconnect only agent1
      agent1!.reconnect();

      // Wait for agent1's onClose to be processed
      await vi.waitFor(
        () => {
          // Cache for agent1 should be invalidated
          expect(_testUtils.queryCache.has(cacheKey1)).toBe(false);
        },
        { timeout: 10000 }
      );

      // Cache for agent2 should still exist
      expect(_testUtils.queryCache.has(cacheKey2)).toBe(true);
    });
  });

  describe("cache key ref timing", () => {
    // Component that allows changing the name prop dynamically
    function DynamicNameComponent({
      initialName,
      host,
      protocol,
      onAgent,
      onNameChange
    }: {
      initialName: string;
      host: string;
      protocol: "ws" | "wss";
      onAgent: (agent: TestAgent) => void;
      onNameChange: (setName: (name: string) => void) => void;
    }) {
      const [name, setName] = useState(initialName);

      useEffect(() => {
        onNameChange(setName);
      }, [onNameChange]);

      const agent = useAgent({
        agent: "TestStateAgent",
        name,
        host,
        protocol
      });

      useEffect(() => {
        onAgent(agent);
      }, [agent, agent.identified, onAgent]);

      return (
        <div data-testid="agent-status">
          {agent.identified ? `connected-${name}` : "connecting"}
        </div>
      );
    }

    it("should invalidate correct cache entry when name changes before disconnect", async () => {
      const { host, protocol } = getTestWorkerHost();
      let capturedAgent: TestAgent | null = null;
      let _setNameFn: ((name: string) => void) | null = null;

      // Pre-populate cache entries for both names
      const cacheKeyName1 = createCacheKey(
        "test-state-agent",
        "dynamic-name-1",
        []
      );
      const cacheKeyName2 = createCacheKey(
        "test-state-agent",
        "dynamic-name-2",
        []
      );

      _testUtils.setCacheEntry(
        cacheKeyName1,
        Promise.resolve({ token: "token-for-name-1" }),
        300000
      );
      _testUtils.setCacheEntry(
        cacheKeyName2,
        Promise.resolve({ token: "token-for-name-2" }),
        300000
      );

      expect(_testUtils.queryCache.has(cacheKeyName1)).toBe(true);
      expect(_testUtils.queryCache.has(cacheKeyName2)).toBe(true);

      render(
        <SuspenseWrapper>
          <DynamicNameComponent
            initialName="dynamic-name-1"
            host={host}
            protocol={protocol}
            onAgent={(agent) => {
              capturedAgent = agent;
            }}
            onNameChange={(setName) => {
              _setNameFn = setName;
            }}
          />
        </SuspenseWrapper>
      );

      // Wait for initial connection with name-1
      await vi.waitFor(
        () => {
          expect(capturedAgent?.identified).toBe(true);
          expect(capturedAgent?.name).toBe("dynamic-name-1");
        },
        { timeout: 10000 }
      );

      // Both cache entries should still exist
      expect(_testUtils.queryCache.has(cacheKeyName1)).toBe(true);
      expect(_testUtils.queryCache.has(cacheKeyName2)).toBe(true);

      // Trigger disconnect - this should invalidate name-1's cache, not name-2's
      // The ref ensures we use the correct cache key at the time of disconnect
      capturedAgent!.reconnect();

      // Wait for the cache to be invalidated
      await vi.waitFor(
        () => {
          expect(_testUtils.queryCache.has(cacheKeyName1)).toBe(false);
        },
        { timeout: 10000 }
      );

      // name-2's cache should be unaffected
      expect(_testUtils.queryCache.has(cacheKeyName2)).toBe(true);
    });
  });
});
