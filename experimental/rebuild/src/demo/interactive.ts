#!/usr/bin/env node

/**
 * Interactive terminal runner for composing the demo strategies.
 *
 * Display is wired to the engine's live tail — the same rail a client uses to
 * replay or attach mid-conversation — so model deltas stream as they are
 * generated, and tool calls, plans, debate arguments, summaries, approval
 * requests and failures each surface the moment they hit the log. The local
 * channel remains the durable delivery half; the terminal is a tail client.
 *
 * With --db <path> the session is persistent: restart with the same path to
 * resume the conversation, or kill the process mid-turn and watch the wake
 * scan re-drive it on the next start.
 */

import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { LanguageModel as AiSdkLanguageModel } from "ai";
import type {
  AdmissionPolicy,
  AgentDefinition,
  AgentLoop,
  ContextAssembler,
  EffectClaimedPayload,
  Entry,
  Json,
  LanguageModel,
  LogView,
  MessagePayload,
  Part,
  ToolMiddleware,
  TurnMarkerPayload
} from "../contract.js";
import type {
  ApprovalRequestedPayload,
  ApprovalVerdictPayload
} from "../tools/runtime.js";
import { nodeSqliteDb } from "../adapters/node-sqlite.js";
import { defaultAdmission } from "../admission/default.js";
import { localChannel } from "../channels/local.js";
import { defaultLoop } from "../harness/default-loop.js";
import { stepHarness } from "../harness/step-harness.js";
import {
  WorkersAiLanguageModel,
  type AiBinding
} from "../models/workers-ai.js";
import { startAgent } from "../runtime/host.js";
import { bouncer } from "./admission/bouncer.js";
import { priorityLanes } from "./admission/priority.js";
import { compactor } from "./context/compactor.js";
import { librarian } from "./context/librarian.js";
import { rollingWindow } from "./context/window.js";
import { debater, type ArgumentPayload } from "./loops/debater.js";
import {
  planner,
  type PlanNotePayload,
  type PlanPayload
} from "./loops/planner.js";
import { tollbooth } from "./middleware/tollbooth.js";
import { aiSdkModel } from "./models/ai-sdk.js";
import { eliza } from "./models/eliza.js";
import { workersAiViaAiSdk } from "./models/workers-ai-via-ai-sdk.js";
import type { SummaryPayload } from "./context/compactor.js";
import { demoTools } from "./tools.js";

const HELP = `Usage: pnpm demo [options]

Swap strategies independently at their composition seams:
  --model eliza|ai-sdk|workers-ai|workers-ai-sdk
                                      LanguageModel (default: eliza)
  --provider <module>                 Provider model or binding module
  --context window|compactor|librarian
  --admission default|priority|bouncer
  --middleware none|tollbooth
  --loop default|planner|debater
  --db <path>                         SQLite file for a persistent session
                                      (default: in-memory, gone on exit)
  --help

For ai-sdk, the provider module exports an AI SDK LanguageModel as default or
"model". For either Workers AI route, it exports an AI binding as default or
"binding". Relative paths resolve from the current directory. No provider
fallback is installed: a missing or broken provider crashes at startup.

While running:
  /approve [call-id]   grant the newest (or the named) approval request
  /reject [call-id]    reject it
  /settle <call-id> <answer>
                       play the outside world: settle a pending effect
  /help                show this text
  /quit                exit

Call ids accept any unique prefix.
`;

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "eliza" },
    provider: { type: "string" },
    context: { type: "string", default: "window" },
    admission: { type: "string", default: "default" },
    middleware: { type: "string", default: "none" },
    loop: { type: "string", default: "default" },
    db: { type: "string", default: ":memory:" },
    help: { type: "boolean", short: "h" }
  },
  strict: true
});

if (values.help === true) {
  stdout.write(HELP);
  process.exit(0);
}

const modelChoice = choice("model", values.model, [
  "eliza",
  "ai-sdk",
  "workers-ai",
  "workers-ai-sdk"
]);
const contextChoice = choice("context", values.context, [
  "window",
  "compactor",
  "librarian"
]);
const admissionChoice = choice("admission", values.admission, [
  "default",
  "priority",
  "bouncer"
]);
const middlewareChoice = choice("middleware", values.middleware, [
  "none",
  "tollbooth"
]);
const loopChoice = choice("loop", values.loop, [
  "default",
  "planner",
  "debater"
]);
const dbPath = values.db ?? ":memory:";

const model = await createModel(modelChoice, values.provider);
let loop: AgentLoop =
  loopChoice === "planner"
    ? planner()
    : loopChoice === "debater"
      ? debater()
      : defaultLoop();
let context: ContextAssembler;
if (contextChoice === "compactor") {
  const memory = compactor({
    system: "You are a careful conversationalist.",
    summarizer: model
  });
  context = memory.assembler;
  loop = memory.withCompaction(loop);
} else if (contextChoice === "librarian") {
  context = librarian({
    system: "You are a thoughtful conversationalist.",
    librarian: model
  });
} else {
  context = rollingWindow({
    system: "You are a thoughtful conversationalist."
  });
}

