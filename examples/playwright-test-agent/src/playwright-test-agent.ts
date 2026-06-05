import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { Think } from "@cloudflare/think";
import type { TurnConfig } from "@cloudflare/think";
import { testCaseSchema, testEvidenceSchema } from "./schema";
import type { Env, TestEvidence, TestInput } from "./schema";
import { extractText, parseEvidence } from "./utils";

export class PlaywrightTestAgent extends Think<Env> {
  waitForMcpConnections = true;
  maxSteps = 30;

  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6"
    );
  }

  getSystemPrompt(): string {
    return [
      "You are a headless Playwright test runner.",
      "Use the available Playwright MCP tools to execute exactly one test case. If trace tools are available, start tracing before browser actions and stop/save the trace before returning. If trace tools are not available, say that in trace.notes.",
      "Collect evidence from observable browser state, console/network evidence when useful, and screenshots or snapshots when useful.",
      "Do not decide whether the test passed or failed. Do not include pass/fail status or a judgment. The parent agent will make that decision.",
      "Return JSON with exactly these top-level fields: evidence, replayScript, and optional trace. The evidence field can be any shape that best fits this test.",
      "The replayScript field must be a deterministic Playwright test script. Include navigation, selectors, assertions or observation points, and trace setup. Do not include secrets."
    ].join("\n\n");
  }

  override async startAgentToolRun(
    input: TestInput,
    options: { runId: string }
  ) {
    const url = input.mcpServerUrl || this.env.PLAYWRIGHT_MCP_URL;
    if (url) {
      await this.addMcpServer("playwright", url, { id: "playwright" });
    }
    return super.startAgentToolRun(input, options);
  }

  protected override formatAgentToolInput(input: TestInput): UIMessage {
    const test = testCaseSchema.parse(input.test);
    const target = input.baseUrl
      ? `${input.baseUrl.replace(/\/$/, "")}${test.route ?? ""}`
      : (test.route ?? "the route specified by the test case");

    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [
        {
          type: "text",
          text: [
            `Plan: ${input.planName ?? "unnamed"}`,
            `Target: ${target}`,
            "",
            "Test case JSON:",
            JSON.stringify(test, null, 2),
            "",
            "Execution requirements:",
            "- Use Playwright MCP browser tools to run the test.",
            "- Collect trace evidence when the MCP server exposes trace support.",
            "- Do not decide pass or fail. Only return evidence for the parent agent to judge.",
            "- Return JSON with top-level evidence and replayScript fields. evidence can be any shape. replayScript must be a string."
          ].join("\n")
        }
      ]
    };
  }

  override beforeTurn(): TurnConfig {
    return { chatStreamStallTimeoutMs: 0 };
  }

  protected override getAgentToolOutput(_runId: string): TestEvidence {
    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const text = lastAssistant ? extractText(lastAssistant) : "";
    return parseEvidence(text);
  }

  protected override getAgentToolSummary(
    runId: string,
    output: unknown
  ): string {
    const parsed = testEvidenceSchema.safeParse(output);
    if (parsed.success) {
      return parsed.data.replayScript
        ? "Evidence and replay script collected"
        : "Evidence collected";
    }
    const summary = super.getAgentToolSummary(runId, output);
    return summary || "Evidence collected";
  }
}
