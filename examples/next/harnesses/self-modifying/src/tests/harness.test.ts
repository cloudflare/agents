import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SelfModifyingHarnessSnapshot } from "../self-modifying-harness";
import type { HarnessRevision, HarnessTurn } from "../store";
import type { TestSelfModifyingHarnessObject } from "./worker";

function object(
  name: string
): DurableObjectStub<TestSelfModifyingHarnessObject> {
  return env.SELF_MODIFYING_HARNESS.get(
    env.SELF_MODIFYING_HARNESS.idFromName(name)
  );
}

async function call<T>(
  stub: DurableObjectStub<TestSelfModifyingHarnessObject>,
  path: string,
  init?: RequestInit
): Promise<{ response: Response; body: T }> {
  const response = await stub.fetch(
    new Request(`http://self-modifying.test${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers }
    })
  );
  return { response, body: (await response.json()) as T };
}

async function state(
  stub: DurableObjectStub<TestSelfModifyingHarnessObject>
): Promise<SelfModifyingHarnessSnapshot> {
  const result = await call<SelfModifyingHarnessSnapshot>(stub, "/state");
  expect(result.response.status).toBe(200);
  return result.body;
}

async function prompt(
  stub: DurableObjectStub<TestSelfModifyingHarnessObject>,
  text: string
): Promise<HarnessTurn> {
  const result = await call<HarnessTurn>(stub, "/turns", {
    method: "POST",
    body: JSON.stringify({ prompt: text, wait: true })
  });
  expect(result.response.status).toBe(200);
  return result.body;
}

describe("self-modifying Lifecycle harness", () => {
  it("loads one fresh isolate per turn and activates only valid source", async () => {
    const stub = object(`activation-${crypto.randomUUID()}`);
    const genesis = await state(stub);
    expect(genesis.active.revisionId).toBe(1);
    expect(genesis.files.map((file) => file.path)).toContain("src/index.ts");
    expect(genesis.activeFiles.map((file) => file.path)).toContain(
      "src/index.ts"
    );
    const escaped = await call<{ error: string }>(stub, "/source", {
      method: "PUT",
      body: JSON.stringify({ path: "../outside.ts", content: "nope" })
    });
    expect(escaped.response.status).toBe(400);
    expect(escaped.body.error).toContain("under /harness/");

    const first = await prompt(stub, "hello");
    const second = await prompt(stub, "again");
    expect(first.output).toBe("precise: hello");
    expect(second.output).toBe("precise: again");
    expect(first.isolateRun).toBe(1);
    expect(second.isolateRun).toBe(1);
    const stream = await stub.fetch(
      new Request(
        `http://self-modifying.test/streams/${encodeURIComponent(first.streamId)}`
      )
    );
    const events = await stream.text();
    expect(events).toContain('"type":"turn_started"');
    expect(events).toContain('"type":"turn_completed"');
    expect(events).toContain("event: done");

    const identity = genesis.files.find(
      (file) => file.path === "src/identity.ts"
    );
    expect(identity?.content).toContain("PERSONA: precise");
    const pirateSource = identity?.content?.replace(
      "PERSONA: precise",
      "PERSONA: pirate"
    );
    expect(pirateSource).toBeTruthy();
    await call(stub, "/source", {
      method: "PUT",
      body: JSON.stringify({ path: "src/identity.ts", content: pirateSource })
    });
    expect(
      (await state(stub)).activeFiles.find(
        (file) => file.path === "src/identity.ts"
      )?.content
    ).toContain("PERSONA: precise");
    const activation = await call<HarnessRevision>(stub, "/activate", {
      method: "POST",
      body: JSON.stringify({ note: "speak like a pirate" })
    });
    expect(activation.response.status).toBe(200);
    expect(activation.body.revisionId).toBe(2);
    expect(
      (await state(stub)).activeFiles.find(
        (file) => file.path === "src/identity.ts"
      )?.content
    ).toContain("PERSONA: pirate");
    expect((await prompt(stub, "ahoy")).output).toBe("pirate: ahoy");

    await call(stub, "/source", {
      method: "PUT",
      body: JSON.stringify({
        path: "src/index.ts",
        content: "export default { this is not valid TypeScript"
      })
    });
    const broken = await call<{ phase: string; error: string }>(
      stub,
      "/activate",
      {
        method: "POST",
        body: JSON.stringify({ note: "broken candidate" })
      }
    );
    expect(broken.response.status).toBe(422);
    expect(broken.body.phase).toBe("bundle");
    expect((await state(stub)).active.revisionId).toBe(2);
    expect((await prompt(stub, "still alive")).output).toBe(
      "pirate: still alive"
    );
  });

  it("creates a Custom tool file, activates it, and uses it next turn", async () => {
    const stub = object(`tool-creation-${crypto.randomUUID()}`);
    const genesis = await state(stub);
    expect(genesis.activeFiles.map((file) => file.path)).toContain(
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
        await prompt(
          stub,
          `!tool write_file ${JSON.stringify({
            path: "src/tools/greet.ts",
            content: greetTool
          })}`
        )
      ).output
    ).toContain("src/tools/greet.ts");
    expect((await state(stub)).active.revisionId).toBe(1);

    const activated = await prompt(
      stub,
      `!tool activate_harness ${JSON.stringify({ note: "add greet tool" })}`
    );
    expect(activated.output).toContain("revisionId");
    const afterActivation = await state(stub);
    expect(afterActivation.active.revisionId).toBe(2);
    expect(afterActivation.activeFiles.map((file) => file.path)).toContain(
      "src/tools/greet.ts"
    );

    const used = await prompt(
      stub,
      `!tool greet ${JSON.stringify({ name: "Matt" })}`
    );
    expect(used.revisionId).toBe(2);
    expect(used.output).toContain("Hello Matt");
    expect(used.output).toContain('"revisionId":2');
  });

  it("rejects a Custom tool that shadows a System tool during activation", async () => {
    const stub = object(`tool-shadow-${crypto.randomUUID()}`);
    await state(stub);
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
    await call(stub, "/source", {
      method: "PUT",
      body: JSON.stringify({
        path: "src/tools/shadow.ts",
        content: shadow
      })
    });

    const activation = await call<{ phase: string; error: string }>(
      stub,
      "/activate",
      {
        method: "POST",
        body: JSON.stringify({ note: "shadow System activation" })
      }
    );
    expect(activation.response.status).toBe(422);
    expect(activation.body.phase).toBe("check");
    expect(activation.body.error).toContain("conflicts with a System tool");
    expect((await state(stub)).active.revisionId).toBe(1);
  });

  it("drives a detached submission through the Tasks queue", async () => {
    const stub = object(`queued-${crypto.randomUUID()}`);
    const turnId = crypto.randomUUID();
    const submitted = await call<{
      turnId: string;
      accepted: boolean;
    }>(stub, "/turns", {
      method: "POST",
      body: JSON.stringify({
        prompt: "queued work",
        turnId,
        wait: false
      })
    });
    expect(submitted.response.status).toBe(202);
    expect(submitted.body).toMatchObject({ turnId, accepted: true });

    await expect
      .poll(
        async () => {
          const turn = await call<HarnessTurn>(stub, `/turns/${turnId}`);
          return turn.body.state;
        },
        { timeout: 10_000, interval: 100 }
      )
      .toBe("completed");
    const completed = await call<HarnessTurn>(stub, `/turns/${turnId}`);
    expect(completed.body.output).toBe("precise: queued work");
    expect(completed.body.isolateRun).toBe(1);
  });

  it("creates and auto-discovers a Custom tool in one turn", async () => {
    const stub = object(`tool-creation-${crypto.randomUUID()}`);

    const created = await prompt(stub, "Create and activate a greeting tool");
    expect(created.output).toBe(
      "Created greet_created and activated the next revision."
    );
    expect(created.revisionId).toBe(1);

    const activated = await state(stub);
    expect(activated.active.revisionId).toBe(2);
    expect(activated.files.map((file) => file.path)).toContain(
      "src/tools/greet-created.ts"
    );
    const used = await prompt(stub, "Use greet_created");
    expect(used.revisionId).toBe(2);
    expect(used.output).toContain("created tool works for production");
  });

  it("lets the running harness edit and activate itself through System tools", async () => {
    const stub = object(`self-edit-${crypto.randomUUID()}`);
    const replacement =
      "export const IDENTITY = `PERSONA: toolsmith\\n\\nYou rewrite your own tools.`;\n";

    const write = await prompt(
      stub,
      `!tool write_file ${JSON.stringify({
        path: "src/identity.ts",
        content: replacement
      })}`
    );
    expect(write.output).toContain("completed Tool write_file returned");
    expect((await state(stub)).active.revisionId).toBe(1);

    const activate = await prompt(
      stub,
      `!tool activate_harness ${JSON.stringify({ note: "self-edit identity" })}`
    );
    expect(activate.output).toContain("revisionId");
    const after = await state(stub);
    expect(after.active.revisionId).toBe(2);
    expect(after.revisions[0]?.parentRevisionId).toBe(1);
    expect((await prompt(stub, "new self")).output).toBe("toolsmith: new self");

    const restore = await call<HarnessRevision>(stub, "/restore", {
      method: "POST",
      body: JSON.stringify({ revisionId: 1 })
    });
    expect(restore.response.status).toBe(200);
    expect(restore.body.revisionId).toBe(3);
    expect(restore.body.parentRevisionId).toBe(2);
    expect((await prompt(stub, "restored")).output).toBe("precise: restored");
  });
});
