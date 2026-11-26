// The fault scenarios, from verify's tc-faults probe. Each sets the room's
// script, drives one or more tabs (or RPC calls) through a fault and returns
// what the invariants read. A scenario orders its own actions on what the
// object reports: a frame on the tab, or a recovery event, note or model
// call in the room's recorded state. It never orders them by time. `finish`
// then waits until nothing changes.

import {
  CLIENT_TOOLS,
  MT,
  Tab,
  ctl,
  isResp,
  isThink,
  rid,
  settle,
  sleep,
  state,
  user,
  type Cls,
  type CtlResult,
  type Frame,
  type ProbeState
} from "../shared/probe";

/** One scenario's outcome: the settled state and every frame each tab saw. */
export type Run = {
  state: ProbeState & { unsettled: boolean };
  tabs: { sent: string[]; frames: Frame[] }[];
  /** A tab opened after everything settled: what a returning client sees. */
  lateTab: Frame[];
  extra: Record<string, unknown>;
  /** The scenario's own expectations that did not hold. */
  checks: string[];
};

type Step = Record<string, unknown>;

async function setup(cls: Cls, cfg: Record<string, unknown>) {
  const room = rid(cls);
  const r = await ctl(cls, room, "probeSetConfig", cfg);
  if (!r.ok) throw new Error(`config: ${r.error}`);
  const tab = await openTab(cls, room);
  return { room, tab };
}

/** A tab that has had the server's greeting, so the object has accepted it. */
async function openTab(cls: Cls, room: string): Promise<Tab> {
  const tab = await new Tab(cls, room).open();
  await tab.waitFor((f) => f.type === MT.IDENTITY, 30_000, "identity");
  return tab;
}

/** Poll the room's recorded state until `pred` holds. */
async function until(
  cls: Cls,
  room: string,
  pred: (s: ProbeState) => boolean,
  label: string,
  timeoutMs = 60_000
): Promise<ProbeState> {
  const start = Date.now();
  for (;;) {
    const s = await state(cls, room);
    if (pred(s)) return s;
    if (Date.now() - start > timeoutMs)
      throw new Error(`timeout waiting for ${label}`);
    await sleep(300);
  }
}

const events = (s: ProbeState, type: string) =>
  s.events.filter((e) => e.type === type).length;
const hasNote = (s: ProbeState, key: string) => s.notes.some((n) => key in n);

/** Until `n` recovery events of `type` are recorded. */
function untilEvent(cls: Cls, room: string, type: string, n = 1) {
  return until(cls, room, (s) => events(s, type) >= n, `${n} x ${type}`);
}

/** Every request the tab sent has ended (a hand-off to recovery is not an end). */
function tabSettled(tab: Tab): boolean {
  let handedOff = false;
  const done = new Set<string>();
  for (const f of tab.frames) {
    if (f.type !== MT.RESPONSE || !f.done || !f.id) continue;
    done.add(f.id);
    handedOff = f.outcome === "recovering";
  }
  return !handedOff && tab.sent.every((id) => done.has(id));
}

/**
 * The model call after the first `step` call waited at least `minMs` (the
 * delay the provider asked for). When `retried`, that call must exist:
 * Think retries a classified 429; AIChatAgent ends the request.
 */
function waitedAfter(
  run: Run,
  step: string,
  minMs: number,
  retried: boolean
): Run {
  const calls = run.state.calls.filter((c) => c.step);
  const i = calls.findIndex((c) => c.step === step);
  const next = i >= 0 ? calls[i + 1] : undefined;
  if (retried && !next) run.checks.push(`no model call after ${step}`);
  // Workers clocks move in steps: allow 10%.
  if (next && next.at - calls[i].at < minMs * 0.9) {
    run.checks.push(
      `the call after ${step} came ${next.at - calls[i].at} ms later, not the ${minMs} ms asked for`
    );
  }
  return run;
}

/** A response frame of request `id` whose text reached `marker`. */
function chunkOf(id: string | undefined, marker: string) {
  return (f: Frame) =>
    isResp(f) && f.id === id && f.body !== undefined && f.body.includes(marker);
}

