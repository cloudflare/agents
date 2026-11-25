/**
 * `useEventLog` against a real event log on the test worker
 * (`EventLogObject`): the first subscription resyncs from the snapshot,
 * live events follow in seq order, and re-rendering with new handler
 * functions does not resubscribe.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import { useState } from "react";
import { useAgent } from "../react";
import { useEventLog } from "../internal/react";
import { getTestWorkerHost } from "./test-config";

const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

afterEach(() => {
  cleanup();
});

/** The part of the agent the test drives: untyped calls to `publish`. */
type Agent = {
  call<T = unknown>(method: string, args?: unknown[]): Promise<T>;
};

function Feed({
  name,
  onAgent,
  onResync
}: {
  name: string;
  onAgent: (agent: Agent) => void;
  onResync: () => void;
}) {
  const { host, protocol } = getTestWorkerHost();
  const agent = useAgent({
    agent: "EventLogObject",
    name,
    host,
    protocol
  });
  onAgent(agent);
  const [items, setItems] = useState<string[]>([]);
  const [at, setAt] = useState<number | null>(null);
  useEventLog<string, { at: number }>(agent, "feed", {
    onResync: (snapshot) => {
      onResync();
      setAt(snapshot?.at ?? null);
      setItems([]);
    },
    onEvent: (item) => setItems((prev) => [...prev, item])
  });
  return (
    <div>
      <span data-testid="at">{at === null ? "none" : String(at)}</span>
      <span data-testid="items">{items.join(",")}</span>
    </div>
  );
}

describe("useEventLog", () => {
  it("resyncs once, then applies live events in order", async () => {
    let agent: Agent | null = null;
    let resyncs = 0;
    const name = `event-log-${crypto.randomUUID()}`;
    const { container } = await render(
      <Feed
        name={name}
        onAgent={(a) => {
          agent = a;
        }}
        onResync={() => {
          resyncs += 1;
        }}
      />
    );
    const text = (id: string) =>
      container.querySelector(`[data-testid="${id}"]`)?.textContent;

    await vi.waitFor(() => expect(text("at")).toBe("0"), { timeout: 10000 });

    await agent!.call("publish", ["a"]);
    await agent!.call("publish", ["b"]);
    await vi.waitFor(() => expect(text("items")).toBe("a,b"));
    // Each event re-rendered Feed with new handlers; none resubscribed.
    expect(resyncs).toBe(1);
  });
});
