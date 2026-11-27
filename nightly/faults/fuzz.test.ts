// The reset fuzz: one object, four tabs, a seeded random mix of requests
// (each with a fault tag the scripted model acts on), cancels, clears, client
// tool answers (some sent twice, some never), approvals and denials, tab
// reconnects and resets of the object, for a fixed time. Then the room
// settles and the fault suite's invariants, plus the fuzz's own, must hold.
//
// The seed is printed at the start; `FUZZ_SEED=<n>` replays the same choices
// (the timing of the server's answers still varies). A red run prints the
// seed, the violations and the last of the driver's trace.

import { describe, expect, inject, it } from "vitest";
import { violations } from "./invariants";
import type { Run } from "./scenarios";
import {
  CLIENT_TOOLS,
  MT,
  Tab,
  ctl,
  isResp,
  rid,
  settle,
  user,
  type Cls,
  type Frame
} from "../shared/probe";

const MINUTES = Number(process.env.FUZZ_MINUTES ?? 6);
const TABS = 4;
const SEED = Number(process.env.FUZZ_SEED ?? Math.floor(Math.random() * 1e9));
console.log(`fuzz seed ${SEED} (replay with FUZZ_SEED=${SEED})`);

/** xorshift32: the same seed gives the same choices. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** Fault tags the scripted model acts on, with their weights. */
const TAGS: [string, number][] = [
  ["", 30],
  ["[client]", 18],
  ["[server]", 10],
  ["[approve]", 8],
  ["[midtool]", 10],
  ["[slow]", 12],
  ["[stall]", 6],
  ["[error]", 5],
  ["[cstall]", 5],
  ["[429]", 4],
  ["[overflow]", 3]
];
function pick<T>(r: () => number, weighted: [T, number][]): T {
  const total = weighted.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [v, w] of weighted) if ((x -= w) < 0) return v;
  return weighted[0][0];
}

/** The fuzz's clock: a think time between a person's actions (a timer that must elapse). */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Body = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  approvalId?: string;
};
const bodyOf = (f: Frame): Body | null => {
  try {
    return JSON.parse(f.body ?? "") as Body;
  } catch {
    return null;
  }
};

const OPEN = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded"
]);

