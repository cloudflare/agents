// The Think soak: long conversations on a real Workers AI model, each turn a
// different kind (plain, a server tool, a client tool the tab answers, a tool
// that needs approval, a submission), with resets in the middle of replies.
// The model's words are never checked; what must hold is what the fault
// suite checks plus: every message the user sent is in the transcript once,
// every one is answered, no tool call ran twice, every submission completed.

import { appendFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";
import { violations } from "../faults/invariants";
import type { Run } from "../faults/scenarios";
import {
  CLIENT_TOOLS,
  MT,
  Tab,
  ctl,
  isResp,
  rid,
  settle,
  user,
  type Frame
} from "../shared/probe";

type Kind =
  | "plain"
  | "weather"
  | "client"
  | "approve"
  | "submit"
  | "extension"
  | "helper";
const KINDS: Kind[] = [
  "plain",
  "weather",
  "client",
  "approve",
  "submit",
  "extension",
  "helper"
];
const TURNS = 14;
/** Turns whose reply is cut off by a reset once it has started. */
const RESETS = new Set([4, 9, 11]);
const ROOMS = 3;

function prompt(kind: Kind, turn: number): string {
  switch (kind) {
    case "plain":
      return `Turn ${turn}: name one fact about the number ${turn * 3}.`;
    case "weather":
      return `Turn ${turn}: what is the weather in Lisbon? Use getWeather.`;
    case "client":
      return `Turn ${turn}: where am I? Use getUserLocation.`;
    case "approve":
      return `Turn ${turn}: delete the file /tmp/soak-${turn}.txt with deleteFile.`;
    case "submit":
      return `Turn ${turn}: say the word "queued".`;
    case "extension":
      return `Turn ${turn}: roll a six-sided die with the dice_rollDie tool and tell me the result.`;
    case "helper":
      return `Turn ${turn}: ask the helper agent what the capital of France is, using askHelper.`;
  }
}

async function open(room: string): Promise<Tab> {
  const tab = await new Tab("think", room).open();
  await tab.waitFor((f) => f.type === MT.IDENTITY, 30_000, "identity");
  return tab;
}

/** Answer the client tool and approve the deletion as a person at the tab would. */
const CLIENT_OUTPUTS: Record<string, unknown> = {
  getUserLocation: { city: "Lisbon" },
  getUserTimezone: { timezone: "Europe/Lisbon" }
};

function answer(tab: Tab, handled: Set<string>) {
  for (const f of tab.frames) {
    // The client answers either of its tools, whichever the model calls.
    if (isResp(f) && f.body?.includes('"tool-input-available"')) {
      const { toolCallId, toolName } = JSON.parse(f.body) as {
        toolCallId: string;
        toolName: string;
      };
      const output = CLIENT_OUTPUTS[toolName];
      if (!output || handled.has(toolCallId)) continue;
      handled.add(toolCallId);
      tab.send({
        type: MT.TOOL_RESULT,
        toolCallId,
        toolName,
        output,
        autoContinue: true,
        clientTools: CLIENT_TOOLS
      });
    }
    for (const m of f.type === "cf_agent_chat_messages"
      ? (f.messages ?? [])
      : []) {
      for (const part of m.parts as {
        type: string;
        state?: string;
        toolCallId?: string;
      }[]) {
        if (
          part.state !== "approval-requested" ||
          !part.toolCallId ||
          handled.has(part.toolCallId)
        )
          continue;
        handled.add(part.toolCallId);
        tab.send({
          type: MT.TOOL_APPROVAL,
          toolCallId: part.toolCallId,
          approved: true,
          autoContinue: true
        });
      }
    }
  }
}

/** Progress, for whoever watches a long run: SOAK_LOG=<file>. */
function progress(line: string) {
  if (process.env.SOAK_LOG)
    appendFileSync(
      process.env.SOAK_LOG,
      `${new Date().toISOString()} ${line}\n`
    );
}

/**
 * The turn for `text` has a finished reply: the assistant messages after it
 * (a tool's continuation can add one) hold text, and no tool waits on the user.
 */
function answeredTurn(state: Run["state"], text: string): boolean {
  const i = state.messages.findIndex(
    (m) =>
      m.role === "user" &&
      m.parts.some((p) => p.type === "text" && p.text === text)
  );
  if (i < 0) return false;
  const parts: { type: string; text?: string; state?: string }[] = [];
  for (const m of state.messages.slice(i + 1)) {
    if (m.role !== "assistant") break;
    parts.push(
      ...(m.parts as { type: string; text?: string; state?: string }[])
    );
  }
  return (
    parts.some((p) => p.type === "text" && Boolean(p.text?.trim())) &&
    !parts.some(
      (p) => p.state === "approval-requested" || p.state === "input-available"
    )
  );
}

/**
 * Until this turn is answered and the room is quiet, answering the tab's
 * tools as a person would while it runs.
 */
async function drain(
  room: string,
  tab: Tab,
  handled: Set<string>,
  text: string
) {
  const start = Date.now();
  for (;;) {
    answer(tab, handled);
    const state = await settle("think", room, { quietMs: 2000, maxMs: 60_000 });
    if (answeredTurn(state, text)) break;
    progress(
      `${room} waiting: ${state.messages.map((m) => m.role[0]).join("")} ${JSON.stringify(state.messages.at(-1)?.parts.map((p) => p.type + ((p as { state?: string }).state ? `:${(p as { state?: string }).state}` : "")))}`
    );
    if (Date.now() - start > 300_000) break; // the checks report what is missing
  }
  answer(tab, handled);
  return settle("think", room, { quietMs: 6000, maxMs: 240_000 });
}

async function soak(room: string): Promise<{ run: Run; sent: string[] }> {
  const sent: string[] = [];
  const handled = new Set<string>();
  let tab = await open(room);
  // Every tab's requests and frames, for the done-frame checks. A request
  // cut off by a reset never ends on the tab that sent it (its reply ends on
  // the next tab, as a replay), so it is left out of that tab's list.
  const tabs: { sent: string[]; frames: Frame[] }[] = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    const kind = KINDS[(turn - 1) % KINDS.length];
    const text = prompt(kind, turn);
    sent.push(text);
    progress(`${room} turn ${turn} ${kind}`);
    if (kind === "submit") {
      const r = await ctl("think", room, "probeSubmit", text);
      if (!r.ok) throw new Error(`submit: ${r.error}`);
    } else {
      const id = tab.request(rid("req"), [user(text)], {
        clientTools: CLIENT_TOOLS
      });
      if (RESETS.has(turn)) {
        // Cut the reply off once it streams, then come back as a new tab.
        await tab.waitFor(
          (f: Frame) =>
            isResp(f) && f.id === id && Boolean(f.body?.includes("delta")),
          120_000,
          "the reply to start"
        );
        await ctl("think", room, "probeAbort");
        tab.close();
        tabs.push({
          sent: tab.sent.filter((s) => s !== id),
          frames: tab.frames
        });
        tab = await open(room);
        tab.send({ type: MT.RESUME_REQUEST });
      }
    }
    await drain(room, tab, handled, text);
  }
  const state = await settle("think", room, { quietMs: 6000, maxMs: 240_000 });
  tab.close();
  tabs.push({ sent: tab.sent, frames: tab.frames });
  const late = await open(room);
  late.send({ type: MT.RESUME_REQUEST });
  const offer = await late
    .waitFor(
      (f) => f.type === MT.RESUME_NONE || f.type === MT.RESUMING,
      15_000,
      "resume reply"
    )
    .catch(() => undefined);
  // An offered stream is taken (the tab acknowledges it) and replayed to
  // its end before the tab goes.
  if (offer?.type === MT.RESUMING) {
    await late
      .waitFor(
        // A done frame handing the stream to recovery is not its end.
        (f) =>
          f.type === MT.RESPONSE &&
          f.id === offer.id &&
          Boolean(f.done) &&
          f.outcome !== "recovering",
        60_000,
        "the replay to end"
      )
      .catch(() => undefined);
  }
  late.close();
  return {
    run: { state, tabs, lateTab: late.frames, extra: {}, checks: [] },
    sent
  };
}

