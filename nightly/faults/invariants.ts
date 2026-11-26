// What must hold after every fault scenario, whatever the scenario's own
// outcome: the rules verify checks (one terminal per request, nothing lost,
// nothing left running). A scenario adds its own expectations in
// `run.checks`.

import type { UIMessage } from "ai";
import { MT, recoveryBalance, type Frame } from "./lib";
import type { Run } from "./scenarios";

function isEmptyAssistant(m: UIMessage): boolean {
  if (m.role !== "assistant") return false;
  return m.parts.every(
    (p) => p.type === "step-start" || (p.type === "text" && !p.text.trim())
  );
}

/** The last assistant message waits on the client: a tool call to answer or approve. */
function awaitsClient(messages: UIMessage[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return (last?.parts ?? []).some((p) => {
    const state = (p as { state?: string }).state;
    return (
      (p.type.startsWith("tool-") || p.type === "dynamic-tool") &&
      (state === "input-available" || state === "approval-requested")
    );
  });
}

/**
 * The tab's rule breaks. A `done` frame with outcome `recovering` hands its
 * request to recovery; it is not the request's end. The end comes once,
 * later, under the request's own id or under a continuation the server
 * started (an id the tab did not send). An end of another request the tab
 * sent does not close a hand-off.
 */
function tabViolations(
  n: number,
  tab: { sent: string[]; frames: Frame[] },
  messages: UIMessage[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const ends = new Map<string, number>();
  const handedOff: string[] = [];
  for (const f of tab.frames) {
    if (f.type !== MT.RESPONSE || !f.done || !f.id) continue;
    seen.add(f.id);
    if (f.outcome === "recovering") {
      if (!handedOff.includes(f.id)) handedOff.push(f.id);
      continue;
    }
    ends.set(f.id, (ends.get(f.id) ?? 0) + 1);
    const own = handedOff.indexOf(f.id);
    if (own >= 0) handedOff.splice(own, 1);
    else if (!tab.sent.includes(f.id)) handedOff.shift();
  }
  // A recovery that finds the turn waiting on the client leaves it
  // waiting: the client's answer continues it.
  if (handedOff.length && !awaitsClient(messages)) {
    out.push(
      `tab ${n}: ${handedOff.join(", ")} handed to recovery and never ended`
    );
  }
  for (const id of tab.sent) {
    if (!seen.has(id))
      out.push(`tab ${n}: request ${id} never got a done frame`);
  }
  for (const [id, count] of ends) {
    if (count > 1) out.push(`tab ${n}: request ${id} ended ${count} times`);
  }
  return out;
}

/** Every rule the run breaks, as one line each. Empty when it is clean. */
export function violations(run: Run): string[] {
  const out: string[] = [];
  const { state } = run;
  if (state.unsettled)
    out.push(
      "did not settle: the transcript or events kept changing, or a recovery stayed open"
    );

  const { open, twice } = recoveryBalance(state.events);
  if (open.length) out.push(`recoveries never ended: ${open.join(", ")}`);
  if (twice.length) out.push(`recoveries ended twice: ${twice.join(", ")}`);

  const ids = state.messages.map((m) => m.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length)
    out.push(`duplicate message ids: ${[...new Set(dup)].join(", ")}`);
  if (state.messages.some(isEmptyAssistant))
    out.push("an assistant message with no content");

  run.tabs.forEach((tab, n) =>
    out.push(...tabViolations(n, tab, state.messages))
  );

  // A tab that comes back after everything settled is told whether a
  // stream is there, and an offered stream is replayed to its end.
  const offer = run.lateTab.find(
    (f) => f.type === MT.RESUME_NONE || f.type === MT.RESUMING
  );
  if (!offer) out.push("late tab: no answer to its resume request");
  else if (
    offer.type === MT.RESUMING &&
    !run.lateTab.some(
      (f) => f.type === MT.RESPONSE && f.id === offer.id && f.done
    )
  ) {
    out.push(
      `late tab: offered stream ${offer.id} was not replayed to its end`
    );
  }

  out.push(...run.checks);
  return out;
}
