/**
 * DEMO MODULE — Channel: a terminal as a first-class surface.
 *
 * Both directions of a human-at-a-TTY conversation, packaged as one Channel
 * value. Inbound: readline lines become user-message entries through the
 * Inbox; slash commands become `tools/approval-verdict` and
 * `tools/settlement` entries the same way — an approval UI is just another
 * channel appending entries, no host surface required. Outbound display
 * rides the ephemeral half (ADR 0005): the host hands the channel a live
 * tail, and everything renders the moment it hits the log — streamed model
 * deltas, tool calls and results, pass-through entries (plans, debate
 * arguments, summaries) with attribution, approval banners, failures.
 *
 * A remote surface keeps this exact shape and adds the durable half: a
 * Telegram channel would send the final message from its `outbound` consumer
 * (delivery of record, redelivered after a crash) and use `live` to edit a
 * draft message as deltas arrive; a web-socket channel replays from its
 * consumer cursor on reconnect and streams from `live` while connected. A
 * TTY has no message identity to reconcile and a human watching, so this
 * channel uses `live` alone.
 */

import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline";
import type {
  Channel,
  EffectClaimedPayload,
  EffectSettledPayload,
  Entry,
  Inbox,
  Json,
  MessagePayload,
  NewEntry,
  Part,
  TailEvent,
  TurnMarkerPayload
} from "../../contract.js";
import type {
  ApprovalRequestedPayload,
  ApprovalVerdictPayload,
  ToolSettlementPayload
} from "../../tools/runtime.js";
import { uuid } from "../../ids.js";
import type { ArgumentPayload } from "../loops/debater.js";
import type { PlanNotePayload, PlanPayload } from "../loops/planner.js";
import type { SummaryPayload } from "../context/compactor.js";

const COMMANDS = `Commands:
  /approve [call-id]   grant the newest (or the named) approval request
  /reject [call-id]    reject it
  /settle <call-id> <answer>
                       play the outside world: settle a pending effect
  /help                show this text
  /quit                exit

Call ids accept any unique prefix.
`;

export interface TerminalChannelOptions {
  readonly name?: string;
  /** Appended to the notice printed when a message admits no turn. */
  readonly noTurnHint?: string;
}

export interface TerminalChannel extends Channel {
  /** Print the first prompt. Call after any composition-edge preamble. */
  begin(): void;
  /** Resolves when the user quits or stdin closes. */
  readonly done: Promise<void>;
}

