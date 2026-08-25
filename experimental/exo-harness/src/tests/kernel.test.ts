/**
 * Kernel loop tests — run inside the Workers runtime with the deterministic
 * mock model (MODEL_OVERRIDE=mock, see src/tests/wrangler.jsonc), a real
 * Workspace, real git commits, and real dynamic Worker isolates for harness
 * tools. Each test uses its own agent name (own DO + own workspace).
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { artifactsSessionId } from "../kernel/harness";
import type {
  ContextSnapshot,
  ExoState,
  JournalEntry,
  Json,
  VersionInfo
} from "../kernel/types";

/**
 * Explicit RPC stub surface. The recursive `Json` type in the real method
 * signatures exceeds TS's instantiation depth inside the DurableObjectStub
 * serializability mapping, so we assert the (runtime-identical) shape here.
 */
interface KernelStub {
  boot(): Promise<ExoState>;
  prompt(
    text: string
  ): Promise<{ text: string; toolCalls: { toolName: string; input: Json }[] }>;
  getFileContent(path: string): Promise<string | null>;
  getVersions(): Promise<VersionInfo[]>;
  getJournal(beforeId?: number, limit?: number): Promise<JournalEntry[]>;
  getContextSnapshot(): Promise<ContextSnapshot | null>;
  cancelTaskById(id: string): Promise<boolean>;
  resetAgent(): Promise<void>;
  runScheduledTask(
    payload: { instruction: string },
    schedule?: { id: string }
  ): Promise<void>;
}

async function freshAgent(name: string): Promise<KernelStub> {
  const agent = (await getAgentByName(
    env.ExoKernel,
    name
  )) as unknown as KernelStub;
  await agent.boot();
  return agent;
}

function kinds(entries: JournalEntry[]): string[] {
  return entries.map((e) => e.kind);
}

describe("genesis", () => {
  it("seeds the harness, commits v1, and journals it", async () => {
    const agent = await freshAgent("genesis");

    const versions = await agent.getVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].note).toBe("genesis");
    expect(versions[0].sha).toMatch(/^[0-9a-f]{40}$/);

    const identity = await agent.getFileContent("/harness/identity.md");
    expect(identity).toContain("PERSONA:");
    expect(await agent.getFileContent("/harness/policy.json")).toContain(
      '"model": "openai/gpt-5.6-terra"'
    );

    const journal = await agent.getJournal();
    expect(kinds(journal)).toContain("genesis");

    // Genesis is idempotent.
    await agent.boot();
    expect(await agent.getVersions()).toHaveLength(1);
  });
});