const baseAdmission = defaultAdmission();
const admission: AdmissionPolicy =
  admissionChoice === "priority"
    ? priorityLanes({ preempt: ["pager"] })
    : admissionChoice === "bouncer"
      ? bouncer("please", baseAdmission)
      : baseAdmission;
const middleware: readonly ToolMiddleware[] =
  middlewareChoice === "tollbooth" ? [tollbooth({ "demo/roll_dice": 2 })] : [];

const db = nodeSqliteDb(dbPath);
// Delivery stays on the channel's durable outbox (channel.delivered collects
// it); what the terminal SHOWS comes from the live tail below.
const channel = localChannel({
  name: admissionChoice === "priority" ? "pager" : "terminal"
});
const definition: AgentDefinition = {
  channels: [channel],
  admission,
  tools: { providers: [demoTools()], middleware },
  harness: stepHarness({
    loop,
    model,
    context,
    policy: {
      maxSteps: 12,
      retry: {
        maxAttempts: 3,
        backoff: { initialMs: 250, factor: 4, maxMs: 5_000 }
      }
    }
  })
};
const agent = startAgent(definition, { db });

// ---- live rendering: the terminal is a tail client -------------------------

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

/** "text" | "reasoning" when an unterminated streaming line is on screen. */
let lineOpen: "text" | "reasoning" | null = null;
/** Text deltas streamed since the last committed generation — the committed
 * entry that follows them is already on screen and must not reprint. */
let streamedSegment = false;
/** Rendered activity since the last user message; zero means admission
 * started no turn (the bouncer's silence, made visible). */
let eventsSinceSend = 0;
const callNames = new Map<string, string>();
const openApprovals: string[] = [];
const hintedClaims = new Set<string>();

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

function renderChunk(chunk: Json): void {
  eventsSinceSend += 1;
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

async function renderEntry(entry: Entry): Promise<void> {
  const kind = entry.payload.kind;
  if (kind === "message") {
    const m = entry.payload as MessagePayload;
    if (m.role === "user") return; // typed right here; already on screen
    eventsSinceSend += 1;
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
        const name = callNames.get(p.callId) ?? p.callId;
        const err = p.isError === true ? " (error)" : "";
        note(`· ${name} → ${short(p.output)}${err}`);
      }
    }
    return;
  }
  eventsSinceSend += 1;
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
      openApprovals.push(r.callId);
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
      const i = openApprovals.indexOf(v.callId);
      if (i >= 0) openApprovals.splice(i, 1);
      note(`· approval ${v.verdict}`);
      return;
    }
    case "turn/marker": {
      const m = entry.payload as TurnMarkerPayload;
      const detail = (m.detail ?? {}) as { reason?: string; message?: string };
      if (m.marker === "failed") {
        closeLine();
        stdout.write(
          `✗ turn failed (${detail.reason ?? "unknown"}): ${detail.message ?? ""}\n`
        );
        streamedSegment = false;
      } else if (
        m.marker === "parked" &&
        detail.reason?.startsWith("pending effect") === true
      ) {
        await hintPendingClaims();
      } else if (m.marker === "completed") {
        closeLine();
        streamedSegment = false;
      }
      return;
    }
    default:
      return; // tolerant reader: unrendered kinds pass through silently
  }
}

/** A turn parked on a pending effect: tell the user how to be the world. */
async function hintPendingClaims(): Promise<void> {
  const claims = await agent.engine.ledger.openClaims({
    effectPrefix: "tool/"
  });
  for (const claim of claims) {
    const correlation = String(claim.correlation ?? "");
    if (!correlation.startsWith("tool:")) continue;
    const callId = correlation.slice("tool:".length);
    if (hintedClaims.has(callId)) continue;
    hintedClaims.add(callId);
    const effect = (claim.payload as EffectClaimedPayload).effect.replace(
      /^tool\//,
      ""
    );
    closeLine();
    stdout.write(`Waiting on ${effect} — its answer arrives from outside.\n`);
    stdout.write(dim(`  Play the outside world: /settle ${callId} <answer>\n`));
  }
}

// Attach before any microtask runs so the wake scan's re-drive streams too.
void (async () => {
  try {
    for await (const event of agent.engine.tail({ live: true })) {
      if (event.type === "chunk") renderChunk(event.chunk.chunk);
      else await renderEntry(event.entry);
    }
  } catch {
    // process is exiting; the tail ends with it
  }
})();

// ---- the REPL --------------------------------------------------------------

const terminal = createInterface({
  input: stdin,
  output: stdout,
  prompt: "You> "
});
let terminalClosed = false;
terminal.on("close", () => {
  terminalClosed = true;
});
const PROVIDER_TURN_TIMEOUT_MS = 5 * 60_000;

