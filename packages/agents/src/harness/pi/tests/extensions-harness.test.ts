import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function fresh() {
  return env.PI_EXTENSIONS_TEST.getByName(crypto.randomUUID());
}

describe("pi extensions on a Durable Object", () => {
  it("offers the model every extension's tools, minus the ones policy removed", async () => {
    const offered = await fresh().inspect();
    expect(offered.tools).toEqual([
      "activate_skill",
      "read_skill_resource",
      "shout",
      "sum"
    ]);
  });

  it("offers the model every extension's prompt sections", async () => {
    const offered = await fresh().inspect();
    expect(Object.keys(offered.sections).sort()).toEqual([
      "preamble",
      "skills",
      "where"
    ]);
    // `tag: false` sends the text as written; the default wraps it.
    expect(offered.sections.preamble).toBe("Be terse.");
    expect(offered.sections.skills).toContain("haiku: Write haiku.");
  });

  it("renders a section from its request, per conversation", async () => {
    const stub = fresh();
    expect((await stub.inspect()).sections.where).toContain("conversation 1");
    const other = await stub.createSession();
    expect((await stub.inspect(other)).sections.where).toContain(
      `conversation ${other}`
    );
  });

  it("calls a tool with arguments typed and validated by its schema", async () => {
    const stub = fresh();
    expect(await stub.prompt('call sum {"values":[1,2,3]}')).toEqual({
      status: "done",
      text: "tool said: 6"
    });
    const invalid = await stub.prompt('call sum {"values":"nope"}');
    expect(invalid.text).toMatch(/^tool failed: /);
  });

  it("runs a later extension's rewrite of an earlier extension's tool", async () => {
    expect(await fresh().prompt('call shout {"text":"hi"}')).toEqual({
      status: "done",
      text: "tool said: audited HI"
    });
  });

  it("fails a call to a tool a later extension removed", async () => {
    const result = await fresh().prompt('call exec {"text":"x"}');
    expect(result.text).toMatch(/^tool failed: /);
    expect(result.text).not.toContain("exec ran");
  });

  it("serves skills through the skills extension", async () => {
    const stub = fresh();
    const activated = await stub.prompt('call activate_skill {"name":"haiku"}');
    expect(activated.text).toContain("Five, seven, five syllables.");
    const resource = await stub.prompt(
      'call read_skill_resource {"name":"haiku","path":"examples.md"}'
    );
    expect(resource.text).toContain("An old silent pond");
  });

  it("installs one pi extension per extension that contributed, under its name", async () => {
    const stub = fresh();
    await stub.prompt("hello");
    expect(await stub.installed()).toEqual([
      // `exec` was removed by policy; `shout` stays base's after audit
      // rewrote it, so audit, policy and quiet install nothing.
      { name: "base", tools: ["shout"], sections: ["preamble"] },
      { name: "where", tools: [], sections: ["where"] },
      { name: "math", tools: ["sum"], sections: [] },
      {
        name: "skills",
        tools: ["activate_skill", "read_skill_resource"],
        sections: ["skills"]
      }
    ]);
  });

  it("lets one session stop offering an extension through pi's selection", async () => {
    const stub = fresh();
    const session = await stub.createSession();
    await stub.deselect(session, "skills");

    const narrowed = await stub.inspect(session);
    expect(narrowed.tools).toEqual(["shout", "sum"]);
    expect(Object.keys(narrowed.sections)).not.toContain("skills");
    // The root session still has it.
    expect((await stub.inspect()).tools).toContain("activate_skill");
  });

  it("runs extensions once per isolate, even when pi reopens", async () => {
    const stub = fresh();
    await stub.prompt("one");
    await stub.reopen();
    await stub.prompt("two");
    expect((await stub.extensionRuns()).base).toBe(1);
  });

  it("runs extensions again in a new isolate, with the same result", async () => {
    const stub = fresh();
    const before = await stub.inspect();
    await evictDurableObject(stub);
    expect(await stub.inspect()).toEqual(before);
    expect((await stub.extensionRuns()).base).toBe(1);
    expect(await stub.prompt('call sum {"values":[2,2]}')).toEqual({
      status: "done",
      text: "tool said: 4"
    });
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

describe("a pi extension that fails to load", () => {
  it("fails the harness's open with its error, and loads on the next open", async () => {
    const stub = env.PI_FLAKY_EXTENSION_TEST.getByName(crypto.randomUUID());
    const first = await stub.open();
    const second = await stub.open();
    expect([first, second]).toEqual(["extension failed to load", "opened"]);
    expect(await stub.tools()).toEqual(["shout"]);
    expect(await stub.prompt('call shout {"text":"ok"}')).toEqual({
      status: "done",
      text: "tool said: OK"
    });
  });
});