describe("turn loop with live harness", () => {
  it("lets an evolvable runtime orchestrate inference, output, messages, and tasks", async () => {
    const stub = await getAgentByName(env.ExoKernel, "turn-runtime");
    const agent = stub as unknown as KernelStub;
    await agent.boot();
    const runtime = `export default {
  async beforeTurn(_event, host) {
    const identity = await host.executeTool("read_file", {
      path: "/harness/identity.md"
    });
    const side = await host.infer({
      prompt: "side-agent observation: " + identity.content.slice(0, 40)
    });
    await host.journal("side-agent: " + side.text);
    return {
      appendMessages: [
        { role: "user", content: "runtime context: " + side.text }
      ]
    };
  },
  transformOutput(event) {
    return { text: "[runtime] " + event.text };
  },
  async afterTurn(_event, host) {
    await host.readMessages();
    await host.appendMessages([
      {
        id: "runtime-stored-message",
        role: "assistant",
        parts: [{ type: "text", text: "stored by runtime" }]
      }
    ]);
    await host.scheduleTask({
      instruction: "runtime scheduled task",
      delaySeconds: 3600
    });
  }
};
`;

    await agent.prompt(
      `!tools ${JSON.stringify([
        {
          name: "write_file",
          input: { path: "/harness/runtime.js", content: runtime }
        },
        {
          name: "activate_harness",
          input: { note: "add evolvable turn runtime" }
        }
      ])}`
    );

    const reply = await agent.prompt("main turn");
    expect(reply.text).toContain("[runtime]");
    expect(reply.text).toContain("runtime context:");

    const journal = await agent.getJournal();
    expect(
      journal.find(
        (entry) => entry.kind === "note" && entry.data.source === "runtime"
      )?.data.text
    ).toContain("side-agent:");
    expect(
      journal.filter(
        (entry) =>
          entry.kind === "model_invocation" && entry.data.source === "runtime"
      )
    ).toHaveLength(1);
    expect(journal).toContainEqual(
      expect.objectContaining({
        kind: "tool_call",
        data: expect.objectContaining({ tool: "read_file" })
      })
    );

    const storedMessages = await runInDurableObject(
      stub,
      async (instance) => instance.messages
    );
    expect(storedMessages).toContainEqual(
      expect.objectContaining({ id: "runtime-stored-message" })
    );
    expect((await agent.boot()).tasks).toContainEqual(
      expect.objectContaining({ instruction: "runtime scheduled task" })
    );
  });

  it("lets the evolvable runtime replace tool execution and results", async () => {
    const agent = await freshAgent("turn-runtime-tools");
    const runtime = `export default {
  beforeToolCall(event) {
    if (event.tool !== "read_file") return;
    return {
      action: "substitute",
      output: { path: event.input.path, content: "substituted" }
    };
  },
  afterToolCall(event) {
    if (event.tool !== "read_file") return;
    return {
      output: { ...event.output, content: event.output.content + " after" }
    };
  }
};
`;
    await agent.prompt(
      `!tools ${JSON.stringify([
        {
          name: "write_file",
          input: { path: "/harness/runtime.js", content: runtime }
        },
        {
          name: "activate_harness",
          input: { note: "control tool execution" }
        }
      ])}`
    );

    const reply = await agent.prompt(
      '!tool read_file {"path":"/harness/identity.md"}'
    );
    expect(reply.text).toContain("substituted after");
  });

  it("applies runtime changes between tool steps and before streaming output", async () => {
    const stub = await getAgentByName(env.ExoKernel, "turn-runtime-stream");
    const agent = stub as unknown as KernelStub;
    await agent.boot();
    const runtime = `export default {
  beforeStep(event) {
    if (event.stepNumber !== 1) return;
    return {
      appendMessages: [
        { role: "user", content: "runtime step override" }
      ]
    };
  },
  transformOutput({ text }) {
    return { text: "[streamed] " + text };
  }
};
`;
    await agent.prompt(
      `!tools ${JSON.stringify([
        {
          name: "write_file",
          input: { path: "/harness/runtime.js", content: runtime }
        },
        {
          name: "activate_harness",
          input: { note: "control steps and streams" }
        }
      ])}`
    );

    const toolReply = await agent.prompt(
      '!tool read_file {"path":"/harness/identity.md"}'
    );
    expect(toolReply.text).toContain("[streamed]");
    expect(toolReply.text).toContain("runtime step override");

    const streamBody = await runInDurableObject(stub, async (instance) => {
      await instance.persistMessages([
        {
          id: "runtime-stream-user",
          role: "user",
          parts: [{ type: "text", text: "stream this" }]
        }
      ]);
      return (await instance.onChatMessage(undefined)).text();
    });
    expect(streamBody).toContain("[streamed]");
  });

  it("bounds side inference fan-out without bricking the turn", async () => {
    const agent = await freshAgent("turn-runtime-inference-bound");
    const runtime = `export default {
  async beforeTurn(_event, host) {
    for (let index = 0; index < 5; index++) {
      await host.infer({ prompt: "side " + index });
    }
  }
};
`;
    await agent.prompt(
      `!tools ${JSON.stringify([
        {
          name: "write_file",
          input: { path: "/harness/runtime.js", content: runtime }
        },
        {
          name: "activate_harness",
          input: { note: "attempt excessive inference fan-out" }
        }
      ])}`
    );

    expect((await agent.prompt("main survives")).text).toContain(
      "main survives"
    );
    const journal = await agent.getJournal();
    expect(
      journal.filter(
        (entry) =>
          entry.kind === "model_invocation" && entry.data.source === "runtime"
      )
    ).toHaveLength(4);
    expect(journal).toContainEqual(
      expect.objectContaining({
        kind: "error",
        data: expect.objectContaining({
          source: "runtime",
          hook: "beforeTurn"
        })
      })
    );
  });

  it("ignores an invalid runtime patch without bricking the turn", async () => {
    const agent = await freshAgent("turn-runtime-invalid-patch");
    const runtime = `export default {
  beforeTurn() {
    return {
      appendMessages: [{ role: "invalid", content: "break the turn" }]
    };
  }
};
`;
    await agent.prompt(
      `!tools ${JSON.stringify([
        {
          name: "write_file",
          input: { path: "/harness/runtime.js", content: runtime }
        },
        {
          name: "activate_harness",
          input: { note: "invalid runtime patch" }
        }
      ])}`
    );

    expect((await agent.prompt("still alive")).text).toContain("still alive");
    expect(await agent.getJournal()).toContainEqual(
      expect.objectContaining({
        kind: "error",
        data: expect.objectContaining({
          source: "runtime",
          hook: "beforeTurn"
        })
      })
    );
  });

  it("replies through the persona in the live identity file", async () => {
    const agent = await freshAgent("turn-basic");
    const reply = await agent.prompt("hello there");
    expect(reply.text).toContain("[precise, helpful, curious.]");
    expect(reply.text).toContain('You said: "hello there"');

    const journal = await agent.getJournal();
    const k = kinds(journal);
    expect(k).toContain("turn_start");
    expect(k).toContain("turn_end");
  });

  it("runs a seed harness tool inside an isolate with state + journal caps", async () => {
    const agent = await freshAgent("turn-harness-tool");
    const reply = await agent.prompt(
      '!tool echo {"message": "self", "uppercase": true}'
    );
    expect(reply.toolCalls).toEqual([
      { toolName: "echo", input: { message: "self", uppercase: true } }
    ]);
    expect(reply.text).toContain("SELF");

    // The tool's journal capability wrote a durable note from the isolate.
    const journal = await agent.getJournal();
    const note = journal.find(
      (e) => e.kind === "note" && e.data.source === "tool"
    );
    expect(note?.data.text).toBe("echo tool ran: SELF");

    // And its call/result were journaled by the kernel wrapper.
    expect(kinds(journal)).toContain("tool_call");
    expect(kinds(journal)).toContain("tool_result");
  });
});