async function fuzzRoom(cls: Cls, mode: string, seed: number) {
  const r = rng(seed);
  const room = rid(`fz-${cls}-${mode}`);
  const trace: string[] = [];
  const t0 = Date.now();
  const log = (s: string) =>
    trace.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
  const cfg = {
    stallMs: 2000,
    maxAttempts: 3,
    stableTimeoutMs: 5000,
    concurrency: mode,
    classify: "rate_limit",
    maxRetries: 0,
    overflow: true
  };
  const c = await ctl(cls, room, "probeSetConfig", cfg);
  if (!c.ok) throw new Error(`config: ${c.error}`);

  // Each slot is one person's tab; a reconnect replaces the tab in its slot.
  const slots: Tab[][] = [];
  const sent: { id: string; uid: string; slot: number; tag: string }[] = [];
  const handled = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  const current = (slot: number) => slots[slot].at(-1) as Tab;
  const doneOnSlot = (slot: number, id: string) =>
    slots[slot].some((t) =>
      t.frames.some((f) => isResp(f) && f.id === id && f.done)
    );
  const openIds = (slot: number) =>
    sent
      .filter((q) => q.slot === slot && !doneOnSlot(slot, q.id))
      .slice(-8)
      .map((q) => q.id);

  // A person answers the client tools and approvals their tabs are shown.
  const react = (tab: Tab) =>
    tab.onFrame((f) => {
      if (stopped || !isResp(f)) return;
      const b = bodyOf(f);
      if (!b?.toolCallId) return;
      if (
        b.type === "tool-input-available" &&
        CLIENT_TOOLS.some((t) => t.name === b.toolName)
      ) {
        if (handled.has(b.toolCallId)) return;
        handled.add(b.toolCallId);
        if (r() < 0.1) return void log(`ignore ${b.toolName}`);
        const frame = {
          type: MT.TOOL_RESULT,
          toolCallId: b.toolCallId,
          toolName: b.toolName,
          output: { city: "Lisbon" },
          autoContinue: true,
          clientTools: CLIENT_TOOLS
        };
        const slot = Math.floor(r() * TABS);
        const twice = r() < 0.15;
        timers.push(
          setTimeout(
            () => {
              if (stopped) return;
              current(slot).send(frame);
              log(`answer ${b.toolName} on ${slot}${twice ? " (twice)" : ""}`);
              if (twice) current((slot + 1) % TABS).send(frame);
            },
            100 + Math.floor(r() * 3000)
          )
        );
      }
      if (b.type === "tool-approval-request") {
        const key = `ap:${b.approvalId ?? b.toolCallId}`;
        if (handled.has(key)) return;
        handled.add(key);
        if (r() < 0.1) return void log("ignore approval");
        const approved = r() < 0.7;
        const slot = Math.floor(r() * TABS);
        timers.push(
          setTimeout(
            () => {
              if (stopped) return;
              current(slot).send({
                type: MT.TOOL_APPROVAL,
                toolCallId: b.toolCallId,
                approvalId: b.approvalId,
                approved,
                autoContinue: true
              });
              log(`${approved ? "approve" : "deny"} on ${slot}`);
            },
            200 + Math.floor(r() * 2500)
          )
        );
      }
    });

  const reopen = async (slot: number) => {
    const tab = await new Tab(cls, room).open();
    react(tab);
    tab.send({ type: MT.RESUME_REQUEST, requestIds: openIds(slot) });
    slots[slot].push(tab);
    return tab;
  };
  for (let i = 0; i < TABS; i++) {
    const tab = await new Tab(cls, room).open();
    react(tab);
    slots.push([tab]);
  }

  const deadline = Date.now() + MINUTES * 60_000;
  let submits = 0;
  let resets = 0;
  const person = async (slot: number) => {
    while (Date.now() < deadline) {
      let tab = current(slot);
      if (tab.closed || r() < 0.03) {
        tab.close();
        tab = await reopen(slot);
        log(`reconnect ${slot}`);
      }
      await wait(300 + Math.floor(r() * 2200));
      if (Date.now() >= deadline || tab.closed) continue;
      const x = r();
      if (x < 0.62) {
        const tag = pick(r, TAGS);
        const id = rid(`q${slot}`);
        const m = user(`${tag} msg ${submits++}`);
        tab.request(id, [m], { clientTools: CLIENT_TOOLS });
        sent.push({ id, uid: m.id, slot, tag });
        log(`send ${id} ${tag} on ${slot}`);
      } else if (x < 0.8) {
        const mine = sent.filter((q) => q.slot === slot).slice(-3);
        const target = mine[Math.floor(r() * mine.length)];
        if (target) {
          tab.send({ type: MT.CANCEL, id: target.id });
          log(`cancel ${target.id} on ${slot}`);
        }
      } else if (x < 0.83) {
        tab.send({ type: MT.CLEAR });
        log(`clear on ${slot}`);
      } else if (x < 0.88) {
        const streaming = [...tab.frames]
          .reverse()
          .find((f) => isResp(f) && !f.done);
        if (streaming?.id) {
          tab.send({ type: MT.CANCEL, id: streaming.id });
          log(`cancel streaming ${streaming.id} on ${slot}`);
        }
      }
    }
  };
  const resetter = async () => {
    for (;;) {
      await wait(30_000 + Math.floor(r() * 60_000));
      if (Date.now() >= deadline - 20_000) return;
      await ctl(cls, room, "probeAbort");
      resets++;
      log("reset");
    }
  };
  await Promise.all([...slots.map((_, i) => person(i)), resetter()]);

  // Every person comes back once more, so a replayed end can reach them.
  for (let i = 0; i < TABS; i++) if (current(i).closed) await reopen(i);
  stopped = true;
  for (const t of timers) clearTimeout(t);
  log("stop");

  const state = await settle(cls, room, { quietMs: 6000, maxMs: 150_000 });
  const late = await new Tab(cls, room).open();
  late.send({ type: MT.RESUME_REQUEST });
  const offer = await late
    .waitFor(
      (f) => f.type === MT.RESUME_NONE || f.type === MT.RESUMING,
      15_000,
      "resume reply"
    )
    .catch(() => undefined);
  if (offer?.type === MT.RESUMING)
    await late
      .waitFor(
        (f) =>
          isResp(f) &&
          f.id === offer.id &&
          Boolean(f.done) &&
          f.outcome !== "recovering",
        60_000,
        "the replay to end"
      )
      .catch(() => undefined);
  for (const slot of slots) for (const t of slot) t.close();
  late.close();

  // A request counts as accepted when the server answered it on some tab or
  // stored its message; one a reset cut before it arrived was never sent.
  const msgs = state.messages;
  const stored = new Set(msgs.map((m) => m.id));
  const answered = new Set(
    slots.flat().flatMap((t) => t.frames.filter(isResp).map((f) => f.id))
  );
  const accepted = sent.filter((q) => answered.has(q.id) || stored.has(q.uid));
  // The connections open at the end get the fault suite's per-tab checks (a
  // request ends once, a hand-off to recovery ends). A connection a
  // reconnect replaced may have lost a request's end to its successor, so
  // there only "ends once" is checked, below, and every accepted request
  // must end on one of its slot's connections.
  const lastTabs = slots.map((slot) => slot.at(-1) as Tab);
  const tabs = lastTabs.map((t) => ({
    sent: t.sent.filter((id) => accepted.some((q) => q.id === id)),
    frames: t.frames
  }));

  // The fuzz's own invariants, from verify's driver.
  const checks: string[] = [];
  for (const t of slots.flat()) {
    if (lastTabs.includes(t)) continue;
    const ends = new Map<string, number>();
    for (const f of t.frames)
      if (isResp(f) && f.done && f.id && f.outcome !== "recovering")
        ends.set(f.id, (ends.get(f.id) ?? 0) + 1);
    for (const [id, n] of ends)
      if (n > 1)
        checks.push(`a replaced connection: request ${id} ended ${n} times`);
  }
  for (const q of accepted)
    if (!doneOnSlot(q.slot, q.id))
      checks.push(
        `request ${q.id} (${q.tag || "plain"}) never ended on any of tab ${q.slot}'s connections`
      );
  msgs.forEach((m, i) => {
    if (i === msgs.length - 1 || m.role !== "assistant") return;
    for (const p of m.parts as { type: string; state?: string }[])
      if (p.type.startsWith("tool-") && p.state && OPEN.has(p.state))
        checks.push(
          `message ${i}: ${p.type} left ${p.state} and the chat moved past it`
        );
  });
  const numOf = (m: (typeof msgs)[number]) =>
    [
      ...m.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join(" ")
        .matchAll(/msg (\d+)/g)
    ].at(-1)?.[1];
  let lastUser: string | undefined;
  const users: string[] = [];
  msgs.forEach((m, i) => {
    if (m.role === "user") {
      lastUser = numOf(m);
      if (lastUser) users.push(lastUser);
      return;
    }
    for (const p of m.parts)
      if (p.type === "text")
        for (const [, tag] of p.text.matchAll(/\[re:(\d+)\]/g))
          if (lastUser !== undefined && tag !== lastUser)
            checks.push(
              `message ${i}: a reply to msg ${tag} after msg ${lastUser}`
            );
  });
  const dupUsers = users.filter((u, i) => users.indexOf(u) !== i);
  if (dupUsers.length)
    checks.push(`user messages stored twice: ${dupUsers.join(", ")}`);

  const run: Run = { state, tabs, lateTab: late.frames, extra: {}, checks };
  return { room, seed, submits, resets, bad: violations(run), trace };
}

const ROOMS: [Cls, string][] = [
  ["think", "queue"],
  ["think", "latest"],
  ["chat", "queue"],
  ["chat", "latest"]
];

describe.concurrent("reset fuzz", () => {
  ROOMS.forEach(([cls, mode], i) => {
    it(`${cls}, ${mode}: ${MINUTES} min of seeded actions and resets, then every invariant`, async () => {
      process.env.PROBE_URL = inject("probeUrl");
      process.env.PROBE_KEY = inject("probeKey");
      const seed = SEED + i;
      const res = await fuzzRoom(cls, mode, seed);
      expect(res.submits, "the fuzz sent nothing").toBeGreaterThan(0);
      expect(
        res.bad,
        `seed ${SEED} (room ${res.room}, room seed ${seed}, ${res.submits} requests, ${res.resets} resets)\n${res.bad.join("\n")}\nlast of the trace:\n${res.trace.slice(-60).join("\n")}`
      ).toEqual([]);
    });
  });
});