export function terminalChannel(
  opts: TerminalChannelOptions = {}
): TerminalChannel {
  const name = opts.name ?? "terminal";
  let inbox: Inbox | null = null;
  let began = false;
  let closed = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  // ---- display state (fed by the live tail) -------------------------------

  /** "text" | "reasoning" when an unterminated streaming line is on screen. */
  let lineOpen: "text" | "reasoning" | null = null;
  /** Text deltas streamed since the last committed generation — the entry
   * that follows them is already on screen and must not reprint. */
  let streamedSegment = false;
  /** Anything rendered; lets input handling detect "nothing happened". */
  let events = 0;
  /** turn/marker admitted count; detects a message the policy ignored. */
  let admissions = 0;
  const callNames = new Map<string, string>();
  /** Open approval requests by callId (the entry carries turn+correlation). */
  const approvals = new Map<string, Entry>();
  /** Open pending effects by callId. */
  const pending = new Map<string, { correlation: string; effect: string }>();
  const claimKeyToCall = new Map<string, string>();
  const hinted = new Set<string>();

  const dim = (s: string) => (stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  const short = (value: unknown, max = 96): string => {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  const textOf = (parts: readonly Part[]): string =>
    parts
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");

  function closeLine(): void {
    if (lineOpen !== null) {
      stdout.write("\n");
      lineOpen = null;
    }
  }

  function note(text: string): void {
    closeLine();
    stdout.write(`${dim(text)}\n`);
  }

  const terminal: Interface = createInterface({
    input: stdin,
    output: stdout,
    prompt: "You> "
  });
  terminal.on("close", () => {
    closed = true;
  });

  function prompt(): void {
    if (began && !closed) terminal.prompt();
  }

  // ---- outbound display: render the live tail -----------------------------

  function renderChunk(chunk: Json): void {
    events += 1;
    const c = chunk as {
      type?: string;
      delta?: string;
      callId?: string;
      name?: string;
      input?: Json;
    };
    if (c.type === "text-delta" && typeof c.delta === "string") {
      if (lineOpen !== "text") {
        closeLine();
        stdout.write("Agent> ");
        lineOpen = "text";
      }
      stdout.write(c.delta);
      streamedSegment = true;
    } else if (c.type === "reasoning-delta" && typeof c.delta === "string") {
      if (lineOpen !== "reasoning") {
        closeLine();
        stdout.write(dim("(thinking) "));
        lineOpen = "reasoning";
      }
      stdout.write(dim(c.delta));
    } else if (c.type === "tool-call" && typeof c.name === "string") {
      if (c.callId !== undefined) callNames.set(c.callId, c.name);
      note(`· calling ${c.name} ${short(c.input ?? {})}`);
    }
  }

  function renderEntry(entry: Entry): void {
    const kind = entry.payload.kind;
    if (kind === "message") {
      const m = entry.payload as MessagePayload;
      if (m.role === "user") return; // typed right here; already on screen
      events += 1;
      if (m.role === "assistant") {
        for (const p of m.parts) {
          if (p.type === "tool-call") callNames.set(p.callId, p.name);
        }
        const text = textOf(m.parts);
        if (streamedSegment) closeLine();
        else if (text.length > 0) stdout.write(`Agent> ${text}\n`);
        streamedSegment = false;
        return;
      }
      if (m.role === "tool") {
        for (const p of m.parts) {
          if (p.type !== "tool-result") continue;
          const toolName = callNames.get(p.callId) ?? p.callId;
          const err = p.isError === true ? " (error)" : "";
          note(`· ${toolName} → ${short(p.output)}${err}`);
        }
      }
      return;
    }
    events += 1;
    switch (kind) {
      // Pass-through entries from the demo loops/context: when their content
      // just streamed, print only an attribution line under it.
      case "debater/argument": {
        const a = entry.payload as ArgumentPayload;
        if (streamedSegment) {
          closeLine();
          stdout.write(dim(`  ↳ debater/argument — ${a.persona}\n`));
        } else {
          note(`· debater/argument — ${a.persona}: ${short(a.position)}`);
        }
        streamedSegment = false;
        return;
      }
      case "planner/plan": {
        const p = entry.payload as PlanPayload;
        if (streamedSegment) {
          closeLine();
          stdout.write(
            dim(
              `  ↳ planner/plan — ${p.steps.length} step${p.steps.length === 1 ? "" : "s"}\n`
            )
          );
        } else {
          note(`· planner/plan — ${p.done}/${p.steps.length} done`);
        }
        streamedSegment = false;
        return;
      }
      case "planner/note": {
        const p = entry.payload as PlanNotePayload;
        if (streamedSegment) {
          closeLine();
          stdout.write(dim(`  ↳ planner/note — step ${p.step}\n`));
        } else {
          note(`· planner/note (step ${p.step}): ${short(p.note)}`);
        }
        streamedSegment = false;
        return;
      }
      case "compactor/summary": {
        const s = entry.payload as SummaryPayload;
        note(`· compactor/summary — folded history: ${short(s.summary, 80)}`);
        return;
      }
      case "tools/approval-requested": {
        const r = entry.payload as ApprovalRequestedPayload;
        approvals.set(r.callId, entry);
        closeLine();
        stdout.write(`Approval required — ${r.descriptor.title}\n`);
        if (r.descriptor.detail !== undefined) {
          stdout.write(dim(`  ${r.descriptor.detail}\n`));
        }
        stdout.write(
          dim(`  /approve or /reject resolves it (call ${r.callId})\n`)
        );
        return;
      }
      case "tools/approval-verdict": {
        const v = entry.payload as ApprovalVerdictPayload;
        approvals.delete(v.callId);
        note(`· approval ${v.verdict}`);
        return;
      }
      case "effect/claimed": {
        const c = entry.payload as EffectClaimedPayload;
        const correlation = String(entry.correlation ?? "");
        if (correlation.startsWith("tool:")) {
          const callId = correlation.slice("tool:".length);
          pending.set(callId, { correlation, effect: c.effect });
          claimKeyToCall.set(String(c.key), callId);
        }
        return;
      }
      case "effect/settled": {
        const s = entry.payload as EffectSettledPayload;
        const callId = claimKeyToCall.get(String(s.key));
        if (callId !== undefined) pending.delete(callId);
        return;
      }
      case "turn/marker": {
        const m = entry.payload as TurnMarkerPayload;
        const detail = (m.detail ?? {}) as {
          reason?: string;
          message?: string;
        };
        if (m.marker === "admitted") {
          admissions += 1;
        } else if (m.marker === "failed") {
          closeLine();
          stdout.write(
            `✗ turn failed (${detail.reason ?? "unknown"}): ${detail.message ?? ""}\n`
          );
          streamedSegment = false;
          prompt();
        } else if (m.marker === "parked") {
          if (detail.reason?.startsWith("pending effect") === true) {
            hintPending();
          }
          prompt();
        } else if (m.marker === "completed") {
          closeLine();
          streamedSegment = false;
          prompt();
        }
        return;
      }
      default:
        return; // tolerant reader: unrendered kinds pass through silently
    }
  }

  /** A turn parked on a pending effect: tell the user how to be the world. */
  function hintPending(): void {
    for (const [callId, claim] of pending) {
      if (hinted.has(callId)) continue;
      hinted.add(callId);
      const effect = claim.effect.replace(/^tool\//, "");
      closeLine();
      stdout.write(`Waiting on ${effect} — its answer arrives from outside.\n`);
      stdout.write(
        dim(`  Play the outside world: /settle ${callId} <answer>\n`)
      );
    }
  }

  // ---- inbound: lines and commands become entries -------------------------

  const macrotask = () =>
    new Promise<void>((resolveTask) => setImmediate(resolveTask));

  /** Call ids accept any unique prefix. */
  function resolveId(prefix: string, known: Iterable<string>): string {
    const matches = [...known].filter((k) => k.startsWith(prefix));
    return matches.length === 1 ? matches[0] : prefix;
  }

  async function submit(entry: NewEntry, idempotencyKey?: string) {
    if (inbox === null) throw new Error("channel not started");
    const result = await inbox.submit(
      [entry],
      idempotencyKey !== undefined ? { idempotencyKey } : {}
    );
    if (result.outcome === "conflict") {
      throw new Error("inbox submit conflicted");
    }
  }

  async function runCommand(
    verb: string,
    id: string | undefined,
    rest: string | undefined
  ): Promise<void> {
    const before = events;
    if (verb === "settle") {
      if (id === undefined) {
        stdout.write("Usage: /settle <call-id> <answer>\n");
        prompt();
        return;
      }
      const callId = resolveId(id, pending.keys());
      const claim = pending.get(callId);
      if (claim === undefined) {
        stdout.write(`No pending effect matches "${id}".\n`);
        prompt();
        return;
      }
      const payload: ToolSettlementPayload = {
        kind: "tools/settlement",
        v: 1,
        output: (rest ?? "") as ToolSettlementPayload["output"]
      };
      await submit({
        origin: { module: "channel", instance: name },
        correlation: claim.correlation,
        payload
      } as unknown as NewEntry);
    } else {
      const callId =
        id !== undefined
          ? resolveId(id, approvals.keys())
          : [...approvals.keys()].pop();
      const request = callId !== undefined ? approvals.get(callId) : undefined;
      if (callId === undefined || request === undefined) {
        stdout.write(
          id === undefined
            ? "No open approval requests.\n"
            : `No open approval matches "${id}".\n`
        );
        prompt();
        return;
      }
      const payload: ApprovalVerdictPayload = {
        kind: "tools/approval-verdict",
        v: 1,
        callId,
        verdict: verb === "approve" ? "granted" : "rejected"
      };
      const entry: Record<string, unknown> = {
        origin: { module: "channel", instance: name },
        correlation: request.correlation,
        payload
      };
      if (request.turn !== undefined) entry.turn = request.turn;
      await submit(entry as unknown as NewEntry, `approval-verdict:${callId}`);
    }
    // If the entry moved nothing (e.g. a duplicate verdict), re-prompt here;
    // otherwise the resumed turn's own quiescence marker prompts.
    await macrotask();
    if (events === before) prompt();
  }

  async function handleLine(raw: string): Promise<void> {
    const message = raw.trim();
    if (message.length === 0) {
      prompt();
      return;
    }
    if (message === "/quit" || message === "/exit") {
      terminal.close();
      return;
    }
    if (message === "/help") {
      stdout.write(COMMANDS);
      prompt();
      return;
    }
    try {
      const command = message.match(
        /^\/(approve|reject|settle)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/
      );
      if (command !== null) {
        await runCommand(command[1], command[2], command[3]);
        return;
      }
      if (message.startsWith("/")) {
        stdout.write(`Unknown command ${message.split(/\s/)[0]}; try /help\n`);
        prompt();
        return;
      }
      const admissionsBefore = admissions;
      const payload: MessagePayload = {
        kind: "message",
        v: 1,
        role: "user",
        parts: [{ type: "text", text: message }]
      };
      await submit(
        {
          origin: { module: "channel", instance: name },
          payload
        } as unknown as NewEntry,
        `${name}:${uuid()}`
      );
      // Admission is log-visible (the runtime's "admitted" marker) and does
      // not wait on any model, so one macrotask settles the question.
      await macrotask();
      if (admissions === admissionsBefore) {
        note(`· logged, but no turn was admitted${opts.noTurnHint ?? ""}`);
        prompt();
      }
    } catch (error) {
      closeLine();
      stdout.write(
        `Error: ${error instanceof Error ? error.message : String(error)}\n`
      );
      prompt();
    }
  }

  // ---- the Channel value --------------------------------------------------

  return {
    name,
    done,
    start(i: Inbox) {
      inbox = i;
      void (async () => {
        for await (const line of terminal) {
          await handleLine(line);
        }
        resolveDone();
      })();
    },
    live(tail: AsyncIterable<TailEvent>) {
      // The for-await's first next() registers the tail listener
      // synchronously, before the host's wake-scan microtasks run — so a
      // re-driven interrupted turn streams from its first delta.
      void (async () => {
        try {
          for await (const event of tail) {
            if (event.type === "chunk") renderChunk(event.chunk.chunk);
            else renderEntry(event.entry);
          }
        } catch {
          // the process is exiting; the tail ends with it
        }
      })();
    },
    begin() {
      began = true;
      prompt();
    }
  };
}