describe("model invocation circuit breaker", () => {
  it("reserves one diagnostic journal event before every model step", async () => {
    const agent = await freshAgent("invocations-multi-step");

    await agent.prompt(
      `!tools ${JSON.stringify([
        { name: "journal_note", input: { text: "first" } },
        { name: "journal_note", input: { text: "second" } }
      ])}`
    );

    const invocations = (await agent.getJournal()).filter(
      (entry) => entry.kind === "model_invocation"
    );
    expect(invocations.map((entry) => entry.data)).toEqual([
      { source: "prompt", stepNumber: 0 },
      { source: "prompt", stepNumber: 1 },
      { source: "prompt", stepNumber: 2 }
    ]);
  });

  it("counts a model request that fails after reservation", async () => {
    const stub = await getAgentByName(
      env.ExoKernel,
      "invocations-failed-request"
    );
    const agent = stub as unknown as KernelStub;
    await agent.boot();

    const failure = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.prompt("!model-error");
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(failure).toContain("mock model request failed");

    const invocations = (await agent.getJournal()).filter(
      (entry) => entry.kind === "model_invocation"
    );
    expect(invocations.map((entry) => entry.data)).toEqual([
      { source: "prompt", stepNumber: 0 }
    ]);
  });

  it("shares accounting across chat, prompt, and scheduled turns", async () => {
    const stub = await getAgentByName(
      env.ExoKernel,
      "invocations-all-turn-sources"
    );
    const agent = stub as unknown as KernelStub;
    await agent.boot();

    await agent.prompt("prompt turn");
    await agent.prompt(
      '!tool schedule_task {"instruction": "scheduled turn", "delaySeconds": 3600}'
    );
    const [task] = (await agent.boot()).tasks;
    await agent.runScheduledTask(
      { instruction: "scheduled turn" },
      { id: task.id }
    );
    const chatBody = await runInDurableObject(stub, async (instance) => {
      instance.messages = [
        {
          id: "chat-turn",
          role: "user",
          parts: [{ type: "text", text: "chat turn" }]
        }
      ];
      const response = await instance.onChatMessage(undefined);
      return response.text();
    });
    expect(chatBody).toContain("You said");

    const sources = (await agent.getJournal())
      .filter((entry) => entry.kind === "model_invocation")
      .map((entry) => entry.data.source);
    expect(new Set(sources)).toEqual(new Set(["chat", "prompt", "task"]));
  });

  it("rejects invocation 10,001 before calling the model", async () => {
    const stub = await getAgentByName(
      env.ExoKernel,
      "invocations-daily-ceiling"
    );
    const agent = stub as unknown as KernelStub;
    await agent.boot();
    await runInDurableObject(stub, (instance) => {
      for (let i = 0; i < 10_000; i++) {
        instance.store().appendJournal("model_invocation", {
          source: "prompt",
          stepNumber: 0
        });
      }
    });

    const failure = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.prompt("the model must not see this");
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(failure).toContain(
      "Model invocation limit reached (10,000 in rolling 24 hours)"
    );

    const journal = await agent.getJournal();
    const turnStart = journal
      .map((entry) => entry.kind)
      .lastIndexOf("turn_start");
    expect(journal.slice(turnStart + 1).map((entry) => entry.kind)).toEqual([
      "error"
    ]);

    await runInDurableObject(stub, (instance) => {
      const expiredTs = Date.now() - 24 * 60 * 60 * 1000 - 1;
      instance.sql`
        UPDATE exo_journal SET ts = ${expiredTs}
        WHERE kind = 'model_invocation'
      `;
    });
    const afterWindow = await agent.prompt("the rolling window has passed");
    expect(afterWindow.text).toContain("the rolling window has passed");
  });
});

