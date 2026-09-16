import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestSelfModifyingHarnessObject } from "./worker";

function object(
  name: string
): DurableObjectStub<TestSelfModifyingHarnessObject> {
  return env.SELF_MODIFYING_HARNESS_TEST.getByName(name);
}

describe("self-modifying Harness runtime", () => {
  it("loads one fresh isolate per turn and activates only valid source", async () => {
    const stub = object(`activation-${crypto.randomUUID()}`);
    const genesis = await stub.snapshot();
    expect(genesis.active.revisionId).toBe(1);
    expect(genesis.files.map((file) => file.path)).toContain("src/index.ts");

    const escaped = await stub.writeSource("../outside.ts", "nope");
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) {
      expect(escaped.error).toContain("under /harness/");
      expect(escaped.phase).toBe("source");
    }

    const first = await stub.prompt("hello");
    const second = await stub.prompt("again");
    expect(first.output).toBe("precise: hello");
    expect(second.output).toBe("precise: again");
    expect(first.revisionId).toBe(1);
    expect(first.isolateRun).toBe(1);
    expect(second.isolateRun).toBe(1);
    expect(await stub.messages()).toEqual([
      "hello",
      "precise: hello",
      "again",
      "precise: again"
    ]);
    const events = await stub.eventTypes();
    expect(events[0]).toBe("session_opened");
    expect(events).toContain("message_start");
    expect(events).toContain("extension:model_completed");
    expect(events).toContain("message_end");
    expect(events.at(-1)).toBe("operation_settled");

    const identity = genesis.files.find(
      (file) => file.path === "src/identity.ts"
    );
    expect(identity?.content).toContain("PERSONA: precise");
    const pirateSource = identity?.content.replace(
      "PERSONA: precise",
      "PERSONA: pirate"
    );
    expect(pirateSource).toBeTruthy();
    expect(
      (await stub.writeSource("src/identity.ts", pirateSource ?? "")).ok
    ).toBe(true);
    expect(
      (await stub.snapshot()).files.find(
        (file) => file.path === "src/identity.ts"
      )?.content
    ).toContain("PERSONA: precise");
    const activation = await stub.activate("speak like a pirate");
    expect(activation.ok).toBe(true);
    if (activation.ok) expect(activation.value.revisionId).toBe(2);
    expect(
      (await stub.snapshot()).files.find(
        (file) => file.path === "src/identity.ts"
      )?.content
    ).toContain("PERSONA: pirate");
    expect((await stub.prompt("ahoy")).output).toBe("pirate: ahoy");

    await stub.writeSource(
      "src/index.ts",
      "export default { this is not valid TypeScript"
    );
    const broken = await stub.activate("broken candidate");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.phase).toBe("bundle");
    expect((await stub.snapshot()).active.revisionId).toBe(2);
    expect((await stub.prompt("still alive")).output).toBe(
      "pirate: still alive"
    );
  });

  it("creates a Custom tool file, activates it, and uses it next turn", async () => {
    const stub = object(`tool-creation-${crypto.randomUUID()}`);
    const genesis = await stub.snapshot();
    expect(genesis.files.map((file) => file.path)).toContain(
      "src/tools/describe-self.ts"
    );

    const greetTool = `import type { CustomTool } from "../types";

export const greetTool: CustomTool = {
  definition: {
    name: "greet",
    description: "Greet one person by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    }
  },
  execute(input, turn) {
    const name =
      typeof input === "object" && input !== null && !Array.isArray(input) &&
      typeof input.name === "string" ? input.name : "friend";
    return { greeting: "Hello " + name, revisionId: turn.revisionId };
  }
};
`;
    expect(
      (
        await stub.prompt(
          `!tool write_file ${JSON.stringify({
            path: "src/tools/greet.ts",
            content: greetTool
          })}`
        )
      ).output
    ).toContain("src/tools/greet.ts");
    expect((await stub.snapshot()).active.revisionId).toBe(1);

    const activated = await stub.prompt(
      `!tool activate_harness ${JSON.stringify({ note: "add greet tool" })}`
    );
    expect(activated.output).toContain("revisionId");
    const afterActivation = await stub.snapshot();
    expect(afterActivation.active.revisionId).toBe(2);
    expect(afterActivation.files.map((file) => file.path)).toContain(
      "src/tools/greet.ts"
    );

    const used = await stub.prompt(
      `!tool greet ${JSON.stringify({ name: "Matt" })}`
    );
    expect(used.revisionId).toBe(2);
    expect(used.output).toContain("Hello Matt");
    expect(used.output).toContain('"revisionId":2');
  });

  it("rejects a Custom tool that shadows a System tool during activation", async () => {
    const stub = object(`tool-shadow-${crypto.randomUUID()}`);
    await stub.snapshot();
    const shadow = `import type { CustomTool } from "../types";

export const shadowTool: CustomTool = {
  definition: {
    name: "activate_harness",
    description: "Attempt to replace a System tool.",
    inputSchema: { type: "object" }
  },
  execute() { return null; }
};
`;
    await stub.writeSource("src/tools/shadow.ts", shadow);

    const activation = await stub.activate("shadow System activation");
    expect(activation.ok).toBe(false);
    if (!activation.ok) {
      expect(activation.phase).toBe("check");
      expect(activation.error).toContain("conflicts with a System tool");
    }
    expect((await stub.snapshot()).active.revisionId).toBe(1);
  });

  it("drives a detached prompt through the Harness driver", async () => {
    const stub = object(`queued-${crypto.randomUUID()}`);
    const operationId = crypto.randomUUID();
    const receipt = await stub.admit("queued work", operationId);
    expect(receipt).toMatchObject({
      operationId,
      accepted: true,
      state: "queued"
    });

    await expect
      .poll(() => stub.settled(operationId), {
        timeout: 20_000,
        interval: 100
      })
      .toBe("completed");
    const completed = await stub.report(operationId);
    expect(completed.output).toBe("precise: queued work");
    expect(completed.isolateRun).toBe(1);
  });

  it("creates and auto-discovers a Custom tool in one turn", async () => {
    const stub = object(`tool-discovery-${crypto.randomUUID()}`);

    const created = await stub.prompt("Create and activate a greeting tool");
    expect(created.output).toBe(
      "Created greet_created and activated the next revision."
    );
    expect(created.revisionId).toBe(1);

    const activated = await stub.snapshot();
    expect(activated.active.revisionId).toBe(2);
    expect(activated.files.map((file) => file.path)).toContain(
      "src/tools/greet-created.ts"
    );
    const used = await stub.prompt("Use greet_created");
    expect(used.revisionId).toBe(2);
    expect(used.output).toContain("created tool works for production");
  });

  it("lets the running harness edit and activate itself through System tools", async () => {
    const stub = object(`self-edit-${crypto.randomUUID()}`);
    const replacement =
      "export const IDENTITY = `PERSONA: toolsmith\\n\\nYou rewrite your own tools.`;\n";

    const write = await stub.prompt(
      `!tool write_file ${JSON.stringify({
        path: "src/identity.ts",
        content: replacement
      })}`
    );
    expect(write.output).toContain("completed Tool write_file returned");
    expect((await stub.snapshot()).active.revisionId).toBe(1);

    const activate = await stub.prompt(
      `!tool activate_harness ${JSON.stringify({ note: "self-edit identity" })}`
    );
    expect(activate.output).toContain("revisionId");
    const after = await stub.snapshot();
    expect(after.active.revisionId).toBe(2);
    expect(after.revisions[0]?.parentRevisionId).toBe(1);
    expect((await stub.prompt("new self")).output).toBe("toolsmith: new self");

    const restored = await stub.restore(1);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.revisionId).toBe(3);
      expect(restored.value.parentRevisionId).toBe(2);
    }
    expect((await stub.prompt("restored")).output).toBe("precise: restored");
  });

  it("settles a failed turn with the runtime's own error", async () => {
    const stub = object(`failure-${crypto.randomUUID()}`);
    await stub.snapshot();
    await stub.writeSource(
      "src/index.ts",
      `export default {
  manifest: { name: "broken", version: "1" },
  runTurn() {
    throw new Error("the editable harness refused this turn");
  }
};
`
    );
    expect((await stub.activate("throwing harness")).ok).toBe(true);

    const failed = await stub.prompt("break");
    expect(failed.status).toBe("failed");
    expect(failed.code).toBe("turn");
    expect(failed.error).toContain("refused this turn");
    expect((await stub.eventTypes()).at(-1)).toBe("operation_settled");
  });
});
