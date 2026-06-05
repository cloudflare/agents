import type { ChatCapableAgentClass } from "agents";
import { generateObject } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { Think } from "@cloudflare/think";
import { PlaywrightTestAgent } from "./playwright-test-agent";
import { runRequestSchema, testJudgmentSchema } from "./schema";
import type {
  Env,
  RunRequest,
  TestCase,
  TestEvidence,
  TestJudgment,
  TestInput,
  TestPlanRunResult,
  TestRunRecord
} from "./schema";
import { hashString, normalizeEvidence } from "./utils";

export class TestPlanAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6"
    );
  }

  getSystemPrompt(): string {
    return "You dispatch JSON test cases to Playwright test sub-agents.";
  }

  protected getPlaywrightTestAgentClass(): ChatCapableAgentClass {
    return PlaywrightTestAgent;
  }

  async runTestPlan(input: RunRequest): Promise<TestPlanRunResult> {
    const options = runRequestSchema.parse(input);
    const planId = await hashString(
      JSON.stringify({ tests: options.tests, baseUrl: options.baseUrl })
    );
    const attemptId = crypto.randomUUID();
    const maxConcurrency = options.maxConcurrency ?? 4;
    const results: TestRunRecord[] = new Array(options.tests.length);
    let next = 0;

    const worker = async () => {
      while (next < options.tests.length) {
        const index = next;
        next += 1;
        const test = options.tests[index];
        if (!test) continue;
        results[index] = await this.runOneTest(
          test,
          planId,
          attemptId,
          options
        );
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrency, options.tests.length) },
        () => worker()
      )
    );

    const failed = results.filter(
      (record) => record.judgment.status === "fail"
    ).length;
    return {
      planId,
      attemptId,
      planName: options.planName,
      total: results.length,
      passed: results.length - failed,
      failed,
      tests: results
    };
  }

  private async runOneTest(
    test: TestCase,
    planId: string,
    attemptId: string,
    options: RunRequest
  ): Promise<TestRunRecord> {
    const runId = await hashString(
      JSON.stringify({ planId, attemptId, test, baseUrl: options.baseUrl })
    );
    const result = await this.runAgentTool<TestInput, TestEvidence>(
      this.getPlaywrightTestAgentClass(),
      {
        runId,
        input: {
          test,
          baseUrl: options.baseUrl,
          planName: options.planName,
          mcpServerUrl: options.mcpServerUrl
        },
        inputPreview: {
          id: test.id,
          title: test.title,
          route: test.route
        },
        display: { name: test.title, icon: "playwright" }
      }
    );
    const evidence = normalizeEvidence(result);
    const judgment = await this.judgeTest(test, evidence, options);

    return {
      test,
      runId,
      agentType: result.agentType,
      agentStatus: result.status,
      evidence,
      judgment
    };
  }

  private async judgeTest(
    test: TestCase,
    evidence: TestEvidence,
    options: RunRequest
  ): Promise<TestJudgment> {
    const { object } = await generateObject({
      model: this.getModel(),
      schema: testJudgmentSchema,
      prompt: [
        "You are the parent test-plan agent. Decide whether this test passed or failed based only on the test case and evidence collected by the Playwright sub-agent.",
        "If the evidence is insufficient to verify the expected behavior, mark the test as failed and explain what is missing.",
        "Do not invent observations that are not present in the evidence.",
        "",
        `Plan: ${options.planName ?? "unnamed"}`,
        options.baseUrl ? `Base URL: ${options.baseUrl}` : undefined,
        "",
        "Test case:",
        JSON.stringify(test, null, 2),
        "",
        "Evidence:",
        JSON.stringify(evidence.evidence, null, 2),
        "",
        "Replay script:",
        evidence.replayScript,
        "",
        "Trace:",
        JSON.stringify(evidence.trace ?? null, null, 2)
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n")
    });
    return object;
  }
}