describe("exec (worker-shell backend)", () => {
  it("runs shell commands against the agent's own filesystem", async () => {
    const agent = await freshAgent("exec-shell");
    const reply = await agent.prompt(
      '!tool exec {"command": "grep -c PERSONA /harness/identity.md && echo shell-ok"}'
    );
    expect(reply.toolCalls[0].toolName).toBe("exec");
    expect(reply.text).toContain("shell-ok");
    expect(reply.text).toContain('"exitCode":0');

    // The shell writes through to the same durable filesystem.
    await agent.prompt(
      '!tool exec {"command": "echo from-the-shell > /scratch/shell.txt"}'
    );
    expect(await agent.getFileContent("/scratch/shell.txt")).toContain(
      "from-the-shell"
    );

    // git runs host-side against the workspace repo.
    const log = await agent.prompt('!tool exec {"command": "git log"}');
    expect(log.text).toContain("genesis: seed harness v1");
  });
});

describe("self-modification (demo 1: rewrite own identity)", () => {
  it("edit identity.md → activate → next turn speaks with the new persona", async () => {
    const agent = await freshAgent("self-modify");

    const before = await agent.prompt("who are you?");
    expect(before.text).toContain("[precise, helpful, curious.]");

    const edit = await agent.prompt(
      '!tool write_file {"path": "/harness/identity.md", "content": "# Identity\\n\\nPERSONA: laconic pirate.\\n\\nSpeak briefly, like a pirate.\\n"}'
    );
    expect(edit.toolCalls[0].toolName).toBe("write_file");

    const activated = await agent.prompt(
      '!tool activate_harness {"note": "pirate personality"}'
    );
    expect(activated.text).toContain('"version":2');

    const versions = await agent.getVersions();
    expect(versions).toHaveLength(2);
    expect(versions[1].note).toBe("pirate personality");
    expect(versions[1].sha).not.toBe(versions[0].sha);

    // Hot reload: the very next turn assembles its prompt from the new file.
    const after = await agent.prompt("who are you now?");
    expect(after.text).toContain("[laconic pirate.]");

    const journal = await agent.getJournal();
    const upgrade = journal.find((e) => e.kind === "harness_upgrade");
    expect(upgrade?.data.version).toBe(2);
    expect(upgrade?.data.note).toBe("pirate personality");
  });
});

describe("self-extension (demo 2: agent creates a new tool)", () => {
  it("writes a new tool module, activates, and can call it next turn", async () => {
    const agent = await freshAgent("self-extend");

    const dice = `import fs from "node:fs/promises";
export default {
  name: "dice",
  description: "Roll dice and record the result in scratch space.",
  inputSchema: {
    type: "object",
    properties: { sides: { type: "number" } },
    required: ["sides"]
  },
  async run(input) {
    const roll = (input.sides % 7) + 1; // deterministic for the test
    await fs.writeFile("/scratch/last-roll.txt", String(roll));
    return { roll };
  }
};
`;
    await agent.prompt(
      `!tool write_file ${JSON.stringify({
        path: "/harness/tools/dice.js",
        content: dice
      })}`
    );
    await agent.prompt('!tool activate_harness {"note": "add dice tool"}');

    const rolled = await agent.prompt('!tool dice {"sides": 6}');
    expect(rolled.toolCalls[0].toolName).toBe("dice");
    expect(rolled.text).toContain('"roll":7');

    // The isolate's state capability wrote through to the durable workspace.
    expect(await agent.getFileContent("/scratch/last-roll.txt")).toBe("7");
  });

  it("a tool created mid-turn is callable in the SAME turn via run_harness_tool", async () => {
    const agent = await freshAgent("self-extend-same-turn");
    const flip = `export default {
  name: "flip",
  description: "Flip a coin (deterministically, for the test).",
  inputSchema: { type: "object", properties: {} },
  async run() {
    return { side: "heads" };
  }
};
`;
    // One multi-step turn: write the tool, activate, and use it — via the
    // run_harness_tool bridge, since first-class functions only refresh at
    // turn start.
    const reply = await agent.prompt(
      `!tools ${JSON.stringify([
        {
          name: "write_file",
          input: { path: "/harness/tools/flip.js", content: flip }
        },
        { name: "activate_harness", input: { note: "add flip tool" } },
        { name: "run_harness_tool", input: { name: "flip", input: {} } }
      ])}`
    );
    expect(reply.text).toContain('"side":"heads"');
    // Activation surfaced the live tool list and the same-turn hint.
    expect(reply.text).toContain('"liveTools":["echo","flip"]');
    expect(reply.text).toContain("run_harness_tool");
  });
});

