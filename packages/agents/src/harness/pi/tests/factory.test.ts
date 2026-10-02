import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function fresh() {
  return env.PI_FACTORY_TEST.getByName(crypto.randomUUID());
}

describe("a harness factory on a Durable Object", () => {
  it("offers the model the tools and sections on the registry it opened pi with", async () => {
    const offered = await fresh().inspect();
    expect(offered.tools).toEqual([
      "activate_skill",
      "read_skill_resource",
      "shout",
      "sum"
    ]);
    expect(Object.keys(offered.sections).sort()).toEqual([
      "preamble",
      "skills"
    ]);
    // `tag: false` sends the text as written.
    expect(offered.sections.preamble).toBe("Be terse.");
  });

  it("serves skills through skills()", async () => {
    const stub = fresh();
    expect((await stub.inspect()).sections.skills).toContain(
      "haiku: Write haiku."
    );
    const activated = await stub.prompt('call activate_skill {"name":"haiku"}');
    expect(activated.text).toContain("Five, seven, five syllables.");
    const resource = await stub.prompt(
      'call read_skill_resource {"name":"haiku","path":"examples.md"}'
    );
    expect(resource.text).toContain("An old silent pond");
  });

  it("answers many sessions prompting and calling tools at once", async () => {
    const stub = fresh();
    const sessions = await Promise.all(
      Array.from({ length: 6 }, () => stub.createSession())
    );
    const results = await Promise.all(
      sessions.flatMap((session, s) =>
        Array.from({ length: 4 }, (_, n) =>
          stub.prompt(`call sum {"values":[${s},${n}]}`, session)
        )
      )
    );
    expect(results).toEqual(
      sessions.flatMap((_, s) =>
        Array.from({ length: 4 }, (_, n) => ({
          status: "done",
          text: `tool said: ${s + n}`
        }))
      )
    );
  });
});

describe("a harness factory that fails", () => {
  it("fails the harness's open with its error, and opens on the next try", async () => {
    const stub = env.PI_FLAKY_FACTORY_TEST.getByName(crypto.randomUUID());
    const first = await stub.open();
    const second = await stub.open();
    expect([first, second]).toEqual(["extension failed to load", "opened"]);
    expect(await stub.prompt('call shout {"text":"ok"}')).toEqual({
      status: "done",
      text: "tool said: OK"
    });
  });
});
