#!/usr/bin/env node

/** Interactive terminal runner for composing the demo strategies. */

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
  LanguageModel,
  ToolMiddleware
} from "../contract.js";
import type { ApprovalRequestedPayload } from "../tools/runtime.js";
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
  --help

For ai-sdk, the provider module exports an AI SDK LanguageModel as default or
"model". For either Workers AI route, it exports an AI binding as default or
"binding". Relative paths resolve from the current directory. No provider
fallback is installed: a missing or broken provider crashes at startup.

While running:
  /approve <call-id>   grant a tollbooth approval
  /reject <call-id>    reject it
  /quit                exit
`;

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "eliza" },
    provider: { type: "string" },
    context: { type: "string", default: "window" },
    admission: { type: "string", default: "default" },
    middleware: { type: "string", default: "none" },
    loop: { type: "string", default: "default" },
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

const db = nodeSqliteDb();
const channel = localChannel({
  name: admissionChoice === "priority" ? "pager" : "terminal",
  onDeliver({ text }) {
    stdout.write(`Agent> ${text}\n`);
  }
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
const terminal = createInterface({
  input: stdin,
  output: stdout,
  prompt: "You> "
});
let terminalClosed = false;
terminal.on("close", () => {
  terminalClosed = true;
});
const shownApprovals = new Set<string>();
const PROVIDER_TURN_TIMEOUT_MS = 5 * 60_000;

stdout.write(
  `Rebuild demo: model=${modelChoice}, context=${contextChoice}, ` +
    `admission=${admissionChoice}, middleware=${middlewareChoice}, ` +
    `loop=${loopChoice} (type /quit to exit)\n`
);
terminal.prompt();

try {
  for await (const line of terminal) {
    const message = line.trim();
    if (message === "/quit" || message === "/exit") break;

    const command = message.match(/^\/(approve|reject)\s+(\S+)$/);
    if (command !== null) {
      await agent.approve(
        command[2],
        command[1] === "approve" ? "granted" : "rejected"
      );
      await agent.waitUntilQuiescent(PROVIDER_TURN_TIMEOUT_MS);
    } else if (message.length > 0) {
      await channel.send(message);
      await agent.waitUntilQuiescent(PROVIDER_TURN_TIMEOUT_MS);
    }

    const requests = await agent.engine.view().query({
      kinds: ["tools/approval-requested"],
      limit: 20
    });
    for (const entry of [...requests].reverse()) {
      const request = entry.payload as ApprovalRequestedPayload;
      if (shownApprovals.has(request.callId)) continue;
      shownApprovals.add(request.callId);
      stdout.write(
        `Approval required [${request.callId}]: ${request.descriptor.title}\n` +
          `Type /approve ${request.callId} or /reject ${request.callId}\n`
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