describe("auto-rollback (demo 3: break yourself, kernel saves you)", () => {
  it("restores the last activated version when the live harness cannot load", async () => {
    const agent = await freshAgent("auto-rollback");

    // Break a tool module with a syntax error, without activating.
    await agent.prompt(
      '!tool write_file {"path": "/harness/tools/echo.js", "content": "export default { name: \'broken\' oops"}'
    );

    // Next turn: load fails → kernel restores v1 → turn still completes.
    const reply = await agent.prompt("are you alive?");
    expect(reply.text).toContain("[precise, helpful, curious.]");

    const journal = await agent.getJournal();
    const k = kinds(journal);
    expect(k).toContain("harness_load_failed");
    expect(k).toContain("harness_rollback");

    // The broken file was restored to the seed version.
    const restored = await agent.getFileContent("/harness/tools/echo.js");
    expect(restored).toContain('name: "echo"');

    // No new version was minted by the auto-restore.
    expect(await agent.getVersions()).toHaveLength(1);
  });

  it("activation refuses to commit a broken harness", async () => {
    const agent = await freshAgent("activate-gate");

    // Break policy.json and try to activate within the SAME turn (multi-step),
    // like a real model would — no harness reload between the two steps.
    const result = await agent.prompt(
      `!tools ${JSON.stringify([
        {
          name: "write_file",
          input: { path: "/harness/policy.json", content: "not json" }
        },
        { name: "activate_harness", input: { note: "should fail" } }
      ])}`
    );
    expect(result.text).toContain("activation failed");
    expect(await agent.getVersions()).toHaveLength(1);
  });
});

describe("explicit rollback is forward-only history", () => {
  it("rollback_harness restores old files as a NEW version", async () => {
    const agent = await freshAgent("explicit-rollback");

    await agent.prompt(
      '!tool write_file {"path": "/harness/identity.md", "content": "PERSONA: robot.\\n"}'
    );
    await agent.prompt('!tool activate_harness {"note": "robot"}');
    expect((await agent.prompt("hi")).text).toContain("[robot.]");

    await agent.prompt('!tool rollback_harness {"version": 1}');

    // Old persona is live again…
    expect((await agent.prompt("hi")).text).toContain(
      "[precise, helpful, curious.]"
    );
    // …but history moved forward: v3 records the rollback, nothing rewritten.
    const versions = await agent.getVersions();
    expect(versions).toHaveLength(3);
    expect(versions[2].note).toBe("rollback to v1");

    const journal = await agent.getJournal();
    const rollback = journal.find(
      (e) => e.kind === "harness_rollback" && e.data.reason === "requested"
    );
    expect(rollback?.data.toVersion).toBe(1);
    expect(rollback?.data.asVersion).toBe(3);
  });
});

describe("journal", () => {
  it("is append-only and strictly ordered", async () => {
    const agent = await freshAgent("journal-order");
    await agent.prompt("one");
    await agent.prompt('!tool journal_note {"text": "remember me"}');

    const journal = await agent.getJournal();
    const ids = journal.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(journal[0].kind).toBe("genesis");

    const note = journal.find(
      (e) => e.kind === "note" && e.data.source === "agent"
    );
    expect(note?.data.text).toBe("remember me");
  });

  it("pages backwards with beforeId", async () => {
    const agent = await freshAgent("journal-paging");
    await agent.prompt("a");
    await agent.prompt("b");

    const all = await agent.getJournal();
    expect(all.length).toBeGreaterThan(4);
    const lastId = all[all.length - 1].id;
    const page = await agent.getJournal(lastId, 2);
    expect(page).toHaveLength(2);
    expect(page.every((e) => e.id < lastId)).toBe(true);
  });
});

