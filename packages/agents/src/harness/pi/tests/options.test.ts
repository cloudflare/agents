import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PiHarness } from "../index";

/**
 * `PiHarnessOptions` requires only `providers`. Without
 * `defaults`, a session has no model, so pi leaves its prompts unanswered
 * until one is set.
 */
describe("a harness without defaults", () => {
  function stub() {
    return env.PI_NO_DEFAULTS_TEST.get(
      env.PI_NO_DEFAULTS_TEST.idFromName(crypto.randomUUID())
    );
  }

  it("leaves a prompt unanswered while no model is set", async () => {
    const harness = stub();
    const response = await harness.prompt("hello");

    expect(response.status).toBe("unanswered");
    expect(response.reason).toBe("no_model");
    expect(await harness.alarmTime()).toBeNull();
  });

  it("answers once the session's model is set", async () => {
    const harness = stub();
    await harness.setFauxModel();
    const response = await harness.prompt("hello");

    expect(response.status).toBe("done");
    expect(response.text).toBe("echo: hello");
  });
});

describe("PiHarness options", () => {
  it("rejects retry set both as a default and in settings", () => {
    const retry = { enabled: true, maxRetries: 1, baseDelayMs: 10 };
    expect(
      () =>
        new PiHarness({
          providers: [],
          defaults: { retry },
          settings: { retry }
        })
    ).toThrow("not both");
  });
});