async function finish(
  cls: Cls,
  room: string,
  tabs: Tab[],
  extra: Record<string, unknown> = {},
  settleOpts?: { quietMs?: number; maxMs?: number }
): Promise<Run> {
  const settled = await settle(cls, room, settleOpts);
  // The frames that end the tabs' requests may still be on the wire; the
  // invariants judge what has not arrived within the bound.
  const deadline = Date.now() + 10_000;
  while (!tabs.every(tabSettled) && Date.now() < deadline) await sleep(200);
  // Read the room again, so the state is not older than those frames.
  const s = { ...(await state(cls, room)), unsettled: settled.unsettled };
  const late = await openTab(cls, room);
  late.send({ type: MT.RESUME_REQUEST });
  const offer = await late
    .waitFor(
      (f) => f.type === MT.RESUME_NONE || f.type === MT.RESUMING,
      15_000,
      "resume reply"
    )
    .catch(() => undefined);
  // An offered stream (a settled one is replayed) ends with its done frame.
  if (offer?.type === MT.RESUMING) {
    await late
      .waitFor(
        // A replayed `recovering` hand-off is not the end: the terminal
        // may follow it.
        (f) =>
          isResp(f) &&
          f.id === offer.id &&
          f.done === true &&
          f.outcome !== "recovering",
        15_000,
        "replayed end"
      )
      .catch(() => undefined);
  }
  late.close();
  for (const t of tabs) t.close();
  return {
    state: s,
    tabs: tabs.map((t) => ({ sent: t.sent, frames: t.frames })),
    lateTab: late.frames,
    extra,
    checks: []
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  output: unknown = { city: "Lisbon" }
) {
  return {
    type: MT.TOOL_RESULT,
    toolCallId,
    toolName,
    output,
    autoContinue: true,
    clientTools: CLIENT_TOOLS
  };
}

async function waitToolInput(
  tab: Tab,
  name: string,
  timeout = 30_000
): Promise<{ toolCallId: string }> {
  const f = await tab.waitFor(
    (x: Frame) =>
      isResp(x) &&
      x.body !== undefined &&
      x.body.includes('"tool-input-available"') &&
      x.body.includes(name),
    timeout,
    `tool-input ${name}`
  );
  return JSON.parse(f.body ?? "{}") as { toolCallId: string };
}

/** Until the approval the action asked for is listed as pending. */
async function untilPending(cls: Cls, room: string): Promise<CtlResult> {
  const start = Date.now();
  for (;;) {
    const r = await ctl(cls, room, "probePending");
    if (Array.isArray(r.value) && r.value.length > 0) return r;
    if (Date.now() - start > 30_000) return r;
    await sleep(300);
  }
}

/** The request (or continuation) `id` ended with `outcome` on the first tab. */
function endedAs(run: Run, id: string | undefined, outcome: string): Run {
  const end = [...(run.tabs[0]?.frames ?? [])]
    .reverse()
    .find(
      (f) =>
        isResp(f) &&
        f.id === id &&
        f.done === true &&
        f.outcome !== "recovering"
    );
  if (end?.outcome !== outcome) {
    run.checks.push(`${id} ended ${end?.outcome ?? "never"}, not ${outcome}`);
  }
  return run;
}

/** The transcript's roles, `u` and `a`, in order. */
function roles(run: Run, expected: string): Run {
  const got = run.state.messages.map((m) => m.role[0]).join("");
  if (got !== expected)
    run.checks.push(`transcript roles ${got}, not ${expected}`);
  return run;
}

/**
 * Every user message is followed by an assistant message, and when
 * `finalText` is given the last reply carries it (the recovered turn's
 * text, not only what streamed before the reset).
 */
function answered(run: Run, finalText?: string): Run {
  const got = run.state.messages.map((m) => m.role[0]).join("");
  if (!got || /u(?!a)/.test(got))
    run.checks.push(`a user message has no reply: ${got || "(empty)"}`);
  const last = run.state.messages[run.state.messages.length - 1];
  const text = (last?.parts ?? [])
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trimEnd();
  if (finalText && !text.endsWith(finalText)) {
    run.checks.push(
      `the last reply does not end "${finalText}": ${text.slice(-80)}`
    );
  }
  return run;
}

/** The object restarted: the reset the scenario asked for happened. */
function restarted(run: Run): Run {
  if (run.state.starts < 2) {
    run.checks.push(`the object started ${run.state.starts} time(s): no reset`);
  }
  return run;
}

/**
 * The approval was found, the approved action ran, and the continuation it
 * started ended with `continuation` (`completed`, or `aborted` when stopped).
 */
function approvedRan(run: Run, approved: CtlResult, continuation: string): Run {
  const cont = run.state.responses.filter((r) => r.continuation);
  if (cont.length !== 1 || cont[0].status !== continuation) {
    run.checks.push(
      `approval continuation: ${JSON.stringify(cont.map((r) => r.status))}, not one ${continuation}`
    );
  }
  const out = (approved.value as { out?: string } | null)?.out;
  if (!out?.includes("paused-exec")) {
    run.checks.push(
      `the approval did not run the action: ${JSON.stringify(approved).slice(0, 160)}`
    );
  }
  return run;
}

function firstExecutionId(pending: CtlResult): string | undefined {
  return Array.isArray(pending.value)
    ? (pending.value[0] as { executionId?: string } | undefined)?.executionId
    : undefined;
}

const TEXT = (n = 6, delayMs = 20): Step => ({
  kind: "text",
  tokens: n,
  delayMs
});
const STALL = (after = 5): Step => ({
  kind: "text",
  tokens: 30,
  delayMs: 30,
  stallAfter: after
});

export const SCENARIOS: Record<string, (cls: Cls) => Promise<Run>> = {
  // ── 1. stall watchdog ──
  async stall(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [STALL(5), TEXT(8)]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async stallPendingClientAnswered(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [
        {
          kind: "tool",
          name: "getUserLocation",
          textBefore: 2,
          stallAfterTool: true
        },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("where am I")], {
      clientTools: CLIENT_TOOLS
    });
    const input = await waitToolInput(tab, "getUserLocation");
    // Answer once the watchdog has called the stall and recovery has begun.
    await untilEvent(cls, room, "chat:recovery:detected");
    tab.send(toolResult(input.toolCallId, "getUserLocation"));
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async stallPendingClientUnanswered(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      stableTimeoutMs: 6000,
      script: [
        {
          kind: "tool",
          name: "getUserLocation",
          textBefore: 2,
          stallAfterTool: true
        },
        TEXT(8)
      ]
    });
    tab.request(rid("req"), [user("where am I")], {
      clientTools: CLIENT_TOOLS
    });
    await waitToolInput(tab, "getUserLocation");
    return finish(cls, room, [tab]);
  },
  async stallInContinuation(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [
        { kind: "tool", name: "getUserLocation", textBefore: 1 },
        STALL(3),
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("where am I")], {
      clientTools: CLIENT_TOOLS
    });
    const input = await waitToolInput(tab, "getUserLocation");
    await tab.done(id, 20000);
    tab.send(toolResult(input.toolCallId, "getUserLocation"));
    return finish(cls, room, [tab]);
  },

  async stallSave(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [STALL(5), TEXT(8)]
    });
    const r = await ctl(cls, room, "probeSave", "hello");
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },
  async stallChatRpc(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [STALL(5), TEXT(8)]
    });
    const r = await ctl(cls, room, "probeRpcChat", "hello", {});
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },
  async stallChatRpcDeclined(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      recoveryContinue: false,
      script: [STALL(5), TEXT(8)]
    });
    const r = await ctl(cls, room, "probeRpcChat", "hello", {});
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },
  async stallDeclined(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      recoveryContinue: false,
      script: [STALL(5), TEXT(8)]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    await tab.done(id, 20000).catch(() => {});
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async stallDeclinedAway(cls: Cls) {
    // the client leaves before the stall; a later tab must learn the outcome
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      recoveryContinue: false,
      script: [STALL(5), TEXT(8)]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    // Leave once the reply has started, before the stall.
    await tab.waitFor(chunkOf(id, "w1 "), 20000, "w1");
    tab.close();
    return finish(cls, room, []);
  },

  // ── 2. 429 ──
  async rl429RetryAfter(cls: Cls) {
    const { room, tab } = await setup(cls, {
      classify: "rate_limit",
      maxRetries: 0,
      script: [
        { kind: "status", status: 429, headers: { "retry-after": "7" } },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    return waitedAfter(
      await finish(cls, room, [tab], { reqId: id.slice(0, 14) }),
      "status-429",
      7000,
      isThink(cls)
    );
  },
  async rl429RetryAfterMs(cls: Cls) {
    const { room, tab } = await setup(cls, {
      classify: "rate_limit",
      maxRetries: 0,
      script: [
        { kind: "status", status: 429, headers: { "retry-after-ms": "5500" } },
        TEXT(8)
      ]
    });
    tab.request(rid("req"), [user("hello")], { clientTools: CLIENT_TOOLS });
    return waitedAfter(
      await finish(cls, room, [tab]),
      "status-429",
      5500,
      isThink(cls)
    );
  },
  async rl429Transient(cls: Cls) {
    const { room, tab } = await setup(cls, {
      classify: "transient",
      maxRetries: 0,
      script: [
        { kind: "status", status: 429, headers: { "retry-after": "7" } },
        TEXT(8)
      ]
    });
    tab.request(rid("req"), [user("hello")], { clientTools: CLIENT_TOOLS });
    return waitedAfter(
      await finish(cls, room, [tab]),
      "status-429",
      7000,
      isThink(cls)
    );
  },
  async rl429SdkRetries(cls: Cls) {
    // default AI SDK maxRetries (2): it retries twice itself, then throws RetryError
    const { room, tab } = await setup(cls, {
      classify: "rate_limit",
      script: [
        { kind: "status", status: 429, headers: { "retry-after": "1" } },
        { kind: "status", status: 429, headers: { "retry-after": "1" } },
        { kind: "status", status: 429, headers: { "retry-after": "9" } },
        TEXT(8)
      ]
    });
    tab.request(rid("req"), [user("hello")], { clientTools: CLIENT_TOOLS });
    return finish(cls, room, [tab]);
  },
  async rl429MidTurn(cls: Cls) {
    // a 429 on the second step of a turn (after a server tool ran)
    const { room, tab } = await setup(cls, {
      classify: "rate_limit",
      maxRetries: 0,
      script: [
        { kind: "tool", name: "getWeather", args: { city: "Paris" } },
        { kind: "status", status: 429, headers: { "retry-after": "6" } },
        TEXT(8)
      ]
    });
    tab.request(rid("req"), [user("weather")], { clientTools: CLIENT_TOOLS });
    return waitedAfter(
      await finish(cls, room, [tab]),
      "status-429",
      6000,
      isThink(cls)
    );
  },

  // ── 3. context overflow (Think) ──
  async ovClient(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [TEXT(), TEXT(), { kind: "overflow" }, TEXT(8)]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    const id = tab.request(rid("req"), [user("three")]);
    await tab.done(id, 30000).catch(() => {});
    return finish(cls, room, [tab]);
  },
  async ovSave(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [TEXT(), TEXT(), { kind: "overflow" }, TEXT(8)]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    const r = await ctl(cls, room, "probeSave", "three");
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },
  async ovChat(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [TEXT(), TEXT(), { kind: "overflow" }, TEXT(8)]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    const r = await ctl(cls, room, "probeRpcChat", "three", {});
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },
  async ovContinueLast(cls: Cls) {
    // second reply stopped mid-text, then continueLastTurn overflows
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [
        TEXT(),
        { kind: "text", tokens: 40, delayMs: 60 },
        { kind: "overflow" },
        TEXT(8)
      ]
    });
    const a = tab.request(rid("req"), [user("one")]);
    await tab.done(a, 20000);
    const b = tab.request(rid("req"), [user("two")]);
    await tab.waitFor(
      (f: Frame) => isResp(f) && f.id === b && f.body?.includes("w3 "),
      20000,
      "w3"
    );
    tab.send({ type: MT.CANCEL, id: b });
    await tab.done(b, 20000);
    const r = await ctl(cls, room, "probeContinue");
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },
  async ovContinuation(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [
        TEXT(),
        { kind: "tool", name: "getUserLocation", textBefore: 1 },
        { kind: "overflow" },
        TEXT(8)
      ]
    });
    const a = tab.request(rid("req"), [user("one")], {
      clientTools: CLIENT_TOOLS
    });
    await tab.done(a, 20000);
    const b = tab.request(rid("req"), [user("where")], {
      clientTools: CLIENT_TOOLS
    });
    const input = await waitToolInput(tab, "getUserLocation");
    await tab.done(b, 20000);
    tab.send(toolResult(input.toolCallId, "getUserLocation"));
    return finish(cls, room, [tab]);
  },
  async ovRecoveryRetry(cls: Cls) {
    // the turn stalls before any part, recovery retries, the retry overflows
    const { room, tab } = await setup(cls, {
      overflow: true,
      stallMs: 3000,
      script: [
        TEXT(),
        TEXT(),
        { kind: "text", tokens: 10, stallAfter: 0 },
        { kind: "overflow" },
        TEXT(8)
      ]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    tab.request(rid("req"), [user("three")]);
    return finish(cls, room, [tab]);
  },
  async ovRecoveryContinue(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      stallMs: 3000,
      script: [TEXT(), TEXT(), STALL(4), { kind: "overflow" }, TEXT(8)]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    tab.request(rid("req"), [user("three")]);
    return finish(cls, room, [tab]);
  },
  async ovUnrecoverableClient(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [TEXT(), TEXT()]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    await ctl(cls, room, "probeSetConfig", {
      overflow: true,
      overflowOverChars: 10
    });
    const id = tab.request(rid("req"), [user("three")]);
    await tab.done(id, 30000).catch(() => {});
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async ovUnrecoverableChat(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [TEXT(), TEXT()]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    await ctl(cls, room, "probeSetConfig", {
      overflow: true,
      overflowOverChars: 10
    });
    const r = await ctl(cls, room, "probeRpcChat", "three", {});
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },
  async ovUnrecoverableSave(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [TEXT(), TEXT()]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    await ctl(cls, room, "probeSetConfig", {
      overflow: true,
      overflowOverChars: 10
    });
    const r = await ctl(cls, room, "probeSave", "three");
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },
  async ovUnrecoverableContinuation(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [
        TEXT(),
        { kind: "tool", name: "getUserLocation", textBefore: 1 },
        { kind: "overflow" },
        { kind: "overflow" },
        { kind: "overflow" }
      ]
    });
    const a = tab.request(rid("req"), [user("one")], {
      clientTools: CLIENT_TOOLS
    });
    await tab.done(a, 20000);
    const b = tab.request(rid("req"), [user("where")], {
      clientTools: CLIENT_TOOLS
    });
    const input = await waitToolInput(tab, "getUserLocation");
    await tab.done(b, 20000);
    tab.send(toolResult(input.toolCallId, "getUserLocation"));
    return finish(cls, room, [tab]);
  },

  async ovUnrecoverableRecovery(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      stallMs: 3000,
      script: [
        TEXT(),
        TEXT(),
        STALL(4),
        { kind: "overflow" },
        { kind: "overflow" },
        { kind: "overflow" },
        { kind: "overflow" }
      ]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    tab.request(rid("req"), [user("three")]);
    return finish(cls, room, [tab]);
  },
  async ovUnrecoverableContinueLast(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      script: [
        TEXT(),
        { kind: "text", tokens: 40, delayMs: 60 },
        { kind: "overflow" },
        { kind: "overflow" },
        { kind: "overflow" }
      ]
    });
    const a = tab.request(rid("req"), [user("one")]);
    await tab.done(a, 20000);
    const b = tab.request(rid("req"), [user("two")]);
    await tab.waitFor(
      (f: Frame) => isResp(f) && f.id === b && f.body?.includes("w3 "),
      20000,
      "w3"
    );
    tab.send({ type: MT.CANCEL, id: b });
    await tab.done(b, 20000);
    const r = await ctl(cls, room, "probeContinue");
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },
  async ovStopDuringCompaction(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      compactionDelayMs: 5000,
      script: [TEXT(), TEXT(), { kind: "overflow" }, TEXT(8)]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    const id = tab.request(rid("req"), [user("three")]);
    // Stop while the compaction runs (it is held for 5 s).
    await until(cls, room, (s) => hasNote(s, "compaction"), "compaction start");
    tab.send({ type: MT.CANCEL, id });
    await tab.done(id, 20000).catch(() => {});
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async ovStopDuringCompactionChat(cls: Cls) {
    const { room, tab } = await setup(cls, {
      overflow: true,
      compactionDelayMs: 5000,
      script: [TEXT(), TEXT(), { kind: "overflow" }, TEXT(8)]
    });
    for (const q of ["one", "two"]) {
      const i = tab.request(rid("req"), [user(q)]);
      await tab.done(i, 20000);
    }
    const r = await ctl(cls, room, "probeRpcChat", "three", {
      stopOnCompaction: true
    });
    return finish(cls, room, [tab], { returned: r.value ?? r.error });
  },

  // ── 4. recovery fault paths ──
  async recThrows(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      throwInRecoveryContinue: true,
      script: [STALL(5), TEXT(8)]
    });
    tab.request(rid("req"), [user("hello")], { clientTools: CLIENT_TOOLS });
    return finish(cls, room, [tab], {}, { maxMs: 60000 });
  },
  async recBudget(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 2500,
      maxAttempts: 2,
      script: [STALL(3), STALL(3), STALL(3), STALL(3), STALL(3), STALL(3)]
    });
    tab.request(rid("req"), [user("hello")], { clientTools: CLIENT_TOOLS });
    return finish(cls, room, [tab], {}, { maxMs: 60000 });
  },
  async recBudgetNoProgress(cls: Cls) {
    // every attempt stalls before any text: no progress at all
    const { room, tab } = await setup(cls, {
      stallMs: 2500,
      maxAttempts: 2,
      script: [
        STALL(3),
        ...Array.from({ length: 8 }, () => ({
          kind: "text",
          tokens: 10,
          stallAfter: 0
        }))
      ]
    });
    tab.request(rid("req"), [user("hello")], { clientTools: CLIENT_TOOLS });
    return finish(cls, room, [tab], {}, { maxMs: 60000 });
  },
  async recStopOwnId(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [STALL(3), { kind: "text", tokens: 60, delayMs: 80 }, TEXT(8)]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    // wait for a text chunk under another request id: the recovered turn
    const f = await tab.waitFor(
      (x: Frame) =>
        isResp(x) && x.id !== id && x.body?.includes('"text-delta"'),
      30000,
      "recovered text"
    );
    // Stop mid-reply: once the recovered turn is a few chunks in.
    await tab.waitFor(chunkOf(f.id, "w5 "), 30000, "recovered w5");
    tab.send({ type: MT.CANCEL, id: f.id });
    const run = await finish(cls, room, [tab], {
      reqId: id.slice(0, 14),
      recoveredId: f.id?.slice(0, 14)
    });
    return endedAs(run, f.id, "aborted");
  },
  async recStopOrigDuringStream(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [STALL(3), { kind: "text", tokens: 60, delayMs: 80 }, TEXT(8)]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    const f = await tab.waitFor(
      (x: Frame) =>
        isResp(x) && x.id !== id && x.body?.includes('"text-delta"'),
      30000,
      "recovered text"
    );
    await tab.waitFor(chunkOf(f.id, "w5 "), 30000, "recovered w5");
    tab.send({ type: MT.CANCEL, id });
    // Stopping the original request stops the recovered turn that carries it.
    const run = await finish(cls, room, [tab], {
      reqId: id.slice(0, 14),
      recoveredId: f.id?.slice(0, 14)
    });
    return endedAs(run, f.id, "aborted");
  },
  async recStopDuringBackoff(cls: Cls) {
    const { room, tab } = await setup(cls, {
      classify: "rate_limit",
      maxRetries: 0,
      stallMs: 3000,
      script: [
        { kind: "status", status: 429, headers: { "retry-after": "10" } },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    // Stop inside the 10 s backoff the 429 asked for.
    await untilEvent(cls, room, "chat:recovery:scheduled");
    tab.send({ type: MT.CANCEL, id });
    // The stop closes the incident at once; stay quiet past the 10 s the
    // backoff asked for, so a retry that ignored the stop is seen.
    return finish(
      cls,
      room,
      [tab],
      { reqId: id.slice(0, 14) },
      { quietMs: 12_000 }
    );
  },
  // #3241: a request sent while a recovery waits out its backoff is answered after the recovered reply.
  async recNewDuringBackoff(cls: Cls) {
    const { room, tab } = await setup(cls, {
      classify: "rate_limit",
      maxRetries: 0,
      stallMs: 3000,
      script: [
        { kind: "status", status: 429, headers: { "retry-after": "10" } },
        TEXT(8),
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("first question")], {
      clientTools: CLIENT_TOOLS
    });
    // Think waits out the 429's 10 s backoff; AIChatAgent ends the request.
    if (isThink(cls)) await untilEvent(cls, room, "chat:recovery:scheduled");
    else await tab.done(id, 20000);
    const id2 = tab.request(rid("req"), [user("second question")], {
      clientTools: CLIENT_TOOLS
    });
    const run = await finish(cls, room, [tab], {
      reqId: id.slice(0, 14),
      reqId2: id2.slice(0, 14)
    });
    // Think answers the recovered request before the one sent during its
    // backoff. AIChatAgent ended the first with an error.
    return roles(run, isThink(cls) ? "uaua" : "uua");
  },
  // Upgrade probes (D2): a recovery is live when the caller deploys a new version about 6 s after the start.
  async recStopDuringBackoffStall(cls: Cls) {
    // AIChatAgent has no backoff for stalls; a second stall inside a recovery
    // is chained. Stop by the original id just after the first stall.
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [STALL(3), { kind: "text", tokens: 60, delayMs: 80 }]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    await tab.waitFor(
      (x: Frame) => isResp(x) && x.id === id && x.body?.includes("w3 "),
      20000,
      "w3"
    );
    // Stop by the original id once the watchdog has called the stall.
    await untilEvent(cls, room, "chat:recovery:detected");
    tab.send({ type: MT.CANCEL, id });
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async recStopDuringStableWait(cls: Cls) {
    // stall with a client call pending: the attempt waits for stable state
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      stableTimeoutMs: 15000,
      script: [
        {
          kind: "tool",
          name: "getUserLocation",
          textBefore: 2,
          stallAfterTool: true
        },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("where am I")], {
      clientTools: CLIENT_TOOLS
    });
    await waitToolInput(tab, "getUserLocation");
    // The attempt is scheduled and then waits for the client's answer; no
    // event marks the wait itself.
    await untilEvent(cls, room, "chat:recovery:scheduled");
    tab.send({ type: MT.CANCEL, id });
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async recStopDuringStableWaitThenAnswer(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      stableTimeoutMs: 15000,
      script: [
        {
          kind: "tool",
          name: "getUserLocation",
          textBefore: 2,
          stallAfterTool: true
        },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("where am I")], {
      clientTools: CLIENT_TOOLS
    });
    const input = await waitToolInput(tab, "getUserLocation");
    // The attempt is scheduled and then waits for the client's answer; no
    // event marks the wait itself.
    await untilEvent(cls, room, "chat:recovery:scheduled");
    tab.send({ type: MT.CANCEL, id });
    // Answer after the stop has ended the request.
    await tab.waitFor(
      (f) =>
        isResp(f) &&
        f.id === id &&
        f.done === true &&
        f.outcome !== "recovering",
      20000,
      "stopped"
    );
    tab.send(toolResult(input.toolCallId, "getUserLocation"));
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },

  // ── verification round: new recovery rules ──
  async vTransientRunsAgain(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      transientInRecoveryOnce: true,
      script: [STALL(3), TEXT(8)]
    });
    tab.request(rid("req"), [user("hello")], { clientTools: CLIENT_TOOLS });
    return finish(cls, room, [tab], {}, { maxMs: 90000 });
  },

  async vTransientThenStopOrig(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      transientInRecoveryOnce: true,
      script: [STALL(3), TEXT(8)]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    // Stop once the attempt has thrown its transient error.
    await until(
      cls,
      room,
      (s) => hasNote(s, "threwTransient"),
      "transient thrown"
    );
    tab.send({ type: MT.CANCEL, id });
    return finish(
      cls,
      room,
      [tab],
      { reqId: id.slice(0, 14) },
      { maxMs: 90000 }
    );
  },
  async vStableTransientThenStop(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      transientInStableWaitOnce: true,
      stableTimeoutMs: 15000,
      script: [
        {
          kind: "tool",
          name: "getUserLocation",
          textBefore: 2,
          stallAfterTool: true
        },
        TEXT(8),
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("where am I")], {
      clientTools: CLIENT_TOOLS
    });
    await waitToolInput(tab, "getUserLocation");
    await until(
      cls,
      room,
      (s) => hasNote(s, "threwTransientInStableWait"),
      "transient in the stable wait"
    );
    tab.send({ type: MT.CANCEL, id });
    return finish(
      cls,
      room,
      [tab],
      { reqId: id.slice(0, 14) },
      { maxMs: 90000 }
    );
  },
  async vStableTransientThenAnswer(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      transientInStableWaitOnce: true,
      stableTimeoutMs: 15000,
      script: [
        {
          kind: "tool",
          name: "getUserLocation",
          textBefore: 2,
          stallAfterTool: true
        },
        TEXT(8),
        TEXT(8)
      ]
    });
    tab.request(rid("req"), [user("where am I")], {
      clientTools: CLIENT_TOOLS
    });
    const input = await waitToolInput(tab, "getUserLocation");
    await until(
      cls,
      room,
      (s) => hasNote(s, "threwTransientInStableWait"),
      "transient in the stable wait"
    );
    tab.send(toolResult(input.toolCallId, "getUserLocation"));
    return finish(cls, room, [tab], {}, { maxMs: 90000 });
  },

  async vResetDuringRecoveredTurn(cls: Cls) {
    // a reset cuts off the recovery attempt's own turn: the Task redelivers schedule 1 and the wake schedules again
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [
        STALL(3),
        { kind: "text", tokens: 40, delayMs: 80 },
        TEXT(8),
        TEXT(8),
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    await tab.waitFor(
      (x: Frame) => isResp(x) && x.id !== id && x.body?.includes("w5 "),
      30000,
      "recovered text"
    );
    await ctl(cls, room, "probeAbort");
    tab.close();
    const tab2 = await openTab(cls, room);
    tab2.send({ type: MT.RESUME_REQUEST });
    // The request the reset cut off is still answered.
    // Recovery's next turn is the script's TEXT(8).
    return answered(
      restarted(await finish(cls, room, [tab2], {}, { maxMs: 120000 })),
      "w8"
    );
  },
  async vResetDuringBackoff(cls: Cls) {
    // Think: a 429 schedules a recovery with a 10 s backoff; a reset during the wait, then a second interruption detected on restart
    const { room, tab } = await setup(cls, {
      classify: "rate_limit",
      maxRetries: 0,
      stallMs: 3000,
      script: [
        { kind: "tool", name: "getWeather", args: { city: "Paris" } },
        { kind: "status", status: 429, headers: { "retry-after": "10" } },
        TEXT(8),
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("weather")], {
      clientTools: CLIENT_TOOLS
    });
    // Reset inside Think's 10 s backoff; AIChatAgent ends the request first.
    if (isThink(cls)) await untilEvent(cls, room, "chat:recovery:scheduled");
    else await tab.done(id, 20000);
    await ctl(cls, room, "probeAbort");
    tab.close();
    const tab2 = await openTab(cls, room);
    tab2.send({ type: MT.RESUME_REQUEST });
    // The request the reset cut off is still answered.
    // Think retries after its backoff; AIChatAgent ends the turn on the 429.
    return answered(
      restarted(await finish(cls, room, [tab2], {}, { maxMs: 120000 })),
      isThink(cls) ? "w8" : undefined
    );
  },
  async vDeclineInAttempt(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      declineFromCall: 2,
      script: [STALL(3), STALL(3), TEXT(8)]
    });
    tab.request(rid("req"), [user("hello")], { clientTools: CLIENT_TOOLS });
    return finish(cls, room, [tab]);
  },
  async vStopR1DuringSecondWait(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      stableTimeoutMs: 15000,
      script: [
        STALL(3),
        {
          kind: "tool",
          name: "getUserLocation",
          textBefore: 1,
          stallAfterTool: true
        },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    const f = await tab.waitFor(
      (x: Frame) =>
        isResp(x) && x.id !== id && x.body?.includes("tool-input-available"),
      30000,
      "R1 tool"
    );
    // R1 stalls too, and the next attempt waits on the client's answer.
    await untilEvent(cls, room, "chat:recovery:attempt", 2);
    tab.send({ type: MT.CANCEL, id: f.id });
    return finish(cls, room, [tab], {
      reqId: id.slice(0, 14),
      r1: f.id?.slice(0, 14)
    });
  },
  async vStopR2Own(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [STALL(3), STALL(3), { kind: "text", tokens: 60, delayMs: 80 }]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    const r1 = await tab.waitFor(
      (x: Frame) =>
        isResp(x) && x.id !== id && x.body?.includes('"text-delta"'),
      30000,
      "R1"
    );
    const r2 = await tab.waitFor(
      (x: Frame) =>
        isResp(x) &&
        x.id !== id &&
        x.id !== r1.id &&
        x.body?.includes('"text-delta"'),
      30000,
      "R2"
    );
    await tab.waitFor(chunkOf(r2.id, "w3 "), 30000, "R2 w3");
    tab.send({ type: MT.CANCEL, id: r2.id });
    return endedAs(
      await finish(cls, room, [tab], { r2: r2.id?.slice(0, 14) }),
      r2.id,
      "aborted"
    );
  },
  async vStopR1DuringR2(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [STALL(3), STALL(3), { kind: "text", tokens: 60, delayMs: 80 }]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    const r1 = await tab.waitFor(
      (x: Frame) =>
        isResp(x) && x.id !== id && x.body?.includes('"text-delta"'),
      30000,
      "R1"
    );
    const r2 = await tab.waitFor(
      (x: Frame) =>
        isResp(x) &&
        x.id !== id &&
        x.id !== r1.id &&
        x.body?.includes('"text-delta"'),
      30000,
      "R2"
    );
    await tab.waitFor(chunkOf(r2.id, "w3 "), 30000, "R2 w3");
    tab.send({ type: MT.CANCEL, id: r1.id });
    return finish(cls, room, [tab], { r1: r1.id?.slice(0, 14) });
  },
  async vStopOrigDuringR2(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      script: [STALL(3), STALL(3), { kind: "text", tokens: 60, delayMs: 80 }]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    const r1 = await tab.waitFor(
      (x: Frame) =>
        isResp(x) && x.id !== id && x.body?.includes('"text-delta"'),
      30000,
      "R1"
    );
    const r2 = await tab.waitFor(
      (x: Frame) =>
        isResp(x) &&
        x.id !== id &&
        x.id !== r1.id &&
        x.body?.includes('"text-delta"'),
      30000,
      "R2"
    );
    await tab.waitFor(chunkOf(r2.id, "w3 "), 30000, "R2 w3");
    tab.send({ type: MT.CANCEL, id });
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async vStopR1DuringBackoff(cls: Cls) {
    const { room, tab } = await setup(cls, {
      stallMs: 3000,
      classify: "rate_limit",
      maxRetries: 0,
      script: [
        STALL(3),
        { kind: "status", status: 429, headers: { "retry-after": "10" } },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("hello")], {
      clientTools: CLIENT_TOOLS
    });
    const f = await tab.waitFor(
      (x: Frame) => isResp(x) && x.id !== id,
      30000,
      "R1 frame"
    );
    // R1's model call got the 429: stop R1 inside its backoff.
    await untilEvent(cls, room, "chat:recovery:scheduled", 2);
    tab.send({ type: MT.CANCEL, id: f.id });
    // As above: quiet past the 10 s backoff.
    return finish(
      cls,
      room,
      [tab],
      { r1: f.id?.slice(0, 14) },
      { quietMs: 12_000 }
    );
  },

  // ── 5. D32, D21, connection-less continuation ──
  async d32StopWaitingContinuation(cls: Cls) {
    const { room, tab } = await setup(cls, {
      script: [
        {
          kind: "tool",
          name: "getUserLocation",
          textBefore: 2,
          textAfter: 40,
          delayMs: 60
        },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("where")], {
      clientTools: CLIENT_TOOLS
    });
    const input = await waitToolInput(tab, "getUserLocation");
    tab.send(toolResult(input.toolCallId, "getUserLocation"));
    // Stop while the step still streams its text after the call, so the
    // continuation is waiting.
    await tab.waitFor(chunkOf(id, "a3 "), 20000, "a3");
    tab.send({ type: MT.CANCEL, id });
    await tab.done(id, 20000).catch(() => {});
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async d32ResultAfterStop(cls: Cls) {
    const { room, tab } = await setup(cls, {
      script: [
        {
          kind: "tool",
          name: "getUserLocation",
          textBefore: 2,
          textAfter: 40,
          delayMs: 60
        },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("where")], {
      clientTools: CLIENT_TOOLS
    });
    const input = await waitToolInput(tab, "getUserLocation");
    await tab.waitFor(chunkOf(id, "a3 "), 20000, "a3");
    tab.send({ type: MT.CANCEL, id });
    await tab.done(id, 20000);
    tab.send(toolResult(input.toolCallId, "getUserLocation"));
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async d21AbortAllNoSignal(cls: Cls) {
    const { room, tab } = await setup(cls, {
      abortAllInOnChatMessageMs: 300,
      passSignal: false,
      script: [{ kind: "text", tokens: 40, delayMs: 60 }]
    });
    const id = tab.request(rid("req"), [user("hello")]);
    await tab.done(id, 20000).catch(() => {});
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async d21AbortAllSignal(cls: Cls) {
    const { room, tab } = await setup(cls, {
      abortAllInOnChatMessageMs: 300,
      script: [{ kind: "text", tokens: 40, delayMs: 60 }]
    });
    const id = tab.request(rid("req"), [user("hello")]);
    await tab.done(id, 20000).catch(() => {});
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async d21AbortAllRpcDuring(cls: Cls) {
    // abortAllRequests() over RPC while the stream runs (not inside onChatMessage)
    const { room, tab } = await setup(cls, {
      passSignal: false,
      script: [{ kind: "text", tokens: 40, delayMs: 60 }]
    });
    const id = tab.request(rid("req"), [user("hello")]);
    await tab.waitFor(
      (f: Frame) => isResp(f) && f.id === id && f.body?.includes("w3 "),
      20000,
      "w3"
    );
    await ctl(cls, room, "probeAbortAll");
    await tab.done(id, 20000).catch(() => {});
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
  },
  async approveRpc(cls: Cls) {
    const { room, tab } = await setup(cls, {
      script: [
        { kind: "tool", name: "pauseAction", args: { message: "hi" } },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("pause please")]);
    await tab.done(id, 20000);
    const pending = await untilPending(cls, room);
    const execId = firstExecutionId(pending);
    tab.close();
    const approved = execId
      ? await ctl(cls, room, "probeApprove", execId)
      : { ok: false, error: "no pending" };
    return approvedRan(
      await finish(cls, room, [tab], {
        pending: pending.value ?? pending.error,
        approved: approved.value ?? approved.error
      }),
      approved,
      "completed"
    );
  },
  async approveRpcStop(cls: Cls) {
    // approve over RPC, then abortAllRequests while the connection-less continuation streams
    const { room, tab } = await setup(cls, {
      script: [
        { kind: "tool", name: "pauseAction", args: { message: "hi" } },
        TEXT(3),
        { kind: "text", tokens: 60, delayMs: 80 },
        TEXT(8)
      ]
    });
    const id = tab.request(rid("req"), [user("pause please")]);
    await tab.done(id, 20000);
    const pending = await untilPending(cls, room);
    const execId = firstExecutionId(pending);
    // No tab: the approved action continues without a connection.
    tab.close();
    const approvedP = execId
      ? ctl(cls, room, "probeApprove", execId)
      : Promise.resolve<CtlResult>({ ok: false, error: "no pending" });
    // Stop while the continuation streams its slow reply (script step 2).
    await until(
      cls,
      room,
      (s) => s.calls.some((c) => c.idx === 2),
      "the slow reply"
    );
    await ctl(cls, room, "probeAbortAll");
    const approved = await approvedP;
    return approvedRan(
      await finish(cls, room, [tab], {
        approved: approved.value ?? approved.error
      }),
      approved,
      "aborted"
    );
  }
};

/** Scenarios only one class has the feature for. */
export const THINK_ONLY = new Set(
  Object.keys(SCENARIOS).filter(
    (k) =>
      k.startsWith("ov") ||
      k.startsWith("stallChatRpc") ||
      k.startsWith("approve") ||
      k === "recStopDuringBackoff" ||
      k === "vStopR1DuringBackoff" ||
      k.startsWith("rl429Transient")
  )
);
export const CHAT_ONLY = new Set(["d21AbortAllNoSignal", "d21AbortAllSignal"]);