describe("artifacts mirror", () => {
  it("activation cleanly skips the push when no binding is bound", async () => {
    // The test worker (src/tests/wrangler.jsonc) deliberately has no
    // ARTIFACTS binding — exactly like offline dev. Activation must
    // succeed with no push attempted and no push journal noise.
    const agent = await freshAgent("artifacts-skip");
    await agent.prompt(
      '!tool write_file {"path": "/harness/identity.md", "content": "PERSONA: quiet.\\n"}'
    );
    await agent.prompt('!tool activate_harness {"note": "quiet persona"}');

    const versions = await agent.getVersions();
    expect(versions).toHaveLength(2);
    expect(versions[1].remote).toBeNull();
    expect(versions[1].pushedSha).toBeNull();

    const journal = await agent.getJournal();
    expect(kinds(journal)).not.toContain("artifacts_push");
    expect(kinds(journal)).not.toContain("artifacts_push_failed");
  });

  it("derives valid per-agent session ids, split by environment prefix", () => {
    expect(artifactsSessionId("main")).toBe("exo-main");
    expect(artifactsSessionId("My Agent/42")).toBe("exo-my-agent-42");
    expect(artifactsSessionId("---")).toBe("exo-agent");
    expect(artifactsSessionId("main", "exo-prod")).toBe("exo-prod-main");
    expect(artifactsSessionId("main", "exo-dev")).toBe("exo-dev-main");
    // "__" is the facade's scope separator and must never appear.
    expect(artifactsSessionId("a__b")).toBe("exo-a-b");
  });
});

describe("context snapshot (glass-skull Context tab)", () => {
  it("captures the exact system prompt, messages, and tool surface per turn", async () => {
    const agent = await freshAgent("context-snapshot");
    expect(await agent.getContextSnapshot()).toBeNull();

    await agent.prompt("hello context");

    const snapshot = await agent.getContextSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.source).toBe("prompt");
    expect(snapshot?.model).toBe("mock");
    // The kernel briefing and the LIVE identity file are both in there.
    expect(snapshot?.system).toContain("Kernel briefing");
    expect(snapshot?.system).toContain("PERSONA:");
    expect(JSON.stringify(snapshot?.messages)).toContain("hello context");
    const toolNames = snapshot?.tools.map((t) => t.name) ?? [];
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "read_file",
        "write_file",
        "activate_harness",
        "echo"
      ])
    );
    expect(toolNames).not.toContain("fork_self");

    // Self-modification changes what the next snapshot contains.
    await agent.prompt(
      '!tool write_file {"path": "/harness/identity.md", "content": "PERSONA: minimalist.\\n"}'
    );
    await agent.prompt("hello again");
    const after = await agent.getContextSnapshot();
    expect(after?.system).toContain("PERSONA: minimalist.");
  });
});

