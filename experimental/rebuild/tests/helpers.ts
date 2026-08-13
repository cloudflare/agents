/**
 * Test helpers: the node:sqlite adapter for the SqlDatabase seam (the DO
 * SqlStorage adapter's twin), and a standard test agent assembly.
 */

import { DatabaseSync } from "node:sqlite";
import type {
  AgentDefinition,
  Json,
  LanguageModel,
  ToolMiddleware,
  ToolProvider
} from "../src/contract";
import type { SqlDatabase, SqlRow } from "../src/substrate";
import { defaultAdmission } from "../src/admission/default";
import { windowAssembler } from "../src/context/window-assembler";
import { defaultLoop } from "../src/harness/default-loop";
import { stepHarness } from "../src/harness/step-harness";
import { localChannel, type LocalChannel } from "../src/channels/local";

export function sqliteDb(): SqlDatabase & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  let txDepth = 0;
  return {
    raw,
    exec(query: string, ...bindings: ReadonlyArray<unknown>): SqlRow[] {
      if (/^\s*(CREATE|DROP|BEGIN|COMMIT|ROLLBACK)/i.test(query)) {
        raw.exec(query);
        return [];
      }
      const stmt = raw.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        return stmt.all(...(bindings as unknown[])) as SqlRow[];
      }
      stmt.run(...(bindings as unknown[]));
      return [];
    },
    transaction<T>(fn: () => T): T {
      if (txDepth > 0) return fn(); // join outer transaction
      raw.exec("BEGIN");
      txDepth += 1;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        txDepth -= 1;
      }
    }
  };
}

/** A readonly adding tool plus a mutating side-effect tool with a counter. */
export function testProviders(): {
  provider: ToolProvider;
  effects: string[];
  pendingCalls: string[];
} {
  const effects: string[] = [];
  const pendingCalls: string[] = [];
  const provider: ToolProvider = {
    name: "test",
    async catalog() {
      return [
        {
          name: "test/add",
          description: "Add two numbers",
          input: { type: "object" },
          effect: { effect: "readonly" }
        },
        {
          name: "test/notify",
          description: "Send a notification (side effect)",
          input: { type: "object" },
          effect: { effect: "mutating", retry: "at-least-once" }
        },
        {
          name: "test/launch",
          description: "Start a long-running job (settles later)",
          input: { type: "object" },
          effect: { effect: "mutating", retry: "at-least-once" }
        },
        {
          name: "test/delete",
          description: "Dangerous delete (requires approval)",
          input: { type: "object" },
          effect: { effect: "mutating", retry: "at-most-once" },
          approval: { mode: "always" }
        }
      ];
    },
    async execute(call, deps) {
      switch (call.name) {
        case "test/add": {
          const input = call.input as { a: number; b: number };
          return { status: "completed", output: { sum: input.a + input.b } as Json };
        }
        case "test/notify": {
          effects.push(`notify:${JSON.stringify(call.input)}`);
          return { status: "completed", output: "sent" };
        }
        case "test/launch": {
          pendingCalls.push(call.callId);
          return { status: "pending", correlation: deps.correlation };
        }
        case "test/delete": {
          effects.push(`delete:${JSON.stringify(call.input)}`);
          return { status: "completed", output: "deleted" };
        }
        default:
          return { status: "failed", message: `unknown ${call.name}`, retryable: false };
      }
    }
  };
  return { provider, effects, pendingCalls };
}

export function testAgent(config: {
  model: LanguageModel;
  providers: readonly ToolProvider[];
  middleware?: readonly ToolMiddleware[];
  maxSteps?: number;
}): { definition: AgentDefinition; channel: LocalChannel } {
  const channel = localChannel();
  const definition: AgentDefinition = {
    channels: [channel],
    admission: defaultAdmission(),
    tools: {
      providers: config.providers,
      ...(config.middleware !== undefined ? { middleware: config.middleware } : {})
    },
    harness: stepHarness({
      loop: defaultLoop(),
      model: config.model,
      context: windowAssembler({ system: "You are a test agent." }),
      policy: {
        maxSteps: config.maxSteps ?? 6,
        retry: { maxAttempts: 3, backoff: { initialMs: 10, factor: 2, maxMs: 50 } }
      }
    })
  };
  return { definition, channel };
}
