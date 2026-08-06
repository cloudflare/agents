import {
  CodemodeConnector,
  type ConnectorTools,
  type ExecutionEndStatus,
  type ToolExecuteContext
} from "@cloudflare/codemode";
import {
  MAX_CONTEXT_OUTPUT_CHARS,
  boundedInteger,
  isRecord,
  normalizeHarnessApply,
  requireString,
  truncateText,
  type HarnessKind
} from "./core";
import { ThinkStore, type ChildRecord } from "./store";

export type ExecutionSummary = {
  id: string;
  status: string;
  code: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type RlmQueryInput = {
  key: string;
  prompt: string;
  material: string;
  name?: string;
};

export type RlmFollowupInput = {
  key: string;
  childId: string;
  prompt: string;
  material: string;
};

export type RlmHost = {
  query(input: RlmQueryInput, executionId: string): Promise<ChildRecord>;
  spawn(input: RlmQueryInput, executionId: string): Promise<ChildRecord>;
  followup(input: RlmFollowupInput, executionId: string): Promise<ChildRecord>;
  status(childId: string): Promise<ChildRecord | undefined>;
  list(limit: number): ChildRecord[];
  answerInfo(childId: string): Promise<
    | {
        ready: boolean;
        chars: number;
        status: string;
      }
    | undefined
  >;
  answerSlice(
    childId: string,
    start: number,
    length: number
  ): Promise<
    { start: number; end: number; total: number; content: string } | undefined
  >;
};

function argsRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("connector input must be an object");
  return value;
}

function optionalMaterial(value: unknown): string {
  if (value === undefined || value === null) return "";
  return requireString(value, "material", { max: 250_000 });
}

function executionId(context: ToolExecuteContext | undefined): string {
  if (!context?.executionId) {
    throw new Error("RLM mutation requires a Code Mode execution id");
  }
  return context.executionId;
}

function harnessKind(value: unknown): HarnessKind {
  if (
    value !== "prompt" &&
    value !== "memory" &&
    value !== "skill" &&
    value !== "subagent"
  ) {
    throw new Error("kind must be prompt, memory, skill, or subagent");
  }
  return value;
}

abstract class ScopedConnector extends CodemodeConnector<Env> {
  readonly #auditStore: ThinkStore;
  readonly #auditScope: string;
  readonly #auditInputId: string;
  readonly #auditRunMode: "think" | "refine";

  constructor(
    ctx: DurableObjectState,
    env: Env,
    store: ThinkStore,
    scope: string,
    inputId: string,
    runMode: "think" | "refine"
  ) {
    super(ctx, env);
    this.#auditStore = store;
    this.#auditScope = scope;
    this.#auditInputId = inputId;
    this.#auditRunMode = runMode;
  }

  override async executeTool(
    method: string,
    args: unknown,
    context?: ToolExecuteContext
  ): Promise<unknown> {
    if (context) {
      this.#auditStore.bindExecution({
        executionId: context.executionId,
        scope: this.#auditScope,
        inputId: this.#auditInputId,
        runMode: this.#auditRunMode
      });
    }
    return super.executeTool(method, args, context);
  }

  override async disposeExecution(
    executionId: string,
    status: ExecutionEndStatus
  ): Promise<void> {
    this.#auditStore.finalizeExecution({
      executionId,
      scope: this.#auditScope,
      inputId: this.#auditInputId,
      runMode: this.#auditRunMode,
      status
    });
  }
}