describe("self-managed context (context.json + memory + compact_history)", () => {
  it("seeds context.json and applies defaults + clamps", async () => {
    const agent = await freshAgent("ctx-defaults");
    expect(await agent.getFileContent("/harness/context.json")).toContain(
      '"memoryFile": "/memory/core.md"'
    );

    await agent.prompt("hello");
    const snapshot = await agent.getContextSnapshot();
    expect(snapshot?.contextPolicy).toEqual({
      keepMessages: 40,
      tokenTarget: 6000,
      memoryFile: "/memory/core.md",
      memoryMaxChars: 4000
    });
    // No memory yet — nothing injected.
    expect(snapshot?.memoryChars).toBe(0);
    expect(snapshot?.system).not.toContain("## Working memory");
    // The briefing claims the file exists only when it does.
    expect(snapshot?.system).toContain(
      "/harness/context.json — your context policy"
    );

    // Out-of-bounds values are clamped, and a DELETED context.json falls
    // back to defaults instead of failing the load.
    await agent.prompt(
      '!tool write_file {"path": "/harness/context.json", "content": "{\\"keepMessages\\": 1, \\"tokenTarget\\": 999999}"}'
    );
    await agent.prompt("clamped?");
    const clamped = await agent.getContextSnapshot();
    expect(clamped?.contextPolicy.keepMessages).toBe(4);
    expect(clamped?.contextPolicy.tokenTarget).toBe(60000);

    await agent.prompt('!tool delete_file {"path": "/harness/context.json"}');
    await agent.prompt("defaults again?");
    const defaulted = await agent.getContextSnapshot();
    expect(defaulted?.contextPolicy.keepMessages).toBe(40);
    // …and the briefing stops claiming the file exists (agents born
    // before the context milestone hit this path too).
    expect(defaulted?.system).toContain("not present in your harness");
    expect(defaulted?.system).toContain("kernel defaults are in effect");
  });

  it("compact_history writes agent-authored memory that is injected next turn", async () => {
    const agent = await freshAgent("ctx-compact");
    const compacted = await agent.prompt(
      '!tool compact_history {"summary": "Ben prefers laconic pirates and forward-only history.", "keepLast": 4}'
    );
    expect(compacted.toolCalls[0].toolName).toBe("compact_history");

    // Memory written immediately, journaled as requested.
    const memory = await agent.getFileContent("/memory/core.md");
    expect(memory).toContain("Ben prefers laconic pirates");
    const journal = await agent.getJournal();
    const requested = journal.find(
      (e) => e.kind === "history_compacted" && e.data.phase === "requested"
    );
    expect(requested?.data.keepLast).toBe(4);
    expect(requested?.data.memoryFile).toBe("/memory/core.md");

    // Next turn: memory is part of the system prompt.
    await agent.prompt("what do you remember?");
    const snapshot = await agent.getContextSnapshot();
    expect(snapshot?.system).toContain("## Working memory");
    expect(snapshot?.system).toContain("Ben prefers laconic pirates");
    expect(snapshot?.memoryChars).toBeGreaterThan(0);
  });

  it("adds a context-pressure nudge when over the agent's token target", async () => {
    const agent = await freshAgent("ctx-pressure");
    // Minimum-allowed target + a bloated identity → guaranteed pressure.
    await agent.prompt(
      '!tool write_file {"path": "/harness/context.json", "content": "{\\"tokenTarget\\": 500}"}'
    );
    const bigIdentity = `PERSONA: verbose.\n${"x".repeat(4000)}\n`;
    await agent.prompt(
      `!tool write_file ${JSON.stringify({
        path: "/harness/identity.md",
        content: bigIdentity
      })}`
    );
    await agent.prompt("are we over budget?");
    const snapshot = await agent.getContextSnapshot();
    expect(snapshot?.estimatedTokens).toBeGreaterThan(500);
    expect(snapshot?.system).toContain("Context pressure:");
  });

  it("a broken context.json triggers the auto-rollback path", async () => {
    const agent = await freshAgent("ctx-broken");
    await agent.prompt(
      '!tool write_file {"path": "/harness/context.json", "content": "not json"}'
    );
    const reply = await agent.prompt("still alive?");
    expect(reply.text).toContain("[precise, helpful, curious.]");
    const journal = await agent.getJournal();
    const k = kinds(journal);
    expect(k).toContain("harness_load_failed");
    expect(k).toContain("harness_rollback");
  });
});

