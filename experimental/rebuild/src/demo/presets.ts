/**
 * DEMO — the payoff file. An agent is a VALUE; a preset is a filled-in
 * AgentDefinition; changing how the agent thinks, remembers, admits work or
 * guards tools is editing a field. No preset below shares a single strategy
 * with the others, yet they all run on the same engine, harness machinery,
 * channels and durability.
 *
 * Model-dependent presets take the LanguageModel as an argument so this file
 * stays provider-free: hand them eliza(), aiSdkModel(openai("gpt-5")), or
 * new WorkersAiLanguageModel(env.AI) at the composition edge.
 */

import type { AgentDefinition, Channel, LanguageModel } from "../contract.js";
import { stepHarness } from "../harness/step-harness.js";
import { defaultLoop } from "../harness/default-loop.js";
import { defaultAdmission } from "../admission/default.js";
import { eliza } from "./models/eliza.js";
import { rollingWindow } from "./context/window.js";
import { compactor } from "./context/compactor.js";
import { librarian } from "./context/librarian.js";
import { priorityLanes } from "./admission/priority.js";
import { bouncer } from "./admission/bouncer.js";
import { tollbooth } from "./middleware/tollbooth.js";
import { planner } from "./loops/planner.js";
import { debater } from "./loops/debater.js";
import { demoTools } from "./tools.js";

const RETRY = {
  maxAttempts: 3,
  backoff: { initialMs: 250, factor: 4, maxMs: 5_000 }
};

/**
 * The Therapist: ELIZA + a rolling window + no tools. The smallest complete
 * agent — and still durable, resumable, and multi-channel, because none of
 * that lives in the modules.
 */
export function therapist(channels: readonly Channel[]): AgentDefinition {
  return {
    channels,
    admission: defaultAdmission(),
    tools: { providers: [] },
    harness: stepHarness({
      loop: defaultLoop(),
      model: eliza(),
      context: rollingWindow({ system: "unused by eliza", size: 8 }),
      policy: { maxSteps: 1, retry: RETRY }
    })
  };
}

/**
 * The Strategist: plan-and-execute thinking, compacting memory, priced dice,
 * and a pager lane that preempts. Every seam differs from the Therapist;
 * the diff between the two functions IS the modularity claim.
 */
export function strategist(
  model: LanguageModel,
  channels: readonly Channel[]
): AgentDefinition {
  const memory = compactor({
    system: "You are a careful strategist. Prefer tools over guessing.",
    summarizer: model,
    keepRecent: 6,
    highWater: 16
  });
  return {
    channels,
    admission: priorityLanes({ preempt: ["pager"] }),
    tools: {
      providers: [demoTools()],
      middleware: [tollbooth({ "demo/roll_dice": 2 })]
    },
    harness: stepHarness({
      loop: memory.withCompaction(planner()),
      model,
      context: memory.assembler,
      policy: { maxSteps: 12, retry: RETRY }
    })
  };
}

/**
 * The Debate Club: argues with itself before speaking, remembers via a
 * model-curated Librarian, and only admits the polite ("please" is the
 * magic word). Two models with different jobs in one agent: `model` thinks,
 * `curator` reads.
 */
export function debateClub(
  model: LanguageModel,
  curator: LanguageModel,
  channels: readonly Channel[]
): AgentDefinition {
  return {
    channels,
    admission: bouncer("please", defaultAdmission()),
    tools: { providers: [] },
    harness: stepHarness({
      loop: debater({ arguments: 3 }),
      model,
      context: librarian({
        system: "You are a thoughtful conversationalist.",
        librarian: curator,
        shortlist: 30,
        pick: 8
      }),
      policy: { maxSteps: 6, retry: RETRY }
    })
  };
}
