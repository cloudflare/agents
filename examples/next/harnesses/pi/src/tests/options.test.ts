import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * `PiHarnessOptions` requires only the `harness` factory. Without
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