// The rooms run at once: each is its own object, and the whole soak is bounded
// by one room (the test timeout, 30 minutes).
describe.concurrent("Think on a real model, through resets", () => {
  for (let n = 1; n <= ROOMS; n++) {
    it(`room ${n}: ${TURNS} turns, every one answered, nothing lost or run twice`, async () => {
      process.env.PROBE_URL = inject("probeUrl");
      process.env.PROBE_KEY = inject("probeKey");
      const room = `soak-${n}-${Date.now()}`;
      const { run, sent } = await soak(room);
      const state = run.state as Run["state"] & {
        runs: { kind: string; id: string; n: number }[];
        submissions: string[];
      };
      const texts = state.messages
        .filter((m) => m.role === "user")
        .map((m) =>
          m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
        );
      const report = JSON.stringify({
        roles: state.messages.map((m) => m.role[0]).join(""),
        runs: state.runs,
        submissions: state.submissions
      });
      // Every message sent is in the transcript, once, in order.
      expect(texts, report).toEqual(sent);
      // Every one is answered with text, and no tool waits on the user.
      expect(
        sent.filter((text) => !answeredTurn(state, text)),
        report
      ).toEqual([]);
      // The weather turns used their tool (a real model may answer one in
      // prose; it may not skip them all). The approval turns are the reset
      // turns, where the model may answer the restart instead of calling
      // deleteFile, so those are checked by the run counts, not here.
      expect(
        state.runs.some((r) => r.kind === "getWeather"),
        report
      ).toBe(true);
      // No tool call ran twice.
      expect(
        state.runs.filter((r) => r.n > 1),
        report
      ).toEqual([]);
      // The extension loaded from source served its tool, and the helper
      // sub-agent (a facet of the room) was asked, at least once a room.
      for (const part of ["tool-dice_rollDie", "tool-askHelper"])
        expect(
          state.messages.some((m) =>
            m.parts.some(
              (p) =>
                p.type === part &&
                (p as { state?: string }).state === "output-available"
            )
          ),
          `${part}: ${report}`
        ).toBe(true);
      // One submission record per submitted turn, each completed.
      expect(state.submissions, report).toEqual(
        sent
          .filter((_, i) => KINDS[i % KINDS.length] === "submit")
          .map(() => "completed")
      );
      // The resets happened, and each cut a reply off: recovery took it up.
      expect(state.starts, report).toBeGreaterThanOrEqual(1 + RESETS.size);
      expect(
        state.events.filter((e) => e.type === "chat:recovery:detected").length,
        report
      ).toBeGreaterThanOrEqual(RESETS.size);
      expect(violations(run), report).toEqual([]);
    });
  }
});
