/** Seed project placed under `/harness` for a new self-modifying harness object. */
export const SEED_HARNESS_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify(
    {
      name: "self-modifying-harness",
      private: true,
      type: "module"
    },
    null,
    2
  ),
  "src/types.ts": `export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export type Message = {
  role: "user" | "assistant";
  content: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: { [key: string]: Json };
};

export type ToolCall = {
  callId: string;
  name: string;
  input: Json;
};

export type InferenceResult = {
  text: string;
  finishReason: string;
  toolCalls: ToolCall[];
};

export type TurnInput = {
  turnId: string;
  prompt: string;
  revisionId: number;
  history: Message[];
};

export type TurnResult = {
  output: string;
  rounds: number;
  isolateRun: number;
  metadata?: { [key: string]: Json };
};

export type Host = {
  infer(request: {
    round: number;
    system: string;
    messages: Message[];
    customTools: ToolDefinition[];
  }): Promise<InferenceResult>;
  callTool(callId: string, name: string, input: Json): Promise<Json>;
  note(key: string, text: string): Promise<void>;
};

export type CustomTool = {
  definition: ToolDefinition;
  execute(input: Json, turn: TurnInput, host: Host): Promise<Json> | Json;
};
`,
  "src/identity.ts": `export const IDENTITY = \`PERSONA: precise

You are a self-modifying agent running in a fresh Dynamic Worker for each
turn. Your complete editable harness source is under /harness.

When asked to change yourself, use the available tools instead of only
explaining the change:
1. inspect the relevant source with read_file and list_files;
2. edit it with write_file;
3. call activate_harness;
4. report the new revision. The current turn keeps running the old revision.

To add a Custom tool, write its implementation in a new file under src/tools/
and activate the harness. Follow src/tools/describe-self.ts as the pattern.
Activation discovers every CustomTool exported by src/tools/*.ts automatically.
Custom tools execute inside your Dynamic Worker. System tools are fixed trusted
capabilities for source access, activation, revisions, and the journal.

Use describe_self to inspect the revision executing this turn. Change the
model loop by editing src/index.ts. The trusted host retains the revision
ledger, append-only journal, model binding, and activation gate.\`;
`,
  "src/tools/describe-self.ts": `import type { CustomTool } from "../types";

export const describeSelfTool: CustomTool = {
  definition: {
    name: "describe_self",
    description: "Describe the editable harness revision executing this turn.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },

  async execute(_input, turn, host) {
    await host.note(
      "describe-self-" + turn.revisionId,
      "describe_self ran in revision " + turn.revisionId
    );
    return {
      name: "self-modifying-harness",
      revisionId: turn.revisionId,
      editableEntry: "/harness/src/index.ts"
    };
  }
};
`,
  "src/index.ts": `import { IDENTITY } from "./identity";
import {
  CUSTOM_TOOL_DEFINITIONS,
  runCustomTool
} from "self-modifying:custom-tools";
import type { Host, Json, Message, TurnInput, TurnResult } from "./types";

let isolateRuns = 0;

function toolTrace(name: string, output: Json): string {
  return "Tool " + name + " returned:\\n" + JSON.stringify(output);
}

export default {
  manifest: { name: "self-modifying-harness", version: "1" },

  async runTurn(input: TurnInput, host: Host): Promise<TurnResult> {
    isolateRuns += 1;
    const messages: Message[] = [
      ...input.history,
      { role: "user", content: input.prompt }
    ];
    const customTools = CUSTOM_TOOL_DEFINITIONS;

    for (let round = 1; round <= 12; round++) {
      const inference = await host.infer({
        round,
        system: IDENTITY,
        messages,
        customTools
      });

      if (inference.toolCalls.length === 0) {
        return {
          output: inference.text,
          rounds: round,
          isolateRun: isolateRuns,
          metadata: { harness: "self-modifying-harness" }
        };
      }

      messages.push({
        role: "assistant",
        content:
          inference.text ||
          "I will run " + inference.toolCalls.map((call) => call.name).join(", ") + "."
      });

      for (const call of inference.toolCalls) {
        const custom = await runCustomTool(call, input, host);
        const output =
          custom === undefined
            ? await host.callTool(call.callId, call.name, call.input)
            : custom;
        messages.push({ role: "user", content: toolTrace(call.name, output) });
      }
    }

    return {
      output: "The harness reached its twelve-round limit.",
      rounds: 12,
      isolateRun: isolateRuns,
      metadata: { harness: "self-modifying-harness", limitReached: true }
    };
  }
};
`
};