/** Rendering drains in microtasks; one macrotask hop flushes it. */
const flushOutput = () =>
  new Promise<void>((resolveFlush) => setImmediate(resolveFlush));

/** Call ids accept any unique prefix. */
function resolveId(prefix: string, known: Iterable<string>): string {
  const matches = [...known].filter((k) => k.startsWith(prefix));
  return matches.length === 1 ? matches[0] : prefix;
}

async function runCommand(
  verb: string,
  id: string | undefined,
  rest: string | undefined
): Promise<void> {
  if (verb === "settle") {
    if (id === undefined) {
      stdout.write("Usage: /settle <call-id> <answer>\n");
      return;
    }
    await agent.settleTool(resolveId(id, hintedClaims), rest ?? "");
  } else {
    const callId =
      id !== undefined
        ? resolveId(id, openApprovals)
        : openApprovals[openApprovals.length - 1];
    if (callId === undefined) {
      stdout.write("No open approval requests.\n");
      return;
    }
    await agent.approve(callId, verb === "approve" ? "granted" : "rejected");
  }
  await agent.waitUntilQuiescent(PROVIDER_TURN_TIMEOUT_MS);
  await flushOutput();
}

async function printReplay(view: LogView): Promise<void> {
  const recent = await view.query({ kinds: ["message"], limit: 8 });
  if (recent.length === 0) return;
  stdout.write(`${dim("· resuming session — recent conversation:")}\n`);
  for (const entry of [...recent].reverse()) {
    const m = entry.payload as MessagePayload;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = textOf(m.parts);
    if (text.length === 0) continue;
    stdout.write(`${dim(`${m.role === "user" ? "You" : "Agent"}> ${text}`)}\n`);
  }
}

stdout.write(
  `Rebuild demo: model=${modelChoice}, context=${contextChoice}, ` +
    `admission=${admissionChoice}, middleware=${middlewareChoice}, ` +
    `loop=${loopChoice}${dbPath === ":memory:" ? "" : `, db=${dbPath}`} ` +
    `(type /quit to exit)\n`
);
if (dbPath !== ":memory:") {
  await printReplay(agent.engine.view());
}
terminal.prompt();

try {
  for await (const line of terminal) {
    const message = line.trim();
    if (message === "/quit" || message === "/exit") break;
    if (message === "/help") {
      stdout.write(HELP);
      if (!terminalClosed) terminal.prompt();
      continue;
    }

    try {
      const command = message.match(
        /^\/(approve|reject|settle)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/
      );
      if (command !== null) {
        await runCommand(command[1], command[2], command[3]);
      } else if (message.startsWith("/")) {
        stdout.write(`Unknown command ${message.split(/\s/)[0]}; try /help\n`);
      } else if (message.length > 0) {
        eventsSinceSend = 0;
        await channel.send(message);
        await agent.waitUntilQuiescent(PROVIDER_TURN_TIMEOUT_MS);
        await flushOutput();
        if (eventsSinceSend === 0) {
          note(
            admissionChoice === "bouncer"
              ? "· logged, but no turn was admitted — the bouncer wants its magic word"
              : "· logged, but no turn was admitted"
          );
        }
      }
    } catch (error) {
      closeLine();
      stdout.write(
        `Error: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    if (!terminalClosed) terminal.prompt();
  }
} finally {
  terminal.close();
  await agent.stop();
  db.close();
}

function choice<const T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[]
): T {
  if (value !== undefined && allowed.includes(value as T)) return value as T;
  throw new Error(`invalid --${flag}: ${value}; expected ${allowed.join("|")}`);
}

async function createModel(
  selected: "eliza" | "ai-sdk" | "workers-ai" | "workers-ai-sdk",
  provider: string | undefined
): Promise<LanguageModel> {
  if (selected === "eliza") return eliza();
  if (provider === undefined) {
    throw new Error(`--model ${selected} requires --provider <module>`);
  }
  const specifier =
    provider.startsWith(".") || provider.startsWith("/")
      ? pathToFileURL(resolve(provider)).href
      : provider;
  const imported = (await import(specifier)) as {
    readonly default?: unknown;
    readonly model?: unknown;
    readonly binding?: unknown;
  };
  if (selected === "ai-sdk") {
    const candidate = imported.default ?? imported.model;
    if (candidate === undefined) {
      throw new Error(
        `${provider} must export an AI SDK model as default or model`
      );
    }
    return aiSdkModel(candidate as AiSdkLanguageModel);
  }
  const binding = imported.default ?? imported.binding;
  if (binding === undefined) {
    throw new Error(
      `${provider} must export a Workers AI binding as default or binding`
    );
  }
  return selected === "workers-ai"
    ? new WorkersAiLanguageModel(binding as AiBinding)
    : workersAiViaAiSdk(binding as AiBinding);
}