describe("self-scheduled tasks", () => {
  it("schedule_task registers a task; cancel_task is forward-only history", async () => {
    const agent = await freshAgent("task-basic");
    const scheduled = await agent.prompt(
      '!tool schedule_task {"instruction": "write a heartbeat note in the journal", "delaySeconds": 3600}'
    );
    expect(scheduled.text).toContain('"kind":"delay"');

    const state = await agent.boot();
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].state).toBe("active");
    expect(state.tasks[0].instruction).toContain("heartbeat");
    expect(state.tasks[0].nextRunTs).not.toBeNull();

    const journal = await agent.getJournal();
    expect(kinds(journal)).toContain("task_scheduled");

    const cancel = await agent.prompt(
      `!tool cancel_task {"id": ${JSON.stringify(state.tasks[0].id)}}`
    );
    expect(cancel.text).toContain('"cancelled":true');
    const after = await agent.boot();
    expect(after.tasks[0].state).toBe("cancelled");
    expect(kinds(await agent.getJournal())).toContain("task_cancelled");
  });

  it("rejects malformed schedules and enforces the active-task cap", async () => {
    const agent = await freshAgent("task-caps");
    const both = await agent.prompt(
      '!tool schedule_task {"instruction": "x", "delaySeconds": 60, "cron": "0 3 * * *"}'
    );
    expect(both.text).toContain("exactly one");

    for (let i = 0; i < 10; i++) {
      await agent.prompt(
        `!tool schedule_task {"instruction": "task ${i}", "delaySeconds": 3600}`
      );
    }
    expect((await agent.boot()).tasks).toHaveLength(10);
    const eleventh = await agent.prompt(
      '!tool schedule_task {"instruction": "one too many", "delaySeconds": 3600}'
    );
    expect(eleventh.text).toContain("task limit reached");
  });

  it("a fired task runs an autonomous turn that cannot schedule new tasks", async () => {
    const agent = await freshAgent("task-fire");
    await agent.prompt(
      '!tool schedule_task {"instruction": "task A", "delaySeconds": 3600}'
    );
    await agent.prompt(
      '!tool schedule_task {"instruction": "task B", "delaySeconds": 7200}'
    );
    const [taskB, taskA] = (await agent.boot()).tasks; // newest first

    // Fire A manually (same code path as the alarm) with an instruction
    // that tries to schedule another task. The tool is absent from the
    // task-turn surface, so no nested task can be created.
    await agent.runScheduledTask(
      {
        instruction:
          '!tool schedule_task {"instruction": "nested", "delaySeconds": 3600}'
      },
      { id: taskA.id }
    );
    const journal = await agent.getJournal();
    expect(kinds(journal)).toContain("task_run");
    const turnStarts = journal.filter((e) => e.kind === "turn_start");
    expect(turnStarts.some((e) => e.data.source === "task")).toBe(true);

    // The captured task-turn context proves the gate: cancel_task is
    // available, schedule_task is not.
    const snapshot = await agent.getContextSnapshot();
    expect(snapshot?.source).toBe("task");
    const toolNames = snapshot?.tools.map((t) => t.name) ?? [];
    expect(toolNames).toContain("cancel_task");
    expect(toolNames).not.toContain("schedule_task");

    // No nested task; the one-shot completed and was recorded.
    const state = await agent.boot();
    expect(state.tasks).toHaveLength(2);
    const doneA = state.tasks.find((t) => t.id === taskA.id);
    expect(doneA?.state).toBe("done");
    expect(doneA?.runs).toBe(1);

    // A back-to-back firing of task B hits the global rate limit.
    await agent.runScheduledTask(
      { instruction: "say hello" },
      { id: taskB.id }
    );
    const skipped = (await agent.getJournal()).find(
      (e) => e.kind === "task_skipped"
    );
    expect(skipped?.data.reason).toBe("rate_limited");
    const stillActive = (await agent.boot()).tasks.find(
      (t) => t.id === taskB.id
    );
    expect(stillActive?.state).toBe("active");
  });
});

describe("reset", () => {
  it("resetAgent destroys everything; the next contact is a fresh genesis", async () => {
    const agent = await freshAgent("reset-me");
    await agent.prompt(
      '!tool write_file {"path": "/harness/identity.md", "content": "PERSONA: doomed.\\n"}'
    );
    await agent.prompt('!tool activate_harness {"note": "doomed persona"}');
    expect(await agent.getVersions()).toHaveLength(2);

    try {
      await agent.resetAgent();
    } catch {
      // destroy() aborts the instance mid-RPC — expected.
    }

    // The destroyed instance takes a beat to fully die before the name
    // can be reborn.
    let reborn: KernelStub | undefined;
    for (let attempt = 0; attempt < 20 && !reborn; attempt++) {
      try {
        reborn = await freshAgent("reset-me");
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!reborn) throw new Error("agent did not come back after reset");
    const versions = await reborn.getVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0].note).toBe("genesis");
    // The journal is fresh too — no trace of the doomed persona's turns.
    const journal = await reborn.getJournal();
    expect(journal.filter((e) => e.kind === "harness_upgrade")).toHaveLength(0);
    expect(await reborn.getFileContent("/harness/identity.md")).toContain(
      "precise, helpful, curious"
    );
  });
});

describe("synced UI state", () => {
  it("mirrors versions, journal tail, and harness files", async () => {
    const agent = await freshAgent("ui-state");
    await agent.prompt("hello");
    const state = await agent.boot();

    expect(state.activeVersion).toBe(1);
    expect(state.activeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(state.versions).toHaveLength(1);
    expect(state.harnessFiles.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "/harness/identity.md",
        "/harness/policy.json",
        "/harness/tools/echo.js"
      ])
    );
    expect(kinds(state.journalTail)).toContain("turn_start");
  });
});
