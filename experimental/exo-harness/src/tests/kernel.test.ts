/**
 * Kernel loop tests — run inside the Workers runtime with the deterministic
 * mock model (MODEL_OVERRIDE=mock, see src/tests/wrangler.jsonc), a real
 * Workspace, real git commits, and real dynamic Worker isolates for harness
 * tools. Each test uses its own agent name (own DO + own workspace).
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { artifactsRepoName } from "../kernel/harness";
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

    const journal = await agent.getJournal();
    expect(kinds(journal)).toContain("genesis");

    // Genesis is idempotent.
    await agent.boot();
    expect(await agent.getVersions()).toHaveLength(1);
  });
});

describe("turn loop with live harness", () => {
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
      (e) => e.kind === "note" && e.data.source === "tool:echo"
    );
    expect(note?.data.text).toBe("echo tool ran: SELF");

    // And its call/result were journaled by the kernel wrapper.
    expect(kinds(journal)).toContain("tool_call");
    expect(kinds(journal)).toContain("tool_result");
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

    const dice = `export default {
  name: "dice",
  description: "Roll dice and record the result in scratch space.",
  inputSchema: {
    type: "object",
    properties: { sides: { type: "number" } },
    required: ["sides"]
  },
  async run(input, caps) {
    const roll = (input.sides % 7) + 1; // deterministic for the test
    await caps.state.writeFile("/scratch/last-roll.txt", String(roll));
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

describe("fork_self (snapshot path — no Artifacts binding in tests)", () => {
  it("forks the activated self into a new agent with lineage recorded", async () => {
    const parent = await freshAgent("fork-parent");
    await parent.prompt(
      '!tool write_file {"path": "/harness/identity.md", "content": "PERSONA: ancestor.\\n"}'
    );
    await parent.prompt('!tool activate_harness {"note": "ancestor persona"}');

    const forked = await parent.prompt(
      '!tool fork_self {"name": "fork-child"}'
    );
    expect(forked.text).toContain('"child":"fork-child"');
    expect(forked.text).toContain('"origin":"files"');

    // The child exists with the parent's activated self as its v1…
    const child = (await getAgentByName(
      env.ExoKernel,
      "fork-child"
    )) as unknown as KernelStub;
    const reply = await child.prompt("hello");
    expect(reply.text).toContain("[ancestor.]");
    const versions = await child.getVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0].note).toBe("fork of fork-parent v2");

    // …and both sides journaled the lineage.
    const parentJournal = await parent.getJournal();
    const fork = parentJournal.find((e) => e.kind === "fork");
    expect(fork?.data.child).toBe("fork-child");
    expect(fork?.data.origin).toBe("files");
    expect(fork?.data.fromVersion).toBe(2);

    const childJournal = await child.getJournal();
    const genesis = childJournal.find((e) => e.kind === "genesis");
    expect(genesis?.data.parent).toBe("fork-parent");
    expect(genesis?.data.parentVersion).toBe(2);
  });

  it("refuses to fork onto itself or an existing agent", async () => {
    const parent = await freshAgent("fork-guard");
    const self = await parent.prompt('!tool fork_self {"name": "fork-guard"}');
    expect(self.text).toContain("cannot fork onto yourself");

    await freshAgent("fork-guard-taken"); // already has a history
    const taken = await parent.prompt(
      '!tool fork_self {"name": "fork-guard-taken"}'
    );
    expect(taken.text).toContain("already has a history");
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

  it("derives valid per-agent repo names, split by environment prefix", () => {
    expect(artifactsRepoName("main")).toBe("exo-main");
    expect(artifactsRepoName("My Agent/42")).toBe("exo-my-agent-42");
    expect(artifactsRepoName("---")).toBe("exo-agent");
    expect(artifactsRepoName("main", "exo-prod")).toBe("exo-prod-main");
    expect(artifactsRepoName("main", "exo-dev")).toBe("exo-dev-main");
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
        "fork_self",
        "echo"
      ])
    );

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