export class ContextConnector extends ScopedConnector {
  readonly #store: ThinkStore;
  readonly #scope: string;
  readonly #inputId: string;
  readonly #executions: (limit: number) => Promise<ExecutionSummary[]>;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    store: ThinkStore,
    scope: string,
    inputId: string,
    runMode: "think" | "refine",
    executions: (limit: number) => Promise<ExecutionSummary[]>
  ) {
    super(ctx, env, store, scope, inputId, runMode);
    this.#store = store;
    this.#scope = scope;
    this.#inputId = inputId;
    this.#executions = executions;
  }

  name(): string {
    return "context";
  }

  protected instructions(): string {
    return (
      "Read the external task/material and persistent transcript in bounded " +
      "slices. Start with info; use inputs to recover prior turns; search before reading broad ranges."
    );
  }

  #resolveInputId(value: unknown): string {
    if (value === undefined || value === null) return this.#inputId;
    const id = requireString(value, "inputId", { min: 1, max: 100 });
    if (!this.#store.inputVisibleFrom(this.#scope, this.#inputId, id)) {
      throw new Error(`input ${id} is not visible from the active turn`);
    }
    return id;
  }

  protected tools(): ConnectorTools {
    return {
      info: {
        description:
          "Return current input sizes, scope, transcript size, and harness revision.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        replay: "reexecute",
        execute: () => {
          const meta = this.#store.inputMeta(this.#inputId);
          return {
            ...meta,
            messages: this.#store.messageCount(this.#scope),
            harnessRevision: this.#store.harness().revision,
            maxSliceChars: MAX_CONTEXT_OUTPUT_CHARS
          };
        }
      },
      inputs: {
        description:
          "List current and prior external inputs for this scope. Use an id with slice/searchInput to recover long-session context.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }
          },
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) =>
          this.#store.inputs(
            this.#scope,
            this.#inputId,
            boundedInteger(argsRecord(value).limit, 20, 1, 100)
          )
      },
      slice: {
        description:
          "Read a bounded character range from the current or a prior task/material in this scope.",
        inputSchema: {
          type: "object",
          properties: {
            inputId: { type: "string", minLength: 1, maxLength: 100 },
            source: { type: "string", enum: ["task", "material"] },
            start: { type: "integer", minimum: 0, default: 0 },
            length: {
              type: "integer",
              minimum: 1,
              maximum: MAX_CONTEXT_OUTPUT_CHARS,
              default: 4000
            }
          },
          required: ["source"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const args = argsRecord(value);
          return this.#store.inputSlice(
            this.#resolveInputId(args.inputId),
            args.source,
            args.start,
            args.length
          );
        }
      },
      searchInput: {
        description:
          "Find literal text in the current or a prior task/material in this scope and return bounded snippets with offsets.",
        inputSchema: {
          type: "object",
          properties: {
            inputId: { type: "string", minLength: 1, maxLength: 100 },
            source: { type: "string", enum: ["task", "material"] },
            query: { type: "string", minLength: 2, maxLength: 500 },
            limit: { type: "integer", minimum: 1, maximum: 20, default: 8 }
          },
          required: ["source", "query"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const args = argsRecord(value);
          return this.#store.searchInput(
            this.#resolveInputId(args.inputId),
            args.source,
            args.query,
            args.limit
          );
        }
      },
      history: {
        description:
          "Return recent transcript messages for this agent scope, newest first.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50, default: 12 },
            beforeId: { type: "integer", minimum: 1 },
            contentChars: {
              type: "integer",
              minimum: 200,
              maximum: MAX_CONTEXT_OUTPUT_CHARS,
              default: 2000
            }
          },
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const args = argsRecord(value);
          return this.#store.history(this.#scope, {
            limit: boundedInteger(args.limit, 12, 1, 50),
            beforeId:
              typeof args.beforeId === "number"
                ? Math.trunc(args.beforeId)
                : undefined,
            contentChars: boundedInteger(
              args.contentChars,
              2_000,
              200,
              MAX_CONTEXT_OUTPUT_CHARS
            )
          });
        }
      },
      message: {
        description:
          "Read one bounded transcript message preview by numeric id, including its total character count.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "integer", minimum: 1 } },
          required: ["id"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const args = argsRecord(value);
          if (typeof args.id !== "number")
            throw new Error("id must be a number");
          const message = this.#store.message(this.#scope, Math.trunc(args.id));
          return message
            ? {
                ...message,
                content: truncateText(
                  message.content,
                  MAX_CONTEXT_OUTPUT_CHARS
                ),
                totalChars: message.content.length
              }
            : null;
        }
      },
      messageSlice: {
        description:
          "Read a bounded character range from one full transcript message.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "integer", minimum: 1 },
            start: { type: "integer", minimum: 0, default: 0 },
            length: {
              type: "integer",
              minimum: 1,
              maximum: MAX_CONTEXT_OUTPUT_CHARS,
              default: 4000
            }
          },
          required: ["id"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const args = argsRecord(value);
          if (typeof args.id !== "number")
            throw new Error("id must be a number");
          return (
            this.#store.messageSlice(
              this.#scope,
              Math.trunc(args.id),
              args.start,
              args.length
            ) ?? null
          );
        }
      },
      searchHistory: {
        description:
          "Search the persistent transcript for literal text and return matching messages.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 2, maxLength: 500 },
            limit: { type: "integer", minimum: 1, maximum: 20, default: 8 }
          },
          required: ["query"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const args = argsRecord(value);
          return this.#store.searchHistory(this.#scope, args.query, args.limit);
        }
      },
      executions: {
        description:
          "Return bounded summaries of prior Code Mode programs and outcomes.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 25, default: 8 }
          },
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const args = argsRecord(value);
          return this.#executions(boundedInteger(args.limit, 8, 1, 25));
        }
      }
    };
  }
}

