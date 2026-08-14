#!/usr/bin/env node

/**
 * Interactive terminal runner for composing the demo strategies.
 *
 * This file is only the composition edge: parse flags, pick one module per
 * seam, hand the definition to startAgent. The terminal itself — input,
 * streamed output, approval and settlement commands — is a Channel like any
 * other surface (src/demo/channels/terminal.ts), wired through the same
 * Inbox + live-tail seams a Telegram or web channel would use.
 *
 * With --db <path> the session is persistent: restart with the same path to
 * resume the conversation, or kill the process mid-turn and watch the wake
 * scan re-drive it on the next start.
 */

import { resolve } from "node:path";
import { stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { LanguageModel as AiSdkLanguageModel } from "ai";
import type {
  AdmissionPolicy,
  AgentDefinition,
  AgentLoop,
  ContextAssembler,
  LanguageModel,
  LogView,
  MessagePayload,
  Part,
  ToolMiddleware
} from "../contract.js";
import { nodeSqliteDb } from "../adapters/node-sqlite.js";
import { defaultAdmission } from "../admission/default.js";
import { defaultLoop } from "../harness/default-loop.js";
import { stepHarness } from "../harness/step-harness.js";
import {
  WorkersAiLanguageModel,
  type AiBinding
} from "../models/workers-ai.js";
import { startAgent } from "../runtime/host.js";
import { bouncer } from "./admission/bouncer.js";
import { priorityLanes } from "./admission/priority.js";
import { terminalChannel } from "./channels/terminal.js";
import { compactor } from "./context/compactor.js";
import { librarian } from "./context/librarian.js";
import { rollingWindow } from "./context/window.js";
import { debater } from "./loops/debater.js";
import { planner } from "./loops/planner.js";
import { tollbooth } from "./middleware/tollbooth.js";
import { aiSdkModel } from "./models/ai-sdk.js";
import { eliza } from "./models/eliza.js";
import { workersAiViaAiSdk } from "./models/workers-ai-via-ai-sdk.js";
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
const terminal = terminalChannel({
  name: admissionChoice === "priority" ? "pager" : "terminal",
  ...(admissionChoice === "bouncer"
    ? { noTurnHint: " — the bouncer wants its magic word" }
    : {})
});
const definition: AgentDefinition = {
  channels: [terminal],
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
const PROVIDER_TURN_TIMEOUT_MS = 5 * 60_000;

stdout.write(
  `Rebuild demo: model=${modelChoice}, context=${contextChoice}, ` +
    `admission=${admissionChoice}, middleware=${middlewareChoice}, ` +
    `loop=${loopChoice}${dbPath === ":memory:" ? "" : `, db=${dbPath}`} ` +
    `(type /quit to exit)\n`
);
if (dbPath !== ":memory:") {
  await printReplay(agent.engine.view());
}
terminal.begin();

await terminal.done;
try {
  // /quit does not abandon an in-flight turn; let it reach quiescence.
  await agent.waitUntilQuiescent(PROVIDER_TURN_TIMEOUT_MS);
  await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
} catch {
  stdout.write("\n(exiting with a turn still in flight)\n");
}
await agent.stop();
db.close();

async function printReplay(view: LogView): Promise<void> {
  const dim = (s: string) => (stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  const recent = await view.query({ kinds: ["message"], limit: 8 });
  if (recent.length === 0) return;
  stdout.write(`${dim("· resuming session — recent conversation:")}\n`);
  for (const entry of [...recent].reverse()) {
    const m = entry.payload as MessagePayload;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = m.parts
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (text.length === 0) continue;
    stdout.write(`${dim(`${m.role === "user" ? "You" : "Agent"}> ${text}`)}\n`);
  }
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
