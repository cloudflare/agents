import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type {
  PromptCacheScenario,
  PromptCacheTurn
} from "./agents/prompt-cache";

async function measure(
  name: string,
  scenario: PromptCacheScenario
): Promise<PromptCacheTurn[]> {
  const agent = await getAgentByName(env.ThinkPromptCacheTestAgent, name);
  return agent.measurePromptCacheForTest(scenario);
}

/** Turns whose first request did not extend the request sent before it. */
function prefixBreaks(report: PromptCacheTurn[]): number[] {
  return report
    .filter((turn) => turn.firstChangedMessage !== null)
    .map((turn) => turn.turn);
}

// Providers cache on a byte-identical prompt prefix. Each turn's first model
// request should extend the previous request unless a context-reduction
// mechanism rewrote history, and those rewrites should be one-shot rather
// than happen every turn.
describe("prompt-cache prefix stability (#2200)", () => {
  it("extends the previous request every turn with no reduction", async () => {
    const report = await measure("prefix-baseline", { turns: 8 });
    expect(prefixBreaks(report)).toEqual([]);
  });

  it("rewrites truncated tool outputs once per step, not every turn", async () => {
    const report = await measure("prefix-tool-output", {
      turns: 16,
      toolOutputChars: 4000
    });
    expect(prefixBreaks(report)).toEqual([6, 10, 14]);
  });

  it("cuts every turn when truncationStep is 1", async () => {
    const report = await measure("prefix-step-one", {
      turns: 8,
      toolOutputChars: 4000,
      truncationStep: 1
    });
    expect(prefixBreaks(report)).toEqual([3, 4, 5, 6, 7]);
    expect(report.at(-1)!.requestChars).toBeLessThan(
      (
        await measure("prefix-step-default", {
          turns: 8,
          toolOutputChars: 4000
        })
      ).at(-1)!.requestChars
    );
  });

  it("rewrites truncated long text once per step, not every turn", async () => {
    const report = await measure("prefix-long-text", {
      turns: 16,
      userTextChars: 12_000
    });
    expect(prefixBreaks(report)).toEqual([6, 10, 14]);
  });

  it("rewrites the prefix once when media is evicted", async () => {
    const report = await measure("prefix-media", {
      turns: 8,
      firstTurnMediaChars: 50_000,
      mediaEviction: { keepRecentMessages: 2, minPartBytes: 10_000 }
    });
    expect(prefixBreaks(report)).toHaveLength(1);
    expect(report.at(-1)!.requestChars).toBeLessThan(10_000);
  });

  it("rewrites the prefix once per compaction", async () => {
    const report = await measure("prefix-compaction", {
      turns: 16,
      userTextChars: 400,
      compactAfterTokens: 1000
    });
    const compactedAt = report
      .filter(
        (turn, i) =>
          (turn.compactionCalls?.length ?? 0) >
          (report[i - 1]?.compactionCalls?.length ?? 0)
      )
      .map((turn) => turn.turn);
    expect(compactedAt.length).toBeGreaterThan(0);
    expect(prefixBreaks(report)).toEqual(compactedAt);
  });
});