export class KernelConnector extends ScopedConnector {
  readonly #store: ThinkStore;
  readonly #scope: string;
  readonly #inputId: string;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    store: ThinkStore,
    scope: string,
    inputId: string,
    runMode: "think" | "refine"
  ) {
    super(ctx, env, store, scope, inputId, runMode);
    this.#store = store;
    this.#scope = scope;
    this.#inputId = inputId;
  }

  name(): string {
    return "kernel";
  }

  protected instructions(): string {
    return (
      "Durable JSON notebook state. Local JavaScript variables are ephemeral; " +
      "store useful intermediate state here and call finish for the final answer."
    );
  }

  protected tools(): ConnectorTools {
    return {
      get: {
        description: "Read a JSON value from durable kernel state.",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string", minLength: 1, maxLength: 120 } },
          required: ["key"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) =>
          this.#store.kernelValue(this.#scope, argsRecord(value).key)
      },
      set: {
        description:
          "Write a JSON-serializable value to durable kernel state for later Code Mode calls or turns.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 120 },
            value: {}
          },
          required: ["key", "value"],
          additionalProperties: false
        },
        execute: (value) => {
          const args = argsRecord(value);
          return {
            key: requireString(args.key, "key", { min: 1, max: 120 }),
            value: this.#store.setKernelValue(this.#scope, args.key, args.value)
          };
        }
      },
      list: {
        description: "List durable kernel keys, sizes, and update times.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        replay: "reexecute",
        execute: () => this.#store.kernelKeys(this.#scope)
      },
      delete: {
        description: "Delete one durable kernel value.",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string", minLength: 1, maxLength: 120 } },
          required: ["key"],
          additionalProperties: false
        },
        execute: (value) => {
          const args = argsRecord(value);
          return {
            deleted: this.#store.deleteKernelValue(this.#scope, args.key)
          };
        }
      },
      status: {
        description:
          "Check whether the current input already has a finished answer.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        replay: "reexecute",
        execute: () => {
          const answer = this.#store.answer(this.#inputId);
          return {
            ready: answer !== undefined,
            answerChars: answer?.length ?? 0
          };
        }
      },
      finish: {
        description:
          "Set the final answer for the current input. This is the only completion protocol.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1, maxLength: 100000 }
          },
          required: ["content"],
          additionalProperties: false
        },
        execute: (value, context) => {
          const content = this.#store.finish(
            this.#scope,
            this.#inputId,
            argsRecord(value).content,
            context?.executionId
          );
          return { ready: true, chars: content.length };
        }
      }
    };
  }
}

