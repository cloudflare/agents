import { hasToolCall, stepCountIs, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { RunScriptOptions } from "./dynamic-runner";
import type {
  Env,
  ExplorationResult,
  ExplorationTraceEntry,
  JsonValue,
  SessionMetadata
} from "./types";

type ExplorerDeps = {
  env: Env;
  createSession: () => Promise<SessionMetadata>;
  closeSession: (sessionId: string) => Promise<SessionMetadata[]>;
  runScript: (
    sessionId: string,
    scriptCode: string,
    options?: RunScriptOptions
  ) => Promise<{ run: JsonValue; sessionId: string | null }>;
};

type SubmittedScript = {
  script: string;
  summary: string;
};

const SCRIPT_SCHEMA = z.object({
  script: z
    .string()
    .describe(
      "A complete JavaScript module that default-exports async ({ page }) => { ... }."
    )
});

export async function exploreApplication(
  description: string,
  deps: ExplorerDeps
): Promise<ExplorationResult> {
  const prompt = description.trim();
  if (!prompt) throw new Error("Describe what the browser agent should test.");

  const explorationSession = await deps.createSession();
  const trace: ExplorationTraceEntry[] = [];
  const submitted: { current: SubmittedScript | null } = { current: null };

  try {
    const workersai = createWorkersAI({ binding: deps.env.AI });
    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: `dynamic-playwright:${explorationSession.sessionId}`
      }),
      system: [
        "You are a browser automation agent writing a Puppeteer script for Cloudflare Browser Rendering.",
        "Explore the target application by calling runExplorationScript as many times as needed.",
        "The browser state is persistent: each invocation will run against the same session as the previous one, so you don't need to repeat navigation or setup steps.",
        "Every runExplorationScript response includes a screenshot object with image/jpeg base64 data from after the script finished.",
        "When you are confident of the website's behavior, call submitScript with a complete, self-contained script to test in a fresh Browser Run session.",
        "The final script must be deterministic, and must default-export `async ({ page }) => { ... }`.",
        "Return useful structured data from the final script, so a user can tell whether the task passed (not just bare assertions).",
        "Do not use network credentials, secrets, filesystem APIs, or Node.js APIs. When you see a screenshot, you should describe what you see."
      ].join("\n"),
      prompt,
      tools: {
        runExplorationScript: tool({
          description:
            "Run a Puppeteer module against the current exploratory browser session. Use this to navigate, inspect DOM text, click, type, and test candidate logic. The response includes a screenshot from after the script run.",
          inputSchema: SCRIPT_SCHEMA,
          execute: async ({ script }) => {
            const { run } = await deps.runScript(
              explorationSession.sessionId,
              script,
              { captureScreenshot: true }
            );
            console.log("yoo?");
            console.log(
              JSON.stringify(
                { script, output: withoutScreenshot(run) },
                null,
                2
              )
            );
            trace.push({
              toolName: "runExplorationScript",
              input: { script },
              output: withoutScreenshot(run)
            });
            return run;
          },
          toModelOutput: ({ output }) => {
            const screenshot = getScreenshot(output);
            console.log("Screenshot? ", !!screenshot);
            const text = JSON.stringify(
              truncateToolOutput(withoutScreenshot(output)),
              null,
              2
            );

            if (!screenshot) {
              return {
                type: "content" as const,
                value: [{ type: "text" as const, text }]
              };
            }

            return {
              type: "content" as const,
              value: [
                { type: "text" as const, text },
                {
                  type: "media" as const,
                  data: screenshot.data,
                  mediaType: screenshot.mimeType
                }
              ]
            };
          }
        }),
        submitScript: tool({
          description:
            "Submit the complete Puppeteer module to persist for future use.",
          inputSchema: SCRIPT_SCHEMA.extend({
            summary: z
              .string()
              .describe("Concise explanation of what the script checks.")
          }),
          execute: async ({ script, summary }) => {
            submitted.current = { script, summary };
            const output = { accepted: true, summary } satisfies JsonValue;
            trace.push({
              toolName: "submitScript",
              input: { script, summary },
              output
            });
            return output;
          }
        })
      },
      stopWhen: [hasToolCall("submitScript"), stepCountIs(8)]
    });

    const textLog = createLineLogger("[dynamic-playwright:explore:text]");
    const reasoningLog = createLineLogger(
      "[dynamic-playwright:explore:reasoning]"
    );

    for await (const part of result.fullStream) {
      if (part.type === "reasoning-start") {
        reasoningLog.start();
      }
      if (part.type === "reasoning-delta") {
        reasoningLog.write(part.text);
      }
      if (part.type === "text-start") {
        textLog.start();
      }
      if (part.type === "text-delta") {
        textLog.write(part.text);
      }
    }
    reasoningLog.flush();
    textLog.flush();

    if (!submitted.current) {
      throw new Error(
        "The browser agent did not submit a final script before the exploration limit."
      );
    }

    const testSession = await deps.createSession();
    const testRun = await deps.runScript(
      testSession.sessionId,
      submitted.current.script
    );

    return {
      description: prompt,
      explorationSessionId: explorationSession.sessionId,
      testSessionId: testRun.sessionId,
      summary: submitted.current.summary || (await result.text),
      script: submitted.current.script,
      trace,
      run: testRun.run
    };
  } finally {
    await deps.closeSession(explorationSession.sessionId).catch(() => []);
  }
}

function truncateJson(value: JsonValue, maxLength: number): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) return value;
  return `${serialized.slice(0, maxLength)}... [truncated]`;
}

function truncateToolOutput(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return truncateJson(value, 6_000);
  }

  const output: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = key === "screenshot" ? nested : truncateJson(nested, 6_000);
  }
  return output;
}

function withoutScreenshot(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { screenshot: _screenshot, ...rest } = value;
  return rest;
}

function getScreenshot(
  value: JsonValue
): { data: string; mimeType: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const screenshot = value.screenshot;
  if (
    !screenshot ||
    typeof screenshot !== "object" ||
    Array.isArray(screenshot)
  ) {
    return null;
  }
  const data = screenshot.data;
  const mimeType = screenshot.mimeType;
  if (typeof data !== "string" || typeof mimeType !== "string") return null;
  return { data, mimeType };
}

function createLineLogger(prefix: string): {
  start: () => void;
  write: (delta: string) => void;
  flush: () => void;
} {
  let buffer = "";

  return {
    start() {
      this.flush();
      console.debug(prefix, "started");
    },
    write(delta) {
      buffer += delta;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line) console.debug(prefix, line);
      }
    },
    flush() {
      if (!buffer) return;
      console.debug(prefix, buffer);
      buffer = "";
    }
  };
}
