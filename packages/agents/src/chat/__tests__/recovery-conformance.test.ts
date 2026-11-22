/**
 * Before-turn repair conformance.
 *
 * `@cloudflare/think` and `@cloudflare/ai-chat` used to wire the shared
 * `repairInterruptedToolParts` differently: ai-chat skipped every part a
 * client might still answer, Think repaired everything. This suite pinned
 * that divergence. Both hosts now call one rule,
 * `repairTranscriptBeforeTurn` (through `ChatTurns.settleBeforeTurn`), so
 * there is no host wiring left to compare. What differs is the turn: one
 * that starts a new reply, or one that continues the last message.
 *
 * Each scenario is one of the transcripts the old suite compared the hosts
 * on, with the outcome of every tool call under both kinds of turn.
 */

import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  interruptedToolPartAsError,
  repairTranscriptBeforeTurn
} from "../before-turn";
import { clientResolvableToolNames } from "../tool-state";

type ChatMessage = UIMessage;

type Outcome =
  | "output-error"
  | "input-available"
  | "approval-requested"
  | "approval-responded";

interface Scenario {
  name: string;
  /** Tool names the client sent a schema for (anything else is a server tool). */
  clientTools: string[];
  messages: ChatMessage[];
  /** State of each call after the repair, by `toolCallId`. */
  expected: Record<string, { newReply: Outcome; continuation: Outcome }>;
  /** Calls a continuation turn keeps for a client, so it must not call the model. */
  keptByContinuation: string[];
}

function assistant(id: string, parts: Record<string, unknown>[]): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: parts as unknown as ChatMessage["parts"]
  } as ChatMessage;
}
function toolPart(
  toolName: string,
  toolCallId: string,
  state: string
): Record<string, unknown> {
  return { type: `tool-${toolName}`, toolCallId, toolName, state, input: {} };
}

function stateOf(
  messages: ChatMessage[],
  toolCallId: string
): string | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      const r = p as Record<string, unknown>;
      if (r.toolCallId === toolCallId) {
        return typeof r.state === "string" ? r.state : undefined;
      }
    }
  }
  return undefined;
}

const scenarios: Scenario[] = [
  {
    name: "a dead server-tool call in the last message is settled by both turns",
    clientTools: [],
    messages: [
      assistant("a1", [toolPart("previewTool", "srv", "input-available")])
    ],
    expected: {
      srv: { newReply: "output-error", continuation: "output-error" }
    },
    keptByContinuation: []
  },
  {
    name: "a pending client-tool call in the last message: a new reply moves past it, a continuation keeps it",
    clientTools: ["chooseOption"],
    messages: [
      assistant("a1", [toolPart("chooseOption", "cli", "input-available")])
    ],
    expected: {
      cli: { newReply: "output-error", continuation: "input-available" }
    },
    keptByContinuation: ["cli"]
  },
  {
    name: "a client-tool call in an earlier message is settled by both turns, with the last message's server call",
    clientTools: ["chooseOption"],
    messages: [
      assistant("a1", [toolPart("chooseOption", "cli", "input-available")]),
      assistant("a2", [toolPart("previewTool", "srv", "input-available")])
    ],
    expected: {
      cli: { newReply: "output-error", continuation: "output-error" },
      srv: { newReply: "output-error", continuation: "output-error" }
    },
    keptByContinuation: []
  },
  {
    name: "an approval request in the last message: a new reply moves past it, a continuation keeps it",
    clientTools: ["deploy"],
    messages: [
      assistant("a1", [toolPart("deploy", "appr", "approval-requested")])
    ],
    expected: {
      appr: { newReply: "output-error", continuation: "approval-requested" }
    },
    keptByContinuation: ["appr"]
  },
  {
    name: "an approved call in the last message is kept by both turns: the AI SDK runs it",
    clientTools: [],
    messages: [
      assistant("a1", [toolPart("deploy", "appr2", "approval-responded")])
    ],
    expected: {
      appr2: {
        newReply: "approval-responded",
        continuation: "approval-responded"
      }
    },
    keptByContinuation: []
  },
  {
    name: "an approved call in an earlier message is settled by both turns: nothing can run it",
    clientTools: [],
    messages: [
      assistant("a1", [toolPart("deploy", "appr3", "approval-responded")]),
      assistant("a2", [toolPart("previewTool", "srv", "input-available")])
    ],
    expected: {
      appr3: { newReply: "output-error", continuation: "output-error" },
      srv: { newReply: "output-error", continuation: "output-error" }
    },
    keptByContinuation: []
  }
];

describe("before-turn repair conformance (one rule, two kinds of turn)", () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const clientToolNames = clientResolvableToolNames(
        scenario.clientTools.map((name) => ({ name }))
      );
      const repair = (continuation: boolean) =>
        repairTranscriptBeforeTurn(scenario.messages, {
          continuation,
          clientToolNames,
          repairPart: (part) =>
            interruptedToolPartAsError(part, { clientToolNames })
        });
      const newReply = repair(false);
      const continuation = repair(true);

      for (const [toolCallId, want] of Object.entries(scenario.expected)) {
        expect(stateOf(newReply.messages, toolCallId)).toBe(want.newReply);
        expect(stateOf(continuation.messages, toolCallId)).toBe(
          want.continuation
        );
      }

      // A turn that starts a new reply never keeps a call for a client. A
      // continuation keeps only what the scenario names, and reports it.
      expect(newReply.keptToolCallIds).toEqual([]);
      expect(continuation.keptToolCallIds).toEqual(scenario.keptByContinuation);

      // A continuation settles a subset of what a new reply settles.
      for (const id of continuation.toolCallIds) {
        expect(newReply.toolCallIds).toContain(id);
      }
    });
  }
});
