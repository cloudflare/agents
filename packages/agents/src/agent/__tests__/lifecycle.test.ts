import { describe, expect, it } from "vitest";
import { AgentLifecycleRunner, type AgentLifecycle } from "../lifecycle";

describe("AgentLifecycleRunner", () => {
  it("runs startup hooks sequentially in component order", async () => {
    const calls: string[] = [];
    const components: AgentLifecycle[] = [
      {
        async onStart() {
          calls.push("first:start");
          await Promise.resolve();
          calls.push("first:end");
        }
      },
      {
        onStart() {
          calls.push("second");
        }
      }
    ];

    const runner = new AgentLifecycleRunner(() => components);
    await runner.onStart({ props: undefined });

    expect(calls).toEqual(["first:start", "first:end", "second"]);
  });

  it("returns the first component response and stops dispatching", async () => {
    const calls: string[] = [];
    const request = new Request("https://example.com/callback");
    const expected = new Response("handled");
    const components: AgentLifecycle[] = [
      {
        onRequest() {
          calls.push("miss");
          return undefined;
        }
      },
      {
        onRequest(context) {
          calls.push(context.request.url);
          return expected;
        }
      },
      {
        onRequest() {
          calls.push("too-late");
          return new Response("wrong");
        }
      }
    ];

    const runner = new AgentLifecycleRunner(() => components);

    expect(await runner.onRequest({ request })).toBe(expected);
    expect(calls).toEqual(["miss", request.url]);
  });

  it("merges turn tools left to right", async () => {
    const firstWeather = { source: "first" };
    const secondWeather = { source: "second" };
    const search = { source: "search" };
    const components: AgentLifecycle[] = [
      {
        onTurn() {
          return { tools: { weather: firstWeather } };
        }
      },
      {
        onTurn(context) {
          expect(context.readiness).toEqual({ timeout: 1000 });
          return { tools: { weather: secondWeather, search } };
        }
      }
    ];

    const runner = new AgentLifecycleRunner(() => components);
    const contribution = await runner.onTurn({
      readiness: { timeout: 1000 }
    });

    expect(contribution.tools).toEqual({ weather: secondWeather, search });
  });

  it("stops a lifecycle phase when a component fails", async () => {
    const calls: string[] = [];
    const expected = new Error("startup failed");
    const runner = new AgentLifecycleRunner(() => [
      {
        onStart() {
          calls.push("first");
          throw expected;
        }
      },
      {
        onStart() {
          calls.push("second");
        }
      }
    ]);

    await expect(runner.onStart({ props: undefined })).rejects.toBe(expected);
    expect(calls).toEqual(["first"]);
  });

  it("resolves replaced components when the lifecycle phase begins", async () => {
    const calls: string[] = [];
    let current: AgentLifecycle = {
      onStart() {
        calls.push("default");
      }
    };
    const runner = new AgentLifecycleRunner(() => [current]);

    current = {
      onStart() {
        calls.push("replacement");
      }
    };
    await runner.onStart({ props: undefined });

    expect(calls).toEqual(["replacement"]);
  });

  it("destroys components in reverse order", async () => {
    const calls: string[] = [];
    const components: AgentLifecycle[] = [
      {
        onDestroy() {
          calls.push("first");
        }
      },
      {
        onDestroy() {
          calls.push("second");
        }
      }
    ];

    const runner = new AgentLifecycleRunner(() => components);
    await runner.onDestroy({});

    expect(calls).toEqual(["second", "first"]);
  });

  it("destroys remaining components when one fails, then rethrows", async () => {
    const calls: string[] = [];
    const expected = new Error("destroy failed");
    const runner = new AgentLifecycleRunner(() => [
      {
        onDestroy() {
          calls.push("first");
        }
      },
      {
        onDestroy() {
          calls.push("second");
          throw expected;
        }
      }
    ]);

    await expect(runner.onDestroy({})).rejects.toBe(expected);
    expect(calls).toEqual(["second", "first"]);
  });

  it("aggregates multiple destroy failures", async () => {
    const first = new Error("first failed");
    const second = new Error("second failed");
    const runner = new AgentLifecycleRunner(() => [
      {
        onDestroy() {
          throw first;
        }
      },
      {
        onDestroy() {
          throw second;
        }
      }
    ]);

    const error = await runner.onDestroy({}).then(
      () => {
        throw new Error("expected onDestroy to reject");
      },
      (thrown) => thrown as AggregateError
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([second, first]);
  });
});
