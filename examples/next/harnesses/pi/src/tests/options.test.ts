import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * `PiHarnessOptions` has two forms: the declarative one, where the harness
 * calls `Harness.open` itself, and the `harness` factory, where the caller
 * does. The rest of the suite covers the declarative form; these cover the
 * factory, so neither path can regress unnoticed.
 *
 * The factory is handed the already-open store and the registry the harness
 * built from `tools`/`systemPrompt`/`skills`/`configure`, so a caller that
 * needs a `HarnessOptions` field the declarative form does not forward can
 * reach it without reimplementing the wake, the store, or the registry.
 */
describe("the harness factory option", () => {
  it("answers a prompt through a caller-supplied Harness", async () => {
    const stub = env.PI_FACTORY_TEST.get(
      env.PI_FACTORY_TEST.idFromName(crypto.randomUUID())
    );
    const response = await stub.prompt("hello");

    expect(response.status).toBe("done");
    expect(response.text).toBe("echo: hello");
  });

  it("runs a tool round, so the factory's registry is the one in force", async () => {
    const stub = env.PI_FACTORY_TEST.get(
      env.PI_FACTORY_TEST.idFromName(crypto.randomUUID())
    );
    // `multiply` is registered through the shared `tools`-equivalent path and
    // handed to the factory on the registry, not by the factory itself.
    const response = await stub.prompt("multiply 7");

    expect(response.status).toBe("done");
    expect(response.text).toBe("tool said: 21");
  });

  // Unlike the two above, this one would also pass if the factory were
  // ignored: it asserts the wake behaves the same either way, which is the
  // point. Kept as a guard that the factory does not take over the loop.
  it("parks its wake once pi is idle, as the declarative form does", async () => {
    const stub = env.PI_FACTORY_TEST.get(
      env.PI_FACTORY_TEST.idFromName(crypto.randomUUID())
    );
    await stub.prompt("hello");

    expect(await stub.alarmTime()).toBeNull();
  });
});
