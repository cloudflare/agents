/**
 * Cross-host recovery conformance.
 *
 * The two AI-SDK chat hosts (`@cloudflare/think` and `@cloudflare/ai-chat`)
 * converge their interrupted-turn recovery onto the SAME shared primitives:
 * `repairInterruptedToolParts` (transcript repair before inference) and the
 * `partAwaitsClientInteraction` / `clientResolvableToolNames` predicate (is a
 * tool part still legitimately awaiting the client?). This suite pins the
 * behavioral contract of those seams under each host's wiring, side by side, so
 * the convergence can't silently drift.
 *
 * It deliberately encodes the **subset** relationship, not naive "identical":
 *
 *   - **ai-chat wiring** repairs ONLY dead SERVER orphans and SKIPS a part still
 *     awaiting a client (`shouldRepair = !partAwaitsClientInteraction`), because
 *     ai-chat's default repair errors the part and the app owns inference — a
 *     pending client tool must be left for the client to replay (the turn parks).
 *   - **Think wiring** repairs everything before its own inference (no
 *     `shouldRepair`); its real `repairPart` may convert a client tool to text
 *     rather than error it, but either way the part ends SETTLED so the next
 *     provider call doesn't 400.
 *
 * So for a dead server orphan both hosts recover identically; for a pending
 * client orphan they intentionally differ (ai-chat ⊆ Think: ai-chat does less —
 * it parks). Each scenario states which.
 */

import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  repairInterruptedToolParts,
  type RepairInterruptedToolPartsOptions
} from "../repair-transcript";
import {
  partAwaitsClientInteraction,
  clientResolvableToolNames
} from "../tool-state";

type ChatMessage = UIMessage;

/** ai-chat's default: flip an interrupted tool part to a settled errored result. */
function flipToError(
  part: UIMessage["parts"][number]
): UIMessage["parts"][number] {
  return {
    ...part,
    state: "output-error",
    errorText: "The tool call was interrupted before a result was recorded."
  } as UIMessage["parts"][number];
}

/** How each host wires the shared `repairInterruptedToolParts`. */
function aiChatWiring(
  clientTools: string[]
): RepairInterruptedToolPartsOptions {
  const clientResolvable = clientResolvableToolNames(
    clientTools.map((name) => ({ name }))
  );
  return {
    repairPart: flipToError,
    shouldRepair: (part) => !partAwaitsClientInteraction(part, clientResolvable)
  };
}
function thinkWiring(): RepairInterruptedToolPartsOptions {
  // Think repairs every interrupted part before inference (no shouldRepair). Its
  // real `repairPart` can convert a client tool to text; we model only the
  // settled-ness outcome, which is what avoids the provider 400.
  return { repairPart: flipToError };
}

type Outcome =
  | "output-error"
  | "input-available"
  | "approval-requested"
  | "approval-responded";

interface Scenario {
  name: string;
  /** Tool names the client offered this turn (server tools are everything else). */
  clientTools: string[];
  messages: ChatMessage[];
  /** Expected post-repair state per `toolCallId`, under each host wiring. */
  expected: Record<string, { aiChat: Outcome; think: Outcome }>;
  /** Whether the two hosts agree here (documentation for the reader). */
  relationship: "identical" | "intentional-divergence (ai-chat ⊆ Think)";
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
    name: "dead server-tool orphan recovers (both hosts)",
    clientTools: [],
    messages: [
      assistant("a1", [toolPart("previewTool", "srv", "input-available")])
    ],
    expected: { srv: { aiChat: "output-error", think: "output-error" } },
    relationship: "identical"
  },
  {
    name: "pending client-tool orphan: ai-chat parks (skips), Think repairs",
    clientTools: ["chooseOption"],
    messages: [
      assistant("a1", [toolPart("chooseOption", "cli", "input-available")])
    ],
    expected: { cli: { aiChat: "input-available", think: "output-error" } },
    relationship: "intentional-divergence (ai-chat ⊆ Think)"
  },
  {
    name: "mixed: buried client orphan + leaf server orphan",
    clientTools: ["chooseOption"],
    messages: [
      assistant("a1", [toolPart("chooseOption", "cli", "input-available")]),
      assistant("a2", [toolPart("previewTool", "srv", "input-available")])
    ],
    expected: {
      // ai-chat keeps the buried client orphan, repairs the leaf server one.
      cli: { aiChat: "input-available", think: "output-error" },
      srv: { aiChat: "output-error", think: "output-error" }
    },
    relationship: "intentional-divergence (ai-chat ⊆ Think)"
  },
  {
    name: "approval-requested client part is preserved by ai-chat, repaired by Think",
    clientTools: ["deploy"],
    messages: [
      assistant("a1", [toolPart("deploy", "appr", "approval-requested")])
    ],
    expected: {
      appr: { aiChat: "approval-requested", think: "output-error" }
    },
    relationship: "intentional-divergence (ai-chat ⊆ Think)"
  },
  {
    name: "approval-responded is preserved verbatim by both (awaiting continuation)",
    clientTools: [],
    messages: [
      assistant("a1", [toolPart("deploy", "appr2", "approval-responded")])
    ],
    // Neither wiring repairs approval-responded; assert it stays as-is.
    expected: {
      appr2: { aiChat: "approval-responded", think: "approval-responded" }
    },
    relationship: "identical"
  }
];

describe("recovery conformance (shared repair primitive, both host wirings)", () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const aiChat = repairInterruptedToolParts(
        scenario.messages,
        aiChatWiring(scenario.clientTools)
      );
      const think = repairInterruptedToolParts(
        scenario.messages,
        thinkWiring()
      );

      for (const [toolCallId, want] of Object.entries(scenario.expected)) {
        expect(stateOf(aiChat.messages, toolCallId)).toBe(want.aiChat);
        expect(stateOf(think.messages, toolCallId)).toBe(want.think);
      }

      // The subset invariant: anything ai-chat repairs, Think also repairs
      // (ai-chat never repairs MORE than Think).
      for (const toolCallId of Object.keys(scenario.expected)) {
        const aiChatRepaired =
          stateOf(aiChat.messages, toolCallId) === "output-error";
        const thinkRepaired =
          stateOf(think.messages, toolCallId) === "output-error";
        if (aiChatRepaired) expect(thinkRepaired).toBe(true);
      }

      // The declared relationship must match the data: "identical" iff every
      // part has the same outcome under both wirings.
      const allIdentical = Object.values(scenario.expected).every(
        (want) => want.aiChat === want.think
      );
      expect(allIdentical).toBe(scenario.relationship === "identical");
    });
  }

  it("server-orphan recovery is byte-for-byte identical across wirings", () => {
    const messages = [
      assistant("a1", [toolPart("previewTool", "srv", "input-available")])
    ];
    const aiChat = repairInterruptedToolParts(messages, aiChatWiring([]));
    const think = repairInterruptedToolParts(messages, thinkWiring());
    expect(aiChat.messages).toEqual(think.messages);
    expect(aiChat.removedToolCalls).toBe(1);
    expect(think.removedToolCalls).toBe(1);
  });
});