export class HarnessConnector extends ScopedConnector {
  readonly #store: ThinkStore;
  readonly #allowWrites: boolean;
  readonly #turnInputId: string;
  readonly #snippetNames: () => Promise<ReadonlySet<string>>;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    store: ThinkStore,
    scope: string,
    turnInputId: string,
    runMode: "think" | "refine",
    allowWrites: boolean,
    snippetNames: () => Promise<ReadonlySet<string>> = async () => new Set()
  ) {
    super(ctx, env, store, scope, turnInputId, runMode);
    this.#store = store;
    this.#allowWrites = allowWrites;
    this.#turnInputId = turnInputId;
    this.#snippetNames = snippetNames;
  }

  name(): string {
    return "harness";
  }

  protected instructions(): string {
    return this.#allowWrites
      ? "Inspect and atomically refine versioned supplemental harness state. Base instructions are immutable."
      : "Read versioned supplemental prompt, memory, skill-reference, and subagent state. Writes are available only in an explicit refine turn.";
  }

  protected tools(): ConnectorTools {
    const tools: ConnectorTools = {
      overview: {
        description:
          "Return a bounded routing overview and current harness revision.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        replay: "reexecute",
        execute: () => this.#store.harnessOverview()
      },
      list: {
        description:
          "List full harness entries, optionally restricted to one kind.",
        inputSchema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["prompt", "memory", "skill", "subagent"]
            },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }
          },
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const args = argsRecord(value);
          const kind =
            args.kind === undefined ? undefined : harnessKind(args.kind);
          return this.#store.harnessEntries(
            kind,
            boundedInteger(args.limit, 20, 1, 50)
          );
        }
      },
      get: {
        description: "Read one full harness entry by kind and id.",
        inputSchema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["prompt", "memory", "skill", "subagent"]
            },
            id: { type: "string", minLength: 1, maxLength: 80 }
          },
          required: ["kind", "id"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const args = argsRecord(value);
          const kind = harnessKind(args.kind);
          const id = requireString(args.id, "id", { min: 1, max: 80 });
          return this.#store.harnessEntry(kind, id) ?? null;
        }
      },
      revisions: {
        description: "List versioned refinement and rollback records.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }
          },
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) =>
          this.#store.harnessRevisions(
            boundedInteger(argsRecord(value).limit, 20, 1, 100)
          )
      }
    };

    if (this.#allowWrites) {
      tools.apply = {
        description:
          "Atomically apply a small evidence-backed create/update/delete proposal at an expected revision.",
        inputSchema: {
          type: "object",
          properties: {
            expectedRevision: { type: "integer", minimum: 0 },
            trigger: { type: "string", minLength: 1, maxLength: 1000 },
            evidence: { type: "string", minLength: 1, maxLength: 8000 },
            expectedOutcome: {
              type: "string",
              minLength: 1,
              maxLength: 4000
            },
            edits: {
              type: "array",
              minItems: 1,
              maxItems: 12,
              items: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["create", "update", "delete"]
                  },
                  kind: {
                    type: "string",
                    enum: ["prompt", "memory", "skill", "subagent"]
                  },
                  id: { type: "string", maxLength: 80 },
                  title: { type: "string", maxLength: 240 },
                  content: { type: "string", maxLength: 12000 },
                  path: { type: "string", maxLength: 240 },
                  reference: { type: "object" },
                  arguments: { type: "object" },
                  metadata: { type: "object" },
                  reason: { type: "string", minLength: 1, maxLength: 1000 }
                },
                required: ["action", "kind", "reason"],
                additionalProperties: false
              }
            }
          },
          required: [
            "expectedRevision",
            "trigger",
            "evidence",
            "expectedOutcome",
            "edits"
          ],
          additionalProperties: false
        },
        execute: async (value) => {
          const request = normalizeHarnessApply(value);
          const requiredSnippets = request.edits
            .filter((edit) => edit.kind === "skill" && edit.action !== "delete")
            .map((edit) => String(edit.reference.name));
          if (requiredSnippets.length > 0) {
            const available = await this.#snippetNames();
            const missing = requiredSnippets.filter(
              (name) => !available.has(name)
            );
            if (missing.length > 0) {
              throw new Error(
                `skill refinement references unpromoted Code Mode snippet(s): ${missing.join(", ")}`
              );
            }
          }
          const result = this.#store.applyHarness(request, this.#turnInputId);
          return {
            revision: result.state.revision,
            changes: result.changes,
            refinement: result.state.refinements.at(-1)
          };
        }
      };
      tools.rollback = {
        description:
          "Restore the entry snapshot from an earlier revision while recording a new monotonic revision.",
        inputSchema: {
          type: "object",
          properties: {
            targetRevision: { type: "integer", minimum: 0 },
            evidence: { type: "string", minLength: 1, maxLength: 8000 }
          },
          required: ["targetRevision", "evidence"],
          additionalProperties: false
        },
        execute: (value) => {
          const args = argsRecord(value);
          const state = this.#store.rollbackHarness(
            args.targetRevision,
            args.evidence,
            this.#turnInputId
          );
          return {
            revision: state.revision,
            refinement: state.refinements.at(-1)
          };
        }
      };
    }

    return tools;
  }
}

