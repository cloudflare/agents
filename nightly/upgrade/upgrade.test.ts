// The upgrade suite: deploy the probe Worker built on the latest release of
// agents, @cloudflare/ai-chat and @cloudflare/think (installed together, from
// npm), leave live rows in it (finished chats, pending approvals, a stream
// mid-reply, queued submissions, a running fiber, a due schedule), deploy
// this repository's build over it mid-turn, and check that nothing was lost
// and nothing ran twice.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UIMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deploy, remove } from "../shared/deploy";
import { MT, Tab, ctl, rid, sleep, user, type Cls } from "../shared/probe";

const DIR = import.meta.dirname;
const NAME = `nightly-upgrade-${Date.now().toString(36)}`;
const KEY = crypto.randomUUID();
const RELEASE = ["agents", "@cloudflare/ai-chat", "@cloudflare/think"];
const CHATS: Cls[] = ["chat", "think"];

type Run = { kind: string; id: string; n: number };
type Probe = { messages: UIMessage[]; runs: Run[]; submissions?: string[] };

async function probe(cls: Cls, room: string): Promise<Probe> {
  const r = await ctl(cls, room, "probeState");
  if (!r.ok) throw new Error(`probeState ${cls}/${room}: ${r.error}`);
  return r.value as Probe;
}

