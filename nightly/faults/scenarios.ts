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
  rid,
  settle,
  sleep,
  state,
  user,
  type Cls,
  type Frame,
  type ProbeState
} from "./lib";

/** One scenario's outcome: the settled state and every frame each tab saw. */
export type Run = {
  state: ProbeState & { unsettled: boolean };
  tabs: { sent: string[]; frames: Frame[] }[];
  /** A tab opened after everything settled: what a returning client sees. */
  lateTab: Frame[];
  extra: Record<string, unknown>;
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
  const s = await settle(cls, room, settleOpts);
  // The frames that end the tabs' requests may still be on the wire; the
  // invariants judge what has not arrived within the bound.
  const deadline = Date.now() + 10_000;
  while (!tabs.every(tabSettled) && Date.now() < deadline) await sleep(200);
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
        (f) => isResp(f) && f.id === offer.id && f.done === true,
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
    extra
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
    return finish(cls, room, [tab], { reqId: id.slice(0, 14) });
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
    return finish(cls, room, [tab]);
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
    return finish(cls, room, [tab]);
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
    return finish(cls, room, [tab]);
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