export class RlmConnector extends ScopedConnector {
  readonly #host: RlmHost;
  readonly #depth: number;
  readonly #maxDepth: number;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    store: ThinkStore,
    scope: string,
    inputId: string,
    runMode: "think" | "refine",
    host: RlmHost,
    depth: number,
    maxDepth: number
  ) {
    super(ctx, env, store, scope, inputId, runMode);
    this.#host = host;
    this.#depth = depth;
    this.#maxDepth = maxDepth;
  }

  name(): string {
    return "rlm";
  }

  protected instructions(): string {
    return this.#depth < this.#maxDepth
      ? "Programmatic recursive model calls. query waits for one result; spawn admits a retained child and returns immediately."
      : "Recursive depth is exhausted. Inspect existing child status only; new query/spawn/followup calls fail.";
  }

  protected tools(): ConnectorTools {
    return {
      query: {
        description:
          "Run one bounded Code Mode child synchronously and return its completed answer. The stable key makes replay idempotent.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 80 },
            prompt: { type: "string", minLength: 1, maxLength: 32000 },
            material: { type: "string", maxLength: 250000 },
            name: { type: "string", maxLength: 80 }
          },
          required: ["key", "prompt"],
          additionalProperties: false
        },
        execute: (value, context) => {
          const args = argsRecord(value);
          return this.#host.query(
            {
              key: requireString(args.key, "key", { min: 1, max: 80 }),
              prompt: requireString(args.prompt, "prompt", {
                min: 1,
                max: 32_000
              }),
              material: optionalMaterial(args.material),
              name:
                args.name === undefined
                  ? undefined
                  : requireString(args.name, "name", { max: 80 })
            },
            executionId(context)
          );
        }
      },
      spawn: {
        description:
          "Admit a retained child session and return its handle immediately. The answer arrives later through status; admission is not completion.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 80 },
            prompt: { type: "string", minLength: 1, maxLength: 32000 },
            material: { type: "string", maxLength: 250000 },
            name: { type: "string", maxLength: 80 }
          },
          required: ["key", "prompt"],
          additionalProperties: false
        },
        execute: (value, context) => {
          const args = argsRecord(value);
          return this.#host.spawn(
            {
              key: requireString(args.key, "key", { min: 1, max: 80 }),
              prompt: requireString(args.prompt, "prompt", {
                min: 1,
                max: 32_000
              }),
              material: optionalMaterial(args.material),
              name:
                args.name === undefined
                  ? undefined
                  : requireString(args.name, "name", { max: 80 })
            },
            executionId(context)
          );
        }
      },
      followup: {
        description:
          "Admit a follow-up turn into an existing retained child; returns immediately with the updated handle.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 80 },
            childId: { type: "string", minLength: 1, maxLength: 100 },
            prompt: { type: "string", minLength: 1, maxLength: 32000 },
            material: { type: "string", maxLength: 250000 }
          },
          required: ["key", "childId", "prompt"],
          additionalProperties: false
        },
        execute: (value, context) => {
          const args = argsRecord(value);
          return this.#host.followup(
            {
              key: requireString(args.key, "key", { min: 1, max: 80 }),
              childId: requireString(args.childId, "childId", {
                min: 1,
                max: 100
              }),
              prompt: requireString(args.prompt, "prompt", {
                min: 1,
                max: 32_000
              }),
              material: optionalMaterial(args.material)
            },
            executionId(context)
          );
        }
      },
      status: {
        description:
          "Inspect one admitted child. Persistent children retain transcript and kernel state across follow-ups.",
        inputSchema: {
          type: "object",
          properties: {
            childId: { type: "string", minLength: 1, maxLength: 100 }
          },
          required: ["childId"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: async (value) => {
          const childId = requireString(argsRecord(value).childId, "childId", {
            min: 1,
            max: 100
          });
          return (await this.#host.status(childId)) ?? null;
        }
      },
      list: {
        description: "List direct child handles for the current parent scope.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }
          },
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) =>
          this.#host.list(boundedInteger(argsRecord(value).limit, 20, 1, 100))
      },
      answerInfo: {
        description:
          "Return the full answer size and readiness for a direct child without loading the answer.",
        inputSchema: {
          type: "object",
          properties: {
            childId: { type: "string", minLength: 1, maxLength: 100 }
          },
          required: ["childId"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: async (value) => {
          const childId = requireString(argsRecord(value).childId, "childId", {
            min: 1,
            max: 100
          });
          return (await this.#host.answerInfo(childId)) ?? null;
        }
      },
      answerSlice: {
        description:
          "Read a bounded character range from a completed direct child's full environment-backed answer.",
        inputSchema: {
          type: "object",
          properties: {
            childId: { type: "string", minLength: 1, maxLength: 100 },
            start: { type: "integer", minimum: 0, default: 0 },
            length: {
              type: "integer",
              minimum: 1,
              maximum: MAX_CONTEXT_OUTPUT_CHARS,
              default: 4000
            }
          },
          required: ["childId"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: async (value) => {
          const args = argsRecord(value);
          const childId = requireString(args.childId, "childId", {
            min: 1,
            max: 100
          });
          return (
            (await this.#host.answerSlice(
              childId,
              boundedInteger(args.start, 0, 0, Number.MAX_SAFE_INTEGER),
              boundedInteger(args.length, 4_000, 1, MAX_CONTEXT_OUTPUT_CHARS)
            )) ?? null
          );
        }
      }
    };
  }
}