/** Poll the room until `pred` holds. */
async function until(
  cls: Cls,
  room: string,
  pred: (p: Probe) => boolean,
  label: string,
  timeoutMs = 180_000
): Promise<Probe> {
  const start = Date.now();
  for (;;) {
    const p = await probe(cls, room);
    if (pred(p)) return p;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timeout waiting for ${label}: ${JSON.stringify(summary(p)).slice(0, 400)}`
      );
    }
    await sleep(1000);
  }
}

/** Poll until the room's state stops changing for `quietMs`. */
async function quiet(cls: Cls, room: string, quietMs = 10_000): Promise<Probe> {
  let last = "";
  let since = Date.now();
  const start = Date.now();
  for (;;) {
    const p = await probe(cls, room);
    const sig = JSON.stringify(p);
    if (sig !== last) {
      last = sig;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return p;
    if (Date.now() - start > 240_000)
      throw new Error(`${cls}/${room} kept changing`);
    await sleep(1000);
  }
}

const roles = (p: Probe) => p.messages.map((m) => m.role[0]).join("");
const text = (m: UIMessage) =>
  m.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
const summary = (p: Probe) => ({
  roles: roles(p),
  runs: p.runs,
  submissions: p.submissions
});
const awaitsApproval = (p: Probe) =>
  p.messages.some((m) =>
    m.parts.some(
      (part) => (part as { state?: string }).state === "approval-requested"
    )
  );
const runsOf = (p: Probe, kind: string) =>
  p.runs.filter((r) => r.kind === kind);

async function open(cls: Cls, room: string): Promise<Tab> {
  const tab = await new Tab(cls, room).open();
  await tab.waitFor((f) => f.type === MT.IDENTITY, 30_000, "identity");
  return tab;
}

/** Send a message and wait for its reply to end. */
async function chat(cls: Cls, room: string, words: string) {
  const tab = await open(cls, room);
  const id = tab.request(rid("req"), [
    ...(await probe(cls, room)).messages,
    user(words)
  ]);
  await tab.done(id, 60_000);
  tab.close();
}

/** Install the release (all three packages at npm's latest) in a scratch directory. */
function releaseBuild(): { dir: string; versions: Record<string, string> } {
  const dir = mkdtempSync(path.join(tmpdir(), "nightly-upgrade-"));
  const versions = Object.fromEntries(
    RELEASE.map((p) => [
      p,
      execFileSync("npm", ["view", p, "version"], { encoding: "utf8" }).trim()
    ])
  );
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...versions,
        ai: "^7.0.0",
        zod: "^4.0.0",
        // agents' skills runner imports this optional peer, so a Think app bundles it.
        "just-bash": "^3.0.0"
      }
    })
  );
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: dir, stdio: "ignore" }
  );
  copyFileSync(path.join(DIR, "worker.ts"), path.join(dir, "worker.ts"));
  copyFileSync(
    path.join(DIR, "wrangler.jsonc"),
    path.join(dir, "wrangler.jsonc")
  );
  return { dir, versions };
}

let releaseDir: string | undefined;
const before: Record<string, Probe> = {};

beforeAll(async () => {
  const release = releaseBuild();
  releaseDir = release.dir;
  console.log("release", release.versions);
  const url = await deploy({
    config: path.join(release.dir, "wrangler.jsonc"),
    cwd: release.dir,
    name: NAME,
    key: KEY,
    build: "release"
  });
  process.env.PROBE_URL = url;
  process.env.PROBE_KEY = KEY;

  // Rows the release leaves at rest.
  for (const cls of CHATS) {
    await chat(cls, "done", "hello");
    await chat(cls, "done", "again");
    before[`${cls}/done`] = await probe(cls, "done");
    const tab = await open(cls, "approval");
    tab.request(rid("req"), [user("[approve] delete the file")]);
    await until(cls, "approval", awaitsApproval, "approval requested", 60_000);
    tab.close();
  }
  // Due a while after the second deploy has landed.
  await ctl("agent", "schedule", "probeSchedule", 150);

  // Work in flight when the second deploy lands: a reply of 120 chunks at
  // 0.5 s, three queued submissions, a fiber of 60 one-second steps.
  for (const cls of CHATS) {
    await ctl(cls, "stream", "probePace", { tokens: 120, delayMs: 500 });
    const tab = await open(cls, "stream");
    const id = tab.request(rid("req"), [user("count")]);
    await tab.waitFor(
      (f) => f.id === id && Boolean(f.body?.includes("w2 ")),
      30_000,
      "streaming"
    );
    tab.close();
  }
  await ctl("think", "submits", "probePace", { tokens: 30, delayMs: 500 });
  for (const n of [1, 2, 3])
    await ctl("think", "submits", "probeSubmit", `submission ${n}`);
  await ctl("agent", "fiber", "probeStartFiber", 60, 1000);
  // Deploy only once the fiber has a checkpoint to be recovered from.
  await until(
    "agent",
    "fiber",
    (s) => runsOf(s, "step").length > 0,
    "the first fiber step",
    30_000
  );

  // This repository's build over it, mid-turn.
  await deploy({
    config: path.join(DIR, "wrangler.jsonc"),
    cwd: DIR,
    name: NAME,
    key: KEY,
    build: "main"
  });
}, 900_000);

afterAll(() => {
  try {
    remove(NAME, DIR);
  } finally {
    if (releaseDir) rmSync(releaseDir, { recursive: true, force: true });
  }
});

describe("an upgrade from the latest release, mid-turn", () => {
  for (const cls of CHATS) {
    it(`${cls}: a finished chat keeps every message and takes a new turn`, async () => {
      const was = before[`${cls}/done`];
      const now = await probe(cls, "done");
      expect(now.messages.map((m) => [m.id, m.role, text(m)])).toEqual(
        was.messages.map((m) => [m.id, m.role, text(m)])
      );
      await chat(cls, "done", "after the upgrade");
      expect(roles(await probe(cls, "done"))).toBe("uauaua");
    });

    it(`${cls}: a reply cut off by the deploy ends once, with text`, async () => {
      // The model starts again at w1 when recovery continues the turn: two
      // starts show the deploy cut the reply off and the new build took it on.
      const starts = (p: Probe) =>
        p.messages[1] ? (text(p.messages[1]).match(/\bw1 /g)?.length ?? 0) : 0;
      await until(cls, "stream", (p) => starts(p) >= 2, "the recovered reply");
      const p = await quiet(cls, "stream");
      expect(roles(p)).toBe("ua");
      expect(starts(p)).toBe(2);
      // The recovered part is the whole reply, every chunk in order, made by
      // the new build.
      const reply = text(p.messages[1]);
      expect(reply.slice(reply.lastIndexOf("w1 ")).trim()).toBe(
        Array.from({ length: 120 }, (_, i) => `w${i + 1}`).join(" ")
      );
      // One model call on each build: the cut-off one and the recovery.
      expect(runsOf(p, "call")).toEqual([
        { kind: "call", id: "main", n: 1 },
        { kind: "call", id: "release", n: 1 }
      ]);
    });

    it(`${cls}: an approval asked for before the upgrade runs its tool once`, async () => {
      const p = await probe(cls, "approval");
      const call = p.messages
        .flatMap((m) => m.parts)
        .find(
          (part) => (part as { state?: string }).state === "approval-requested"
        ) as { toolCallId: string } | undefined;
      expect(call, "the approval is still pending").toBeDefined();
      const tab = await open(cls, "approval");
      tab.send({
        type: MT.TOOL_APPROVAL,
        toolCallId: call?.toolCallId,
        approved: true,
        autoContinue: true
      });
      const done = await until(
        cls,
        "approval",
        (s) =>
          runsOf(s, "tool").length > 0 &&
          roles(s).endsWith("a") &&
          !awaitsApproval(s),
        "the approved tool's reply",
        60_000
      );
      tab.close();
      const settled = await quiet(cls, "approval");
      expect(runsOf(settled, "tool")).toEqual([
        { kind: "tool", id: call?.toolCallId, n: 1 }
      ]);
      expect(roles(done)).toMatch(/^ua+$/);
    });
  }

  it("think: three queued submissions each complete once, in order", async () => {
    const p = await until(
      "think",
      "submits",
      (s) =>
        (s.submissions ?? []).length === 3 &&
        (s.submissions ?? []).every((x) => x !== "pending" && x !== "running"),
      "submissions settled",
      240_000
    );
    expect(p.submissions).toEqual(["completed", "completed", "completed"]);
    expect(roles(p)).toBe("uauaua");
    expect(p.messages.filter((m) => m.role === "user").map(text)).toEqual([
      "submission 1",
      "submission 2",
      "submission 3"
    ]);
    // Some of the queue ran on the new build: it crossed the deploy. One
    // call per submission, plus at most one for the turn the deploy cut off.
    const calls = runsOf(p, "call");
    expect(calls.map((r) => r.id)).toContain("main");
    const total = calls.reduce((sum, r) => sum + r.n, 0);
    expect(total).toBeGreaterThanOrEqual(3);
    expect(total).toBeLessThanOrEqual(4);
  });

  it("agent: the running fiber is recovered once, from its last checkpoint", async () => {
    const p = await until(
      "agent",
      "fiber",
      (s) => runsOf(s, "recovered").length > 0,
      "fiber recovery"
    );
    const settled = await quiet("agent", "fiber");
    const recovered = runsOf(settled, "recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].n).toBe(1);
    // The checkpoint it was handed is the last step that ran.
    const steps = runsOf(settled, "step");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((r) => r.n === 1)).toBe(true);
    expect(JSON.parse(recovered[0].id)).toEqual({ step: steps.length });
    expect(runsOf(p, "recovered")).toHaveLength(1);
  });

  it("agent: a schedule set by the release fires once", async () => {
    await until(
      "agent",
      "schedule",
      (s) => runsOf(s, "tick").length > 0,
      "the tick",
      300_000
    );
    // It fired once, on the new build.
    expect(runsOf(await quiet("agent", "schedule"), "tick")).toEqual([
      { kind: "tick", id: "main", n: 1 }
    ]);
  });
});
