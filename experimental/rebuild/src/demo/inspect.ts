#!/usr/bin/env node

/**
 * Read a session log back — the introspection half of "the log is the
 * snapshot". Everything the agent did is an entry, so a plain chronological
 * dump answers questions the terminal cannot: did the model's own answer
 * arrive truncated, or did the display cut it off? Did the turn complete or
 * fail, and with what reason? Which effects were claimed, and did each one
 * settle?
 *
 * It reads through the Engine's own LogExport.scan, so this shows exactly
 * what a cold reader — a recovering host, a support tool — would see. What
 * is NOT here is equally informative: streamed chunks are ephemeral and
 * never committed, so anything visible on screen but absent below existed
 * only in flight.
 */

import { parseArgs } from "node:util";
import { stdout } from "node:process";
import type {
  EffectClaimedPayload,
  EffectSettledPayload,
  Entry,
  MessagePayload,
  Part,
  TurnMarkerPayload
} from "../contract.js";
import type { ApprovalRequestedPayload } from "../tools/runtime.js";
import { nodeSqliteDb } from "../adapters/node-sqlite.js";
import { createEngine } from "../engine/engine.js";
import { ROOT_BRANCH } from "../ids.js";
import { systemClock } from "../substrate.js";
import { newestSession } from "./sessions.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    full: { type: "boolean", default: false },
    turn: { type: "string" },
    help: { type: "boolean", short: "h" }
  },
  strict: true
});

if (values.help === true) {
  stdout.write(`Usage: pnpm log [path] [options]

  path            session log (default: newest under .sessions/)
  --full          print whole message bodies instead of one-line summaries
  --turn <id>     only entries for one turn (accepts a unique id prefix)
  --help
`);
  process.exit(0);
}

const path = positionals[0] ?? newestSession();
if (path === null) {
  stdout.write("No session logs yet — run `pnpm demo` first.\n");
  process.exit(1);
}

const db = nodeSqliteDb(path);
const { engine } = createEngine(db, systemClock());

const dim = (s: string) => (stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

const clip = (s: string, max = 100) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const textOf = (parts: readonly Part[]) =>
  parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

const turnLabels = new Map<string, string>();
const labelFor = (turn: string | undefined): string => {
  if (turn === undefined) return "    ";
  if (!turnLabels.has(turn)) turnLabels.set(turn, `t${turnLabels.size + 1}`);
  return (turnLabels.get(turn) as string).padEnd(4);
};

stdout.write(`${bold(path)}\n\n`);

let count = 0;
let truncated = 0;
for await (const entry of engine.export.scan(ROOT_BRANCH)) {
  if (values.turn !== undefined && entry.turn?.startsWith(values.turn) !== true)
    continue;
  count += 1;
  const seq = String(entry.ref.seq).padStart(4);
  const at = new Date(entry.at).toISOString().slice(11, 23);
  const head = `${seq} ${dim(at)} ${dim(labelFor(entry.turn))}`;
  stdout.write(`${head} ${describe(entry)}\n`);
}

if (count === 0) stdout.write(dim("(no entries)\n"));
else {
  stdout.write(
    `\n${dim(`${count} entries across ${turnLabels.size} turn(s)`)}\n`
  );
  if (truncated > 0) {
    stdout.write(
      `${truncated} answer(s) hit the model's output cap — the text really was ` +
        `cut short, not just the display.\n`
    );
  }
}
db.close();

function describe(entry: Entry): string {
  const kind = entry.payload.kind;
  switch (kind) {
    case "message": {
      const m = entry.payload as MessagePayload;
      const text = textOf(m.parts);
      const calls = m.parts.filter((p) => p.type === "tool-call");
      const results = m.parts.filter((p) => p.type === "tool-result");
      const bits: string[] = [];
      if (text.length > 0) {
        bits.push(
          values.full === true ? `\n${text}\n` : `"${clip(oneLine(text))}"`
        );
        // A body ending mid-word is the signature of a truncated answer.
        bits.push(dim(`[${text.length} chars]`));
      }
      for (const c of calls) {
        if (c.type === "tool-call") {
          bits.push(`→ ${c.name}(${clip(JSON.stringify(c.input), 60)})`);
        }
      }
      for (const r of results) {
        if (r.type === "tool-result") {
          bits.push(
            `← ${clip(String(r.output), 60)}${r.isError === true ? " (error)" : ""}`
          );
        }
      }
      return `${bold(m.role.padEnd(9))} ${bits.join(" ")}`;
    }
    case "turn/marker": {
      const m = entry.payload as TurnMarkerPayload;
      const detail = (m.detail ?? {}) as { reason?: string; message?: string };
      const extra =
        detail.message !== undefined
          ? ` — ${detail.message}`
          : detail.reason !== undefined
            ? ` — ${detail.reason}`
            : "";
      if (m.marker === "failed" && /finish=length/.test(detail.message ?? ""))
        truncated += 1;
      const text = `turn      ${m.marker}${extra}`;
      return m.marker === "failed" ? `✗ ${text}` : dim(text);
    }
    case "effect/claimed": {
      const c = entry.payload as EffectClaimedPayload;
      return dim(`claim     ${c.effect} ${clip(JSON.stringify(c.input), 60)}`);
    }
    case "effect/settled": {
      const s = entry.payload as EffectSettledPayload;
      return dim(`settle    ${s.result.status}`);
    }
    case "tools/approval-requested": {
      const r = entry.payload as ApprovalRequestedPayload;
      return `approval  requested — ${r.descriptor.title}`;
    }
    default: {
      // Pass-through entries (planner/plan, debater/argument, compactor/…):
      // the engine never knew what they meant, and neither does this reader.
      const json = JSON.stringify(entry.payload);
      return `${kind.padEnd(9)} ${dim(clip(oneLine(json), 110))}`;
    }
  }
}
