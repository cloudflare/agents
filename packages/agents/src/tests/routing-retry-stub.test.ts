/**
 * `getAgentByName` retries a retryable startup failure. A reset of the
 * object is the retryable case, and it leaves the stub that saw it broken:
 * every later call through that stub fails the same way, while a new stub
 * works (RUNTIME-FACTS: "A stub stays broken after its Durable Object is
 * reset"). So each attempt must use a new stub.
 */
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";

/** A namespace whose first stub is broken for good, like one that saw a reset. */
function namespaceWithBrokenFirstStub() {
  const opened: number[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => {
      const index = opened.length + 1;
      opened.push(index);
      return {
        index,
        async __unsafe_ensureInitialized() {
          if (index === 1) {
            const error = new Error(
              "Durable Object reset because its code was updated."
            );
            Object.assign(error, { retryable: true });
            throw error;
          }
        }
      };
    }
  };
  return { namespace, opened };
}

describe("getAgentByName retries", () => {
  it("retries a reset on a new stub and returns that stub", async () => {
    const { namespace, opened } = namespaceWithBrokenFirstStub();

    const stub = await getAgentByName(
      namespace as unknown as DurableObjectNamespace<never>,
      "agent",
      { routingRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } }
    );

    expect(opened).toEqual([1, 2]);
    expect((stub as unknown as { index: number }).index).toBe(2);
  });
});
