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

  it("derives valid per-agent repo names", () => {
    expect(artifactsRepoName("main")).toBe("exo-main");
    expect(artifactsRepoName("My Agent/42")).toBe("exo-my-agent-42");
    expect(artifactsRepoName("---")).toBe("exo-agent");
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
