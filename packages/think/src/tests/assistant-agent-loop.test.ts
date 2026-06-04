import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { defaultContextOverflowClassifier } from "../think";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

function kebab(className: string): string {
  return className
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

async function connectWS(agentClass: string, room: string) {
  const slug = kebab(agentClass);
  const res = await exports.default.fetch(
    `http://example.com/agents/${slug}/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 5000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    const handler = (e: MessageEvent) => {
      try {
        messages.push(JSON.parse(e.data as string) as Record<string, unknown>);
        if (messages.length >= count) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function waitForDone(
  ws: WebSocket,
  timeout = 10000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        messages.push(msg);
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

function sendChatRequest(ws: WebSocket, text: string, requestId?: string) {
  const id = requestId ?? crypto.randomUUID();
  const userMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }]
  };
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [userMessage] })
      }
    })
  );
  return { id, userMessage };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("Think — agentic loop", () => {
  describe("getModel() error", () => {
    it("returns an error when getModel is not overridden", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("BareAssistantAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "hello");
      const messages = await done;

      const errorMsg = messages.find(
        (m) =>
          m.type === MSG_CHAT_RESPONSE && m.done === true && m.error === true
      );
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.body).toContain("getModel");

      await closeWS(ws);
    });
  });

  describe("default loop — text only", () => {
    it("streams a response using the mock model", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "Say hi");
      const messages = await done;

      const responseChunks = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === false
      );
      expect(responseChunks.length).toBeGreaterThan(0);

      const bodies = responseChunks
        .map((m) => m.body as string)
        .filter(Boolean);
      const hasText = bodies.some((b) => {
        try {
          const parsed = JSON.parse(b) as Record<string, unknown>;
          return parsed.type === "text-delta" || parsed.type === "text-start";
        } catch {
          return false;
        }
      });
      expect(hasText).toBe(true);

      await closeWS(ws);
    });

    it("persists assistant message after streaming", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);
      const agent = await getAgentByName(env.LoopTestAgent, room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "Hello");
      await done;

      // Wait for the messages broadcast after persistence
      await collectMessages(ws, 1, 3000);

      const msgs = (await (
        agent as unknown as { getMessages(): Promise<UIMessage[]> }
      ).getMessages()) as UIMessage[];
      expect(msgs.length).toBeGreaterThanOrEqual(2);

      const assistantMsg = msgs.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();

      await closeWS(ws);
    });
  });

  describe("default loop — with tools", () => {
    it("executes a tool and returns text after", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopToolTestAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "Use the echo tool");
      const messages = await done;

      const responseChunks = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === false
      );
      expect(responseChunks.length).toBeGreaterThan(0);

      await closeWS(ws);
    });

    it("custom maxSteps property is respected", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopToolTestAgent", room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "test step limit");
      const messages = await done;

      const doneMsg = messages.find(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === true
      );
      expect(doneMsg).toBeDefined();

      await closeWS(ws);
    });
  });

  describe("mid-turn context-overflow recovery (opt-in)", () => {
    type OverflowResult = {
      done: boolean;
      error?: string;
      compactionCount: number;
      modelCalls: number;
      compactionEvents: number;
      errorClassification?: string;
      beforeTurnContinuations: boolean[];
      promptIncludedSeedMarker: boolean[];
    };

    type OverflowAgent = {
      testChat(
        message: string,
        enabled: boolean,
        opts?: {
          noOpCompaction?: boolean;
          alwaysOverflow?: boolean;
          emitPartialBeforeOverflow?: boolean;
        }
      ): Promise<OverflowResult>;
      testProactive(message: string): Promise<OverflowResult>;
      testProactiveMultiFire(message: string): Promise<OverflowResult>;
      testProactiveNoOp(message: string): Promise<OverflowResult>;
      testChatAbortDuringRecovery(message: string): Promise<OverflowResult>;
      testProgrammaticAbortDuringRecovery(
        message: string
      ): Promise<OverflowResult>;
      testCombinedProactiveReactive(message: string): Promise<OverflowResult>;
      testChatThrowingOverflow(message: string): Promise<OverflowResult>;
      testProgrammatic(message: string): Promise<OverflowResult>;
      enableOverflowRecoveryForWsTest(opts?: {
        abortDuringRecovery?: boolean;
      }): Promise<void>;
      getOverflowStats(): Promise<{
        compactionCount: number;
        modelCalls: number;
        compactionEvents: number;
        promptIncludedSeedMarker: boolean[];
        compactionEventPayloads: Array<Record<string, unknown>>;
      }>;
      getProactiveStepPrompts(): Promise<
        Array<{
          toolCalls: string[];
          toolResults: string[];
          hasSummary: boolean;
          headHasHistory: boolean;
        }>
      >;
    };

    it("compacts and retries when enabled, recovering the turn", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testChat("trigger overflow", true);

      // The turn recovers: no terminal error, compaction fired once, and the
      // model was called twice (overflow attempt + recompacted retry).
      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      expect(result.compactionCount).toBe(1);
      expect(result.modelCalls).toBe(2);
      // Exactly one observability event per compaction (no double-emit).
      expect(result.compactionEvents).toBe(1);
      // Both attempts re-run the SAME user turn — the retry is not an
      // auto-continuation, so beforeTurn sees `continuation: false` each time.
      expect(result.beforeTurnContinuations).toEqual([false, false]);
      // Effectiveness: the first attempt's prompt still contained the seeded
      // (later compacted-away) messages; the retry's prompt did NOT — proving
      // compaction actually shortened what was sent and that the refreshed
      // message cache reached the retry (not just that the loop ran).
      expect(result.promptIncludedSeedMarker).toEqual([true, false]);
    });

    it("does not leave an orphan truncated assistant message after a reactive retry", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent & {
        getTranscriptSummary(): Promise<Array<{ role: string; text: string }>>;
      };

      // The model streams partial assistant text, THEN overflows; recovery
      // compacts and re-runs, producing the real answer.
      const result = await agent.testChat("trigger overflow", true, {
        emitPartialBeforeOverflow: true
      });

      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);

      const transcript = await agent.getTranscriptSummary();
      const allTexts = transcript.map((m) => m.text);

      // The truncated partial must NOT be left behind anywhere in the
      // transcript — the turn was re-run from scratch, so the partial is
      // throwaway and persisting it would orphan a cut-off bubble beside the
      // recovered answer.
      expect(allTexts).not.toContain("partial answer before overflow");
      // The recovered answer is present exactly once (a single clean assistant
      // message for the turn, not a partial + a retry).
      const recoveredCount = allTexts.filter(
        (t) => t === "recovered after compaction"
      ).length;
      expect(recoveredCount).toBe(1);
    });

    it("stays terminal when disabled (no compaction, surfaces the error)", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testChat("trigger overflow", false);

      // Opt-in off: the overflow error is delivered terminally, no compaction,
      // and the model is called exactly once (no retry).
      expect(result.error).toBeDefined();
      expect(result.error).toContain("prompt is too long");
      expect(result.compactionCount).toBe(0);
      expect(result.modelCalls).toBe(1);
      expect(result.compactionEvents).toBe(0);
    });

    it("falls through to a terminal error (via onChatError) when compaction can't shorten", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testChat("trigger overflow", true, {
        noOpCompaction: true
      });

      // Recovery is enabled but compaction is a no-op: the turn must not loop
      // or end silently — it surfaces the overflow terminally, routed through
      // onChatError with the context_overflow classification.
      expect(result.error).toBeDefined();
      expect(result.error).toContain("prompt is too long");
      expect(result.errorClassification).toBe("context_overflow");
      // One compaction attempt was made (and reported once), but it didn't
      // shorten, so no retry: the model was called exactly once.
      expect(result.modelCalls).toBe(1);
      expect(result.compactionEvents).toBe(1);
    });

    it("stops after contextOverflow.maxRetries when the overflow persists (no infinite loop)", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      // Compaction shortens, but the model keeps overflowing on every call.
      const result = await agent.testChat("trigger overflow", true, {
        alwaysOverflow: true
      });

      // attempt 0 overflows → compact (shortens) → retry; attempt 1 overflows
      // again but the budget (default 1) is spent, so it terminalizes. Bounded:
      // exactly 2 model calls and 1 compaction, then a terminal error.
      expect(result.error).toBeDefined();
      expect(result.error).toContain("prompt is too long");
      expect(result.errorClassification).toBe("context_overflow");
      expect(result.modelCalls).toBe(2);
      expect(result.compactionCount).toBe(1);
      expect(result.compactionEvents).toBe(1);
      // Compaction did remove the seeded content on the retry (marker gone),
      // but `alwaysOverflow` forces the retry to overflow anyway — modelling a
      // turn whose remaining message alone exceeds the window. Bounded, then
      // terminal.
      expect(result.promptIncludedSeedMarker).toEqual([true, false]);
    });

    it("does not compact or retry an aborted turn (abort lands during recovery)", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      // The turn is cancelled at the overflow seam. Recovery must respect the
      // abort: no compaction (an expensive LLM summarization) and no retry.
      const result =
        await agent.testChatAbortDuringRecovery("trigger overflow");

      // Aborted before retry → the overflow is delivered terminally, but the
      // expensive compaction + retry are skipped entirely.
      expect(result.compactionCount).toBe(0);
      expect(result.compactionEvents).toBe(0);
      expect(result.modelCalls).toBe(1);
    });

    it("does not compact or retry an aborted turn on the programmatic path", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      // Same abort guard, exercised through the saveMessages path (the third
      // reactive driver loop, which the chat() abort test does not cover).
      const result =
        await agent.testProgrammaticAbortDuringRecovery("trigger overflow");

      expect(result.error).toBeDefined();
      expect(result.compactionCount).toBe(0);
      expect(result.compactionEvents).toBe(0);
      expect(result.modelCalls).toBe(1);
    });

    it("recovers when the provider rejects doStream (top-level throw, not an in-stream error part)", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      // The mock rejects doStream rather than emitting a `{ type: "error" }`
      // part. Recovery only watches in-stream error parts, so this passing
      // proves the AI SDK re-enqueues a top-level rejection as a fullStream
      // error part our seam catches — the changeset's central assumption.
      const result = await agent.testChatThrowingOverflow("trigger overflow");

      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      expect(result.compactionCount).toBe(1);
      expect(result.modelCalls).toBe(2);
      expect(result.compactionEvents).toBe(1);
      expect(result.promptIncludedSeedMarker).toEqual([true, false]);
    });

    it("recovers a context overflow on the programmatic (saveMessages) path", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testProgrammatic("trigger overflow");

      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      expect(result.compactionCount).toBe(1);
      expect(result.modelCalls).toBe(2);
      expect(result.compactionEvents).toBe(1);
      expect(result.promptIncludedSeedMarker).toEqual([true, false]);

      // Lock the `chat:context:compacted` payload contract (observability docs):
      // reactive compaction reports its reason, that it shortened, the request
      // id, and the attempt number.
      const { compactionEventPayloads } = await agent.getOverflowStats();
      expect(compactionEventPayloads.length).toBe(1);
      expect(compactionEventPayloads[0]).toMatchObject({
        reason: "reactive",
        shortened: true,
        attempt: 1
      });
      expect(typeof compactionEventPayloads[0].requestId).toBe("string");
    });

    it("recovers a context overflow on the WebSocket turn path", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("OverflowRecoveryTestAgent", room);
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      // Skip initial connect frames, then enable recovery + seed history on the
      // same DO instance the WebSocket turn will run on.
      await collectMessages(ws, 3);
      await agent.enableOverflowRecoveryForWsTest();

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "trigger overflow");
      const messages = await done;

      // The turn must NOT terminate prematurely mid-recovery: no error frame at
      // all, and the single done frame is clean (this is the regression guard
      // for the _streamResult `finally` emitting a spurious done on the overflow
      // early-return).
      const errorFrame = messages.find(
        (m) => m.type === MSG_CHAT_RESPONSE && m.error === true
      );
      expect(errorFrame).toBeUndefined();
      const doneFrames = messages.filter(
        (m) => m.type === MSG_CHAT_RESPONSE && m.done === true
      );
      expect(doneFrames.length).toBe(1);
      expect(doneFrames[0].error).toBeFalsy();

      // The recompacted retry's text actually streamed to the client.
      const hasRecoveredText = messages.some(
        (m) =>
          typeof m.body === "string" &&
          m.body.includes("recovered after compaction")
      );
      expect(hasRecoveredText).toBe(true);

      const stats = await agent.getOverflowStats();
      expect(stats.modelCalls).toBe(2);
      expect(stats.compactionCount).toBe(1);
      expect(stats.compactionEvents).toBe(1);
      // Compaction removed the seeded messages before the retry was sent.
      expect(stats.promptIncludedSeedMarker).toEqual([true, false]);

      await closeWS(ws);
    });

    it("does not compact or retry an aborted turn on the WebSocket path", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("OverflowRecoveryTestAgent", room);
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      await collectMessages(ws, 3);
      // Abort the turn at the overflow seam — exercises the abort guard on the
      // WebSocket driver loop (the chat() abort test does not cover this path).
      await agent.enableOverflowRecoveryForWsTest({
        abortDuringRecovery: true
      });

      const done = waitForDone(ws, 15000);
      sendChatRequest(ws, "trigger overflow");
      await done;

      const stats = await agent.getOverflowStats();
      // Aborted before retry → no compaction, no second model call.
      expect(stats.modelCalls).toBe(1);
      expect(stats.compactionCount).toBe(0);
      expect(stats.compactionEvents).toBe(0);

      await closeWS(ws);
    });

    it("recovers a context overflow with BOTH layers (proactive guard + reactive backstop)", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      // Recommended config: the proactive guard compacts before step 2, the
      // turn still overflows at step 2, and the reactive backstop compacts again
      // and retries to success — proving the two layers cooperate in one turn.
      const result =
        await agent.testCombinedProactiveReactive("trigger overflow");

      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      // One proactive + one reactive compaction.
      expect(result.compactionCount).toBe(2);
      // Two compaction events, one per layer.
      expect(result.compactionEvents).toBe(2);
      // Step 1 (tool) + step 2 (overflow) + retry step 1 (text).
      expect(result.modelCalls).toBe(3);

      // The two events carry the two distinct reasons.
      const { compactionEventPayloads } = await agent.getOverflowStats();
      const reasons = compactionEventPayloads.map((p) => p.reason).sort();
      expect(reasons).toEqual(["proactive", "reactive"]);
    });

    it("proactive guard compacts mid-turn before the budget is exceeded", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      const result = await agent.testProactive("use the echo tool");

      // The guard fires before the second step (prior step usage crossed the
      // budget), compacts in place, and the turn completes without a provider
      // overflow error ever surfacing.
      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      expect(result.compactionCount).toBeGreaterThanOrEqual(1);
      // Capped at proactive.maxCompactions (default 1): the guard compacts at
      // most once per run even across multiple steps.
      expect(result.compactionEvents).toBe(1);

      // Proactive compaction reports reason "proactive" + shortened (no
      // requestId/attempt — those are reactive-only).
      const { compactionEventPayloads } = await agent.getOverflowStats();
      expect(compactionEventPayloads.length).toBe(1);
      expect(compactionEventPayloads[0]).toMatchObject({
        reason: "proactive",
        shortened: true
      });
    });

    it("proactive guard fires twice in one turn (maxCompactions:2) without corrupting the spliced prompt", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent & {
        getTranscriptSummary(): Promise<Array<{ role: string; text: string }>>;
      };

      // 3-step turn (tool, tool, text). The guard trips before step 2 and step
      // 3; proactive.maxCompactions:2 lets it compact both times. The second compaction
      // re-runs the splice/re-baseline path: head (recompacted) + this turn's
      // in-flight tool steps. If that splice dropped a tool result or duplicated
      // the head, the provider/AI SDK would error — so a clean completion is the
      // assertion that the re-baseline is correct.
      const result = await agent.testProactiveMultiFire("use the echo tool");

      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      // Two tool steps + one final text step.
      expect(result.modelCalls).toBe(3);
      // Guard compacted before step 2 AND step 3 — the multi-fire path.
      expect(result.compactionEvents).toBe(2);

      // The turn produced exactly one final assistant answer (no duplicated or
      // dropped messages from the second splice).
      const transcript = await agent.getTranscriptSummary();
      const finalAnswers = transcript.filter(
        (m) => m.text === "done after two tools"
      );
      expect(finalAnswers.length).toBe(1);

      // Direct structural assertion on the spliced prompts (not just "the turn
      // finished"): after each proactive compaction, the prompt fed to the next
      // step must contain the recompacted head AND keep every tool-call paired
      // with its tool-result — proving the splice did not drop/duplicate parts.
      const prompts = await agent.getProactiveStepPrompts();
      expect(prompts.length).toBe(3);
      // Step 1 ran before any compaction: no summary, no tool history yet, but
      // the seeded conversation head is there.
      expect(prompts[0].hasSummary).toBe(false);
      expect(prompts[0].toolCalls.length).toBe(0);
      expect(prompts[0].headHasHistory).toBe(true);
      // Step 2 (after compaction #1): recompacted head (summary) present, the
      // step-1 tool call is paired with its result.
      expect(prompts[1].hasSummary).toBe(true);
      expect(prompts[1].headHasHistory).toBe(true);
      expect(prompts[1].toolCalls.length).toBe(1);
      expect([...prompts[1].toolResults].sort()).toEqual(
        [...prompts[1].toolCalls].sort()
      );
      // Step 3 (after compaction #2): the critical splice-integrity check — both
      // tool pairs intact with no dangling call, and the head was prepended (not
      // dropped). NOTE: we do not assert `hasSummary` here because the test's
      // mock compaction collapses `messages[0]`, which on the second call is its
      // own summary — a degenerate re-summarize that reverts to the original
      // head. A real compaction summarizes a range of oldest messages instead.
      // The tool-pairing + head-presence guarantees are what matter for the
      // splice and they hold regardless.
      expect(prompts[2].headHasHistory).toBe(true);
      expect(prompts[2].toolCalls.length).toBe(2);
      expect([...prompts[2].toolResults].sort()).toEqual(
        [...prompts[2].toolCalls].sort()
      );
    });

    it("proactive no-op compaction consumes its single slot and does not re-attempt on later steps", async () => {
      const room = crypto.randomUUID();
      const agent = (await getAgentByName(
        env.OverflowRecoveryTestAgent,
        room
      )) as unknown as OverflowAgent;

      // 3-step tool turn, default budget (proactive cap 1), compaction is a
      // no-op. The guard trips before step 2, attempts once (a no-op), and is
      // then spent — so it must NOT compact again before step 3.
      const result = await agent.testProactiveNoOp("use the echo tool");

      // The turn still completes — a proactive no-op is best-effort, the step
      // just proceeds uncompacted.
      expect(result.error).toBeUndefined();
      expect(result.done).toBe(true);
      expect(result.modelCalls).toBe(3);
      // Exactly one compaction attempt (and one event) for the whole run — a
      // persistent no-op does not compact/emit on every step.
      expect(result.compactionCount).toBe(1);
      expect(result.compactionEvents).toBe(1);
    });
  });

  describe("defaultContextOverflowClassifier", () => {
    it("classifies common provider context-overflow errors", () => {
      const overflowMessages = [
        "AI_APICallError: prompt is too long: 213450 tokens > 200000 maximum", // Anthropic
        "This model's maximum context length is 128000 tokens", // OpenAI
        "context_length_exceeded", // OpenAI code
        "The input token count exceeds the maximum number of tokens allowed", // Google
        "Input is too long for requested model", // Bedrock
        "too many tokens",
        "Please reduce the length of the messages or completion." // OpenAI
      ];
      for (const message of overflowMessages) {
        expect(defaultContextOverflowClassifier(new Error(message))).toBe(
          "context_overflow"
        );
        // Also accepts a raw string (the in-stream error shape).
        expect(defaultContextOverflowClassifier(message)).toBe(
          "context_overflow"
        );
      }
    });

    it("returns undefined for unrelated errors", () => {
      const nonOverflow = [
        "rate limit exceeded",
        "network timeout",
        "401 Unauthorized: invalid api key",
        "Internal server error (500)",
        "tool execution failed: ECONNREFUSED",
        // "reduce the length" without the "of" anchor must NOT match — only the
        // full provider phrasing ("reduce the length of the messages") does.
        "could not reduce the length"
      ];
      for (const message of nonOverflow) {
        expect(
          defaultContextOverflowClassifier(new Error(message))
        ).toBeUndefined();
      }
      expect(defaultContextOverflowClassifier(undefined)).toBeUndefined();
      expect(
        defaultContextOverflowClassifier({ weird: "object" })
      ).toBeUndefined();
    });
  });

  describe("context assembly", () => {
    it("converts messages to model format", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectWS("LoopTestAgent", room);
      const agent = await getAgentByName(env.LoopTestAgent, room);

      // Skip initial messages
      await collectMessages(ws, 3);

      const done = waitForDone(ws);
      sendChatRequest(ws, "Hello for context test");
      await done;

      await collectMessages(ws, 1, 2000);

      const msgs = (await (
        agent as unknown as { getMessages(): Promise<UIMessage[]> }
      ).getMessages()) as UIMessage[];
      expect(msgs.length).toBeGreaterThanOrEqual(2);

      const userMsg = msgs.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.parts).toBeDefined();

      await closeWS(ws);
    });
  });
});
