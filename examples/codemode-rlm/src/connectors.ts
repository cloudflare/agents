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
  normalizeHarnessUpdate,
  requireString
} from "./core";
import { RlmStore } from "./store";

export type RlmTask = {
  key: string;
  prompt: string;
  material: string;
};

export type RlmFollowup = {
  key: string;
  childId: string;
  prompt: string;
  material: string;
};

export type ChildTurn = {
  childId: string;
  inputId?: string;
  status: "missing" | "admitted" | "running" | "completed" | "error";
  answer?: string;
  answerChars?: number;
  error?: string;
  createdAt?: number;
};

export type RlmHost = {
  query(input: RlmTask): Promise<ChildTurn>;
  spawn(input: RlmTask): Promise<ChildTurn>;
  followup(input: RlmFollowup): Promise<ChildTurn>;
  status(childId: string, inputId?: string): Promise<ChildTurn>;
  list(limit: number): Promise<ChildTurn[]>;
  read(
    childId: string,
    inputId: string | undefined,
    start: number,
    length: number
  ): Promise<{
    start: number;
    end: number;
    total: number;
    content: string;
  } | null>;
};

function args(value: unknown, optional = false): Record<string, unknown> {
  if (optional && value === undefined) return {};
  if (!isRecord(value)) throw new Error("connector input must be an object");
  return value;
}

function optionalMaterial(value: unknown): string {
  return value === undefined || value === null
    ? ""
    : requireString(value, "material", { max: 250_000 });
}

function optionalInputId(value: unknown): string | undefined {
  return value === undefined || value === null
    ? undefined
    : requireString(value, "inputId", { min: 1, max: 120 });
}

export class ContextConnector extends CodemodeConnector<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    readonly store: RlmStore,
    readonly scope: string,
    readonly inputId: string
  ) {
    super(ctx, env);
  }

  name(): string {
    return "context";
  }

  protected instructions(): string {
    return "Treat the current and prior external inputs as variables. Inspect metadata, then search or read bounded slices.";
  }

  #resolveInputId(value: unknown): string {
    const id = optionalInputId(value) ?? this.inputId;
    if (!this.store.inputVisibleFrom(this.scope, this.inputId, id)) {
      throw new Error(`input ${id} is not visible from this turn`);
    }
    return id;
  }

  protected tools(): ConnectorTools {
    return {
      info: {
        description:
          "Return metadata for the active external input and harness.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        replay: "reexecute",
        execute: () => ({
          ...this.store.inputMeta(this.inputId),
          harnessRevision: this.store.harness().revision,
          maxSliceChars: MAX_CONTEXT_OUTPUT_CHARS
        })
      },
      inputs: {
        description: "List current and prior causally visible external inputs.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }
          },
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) =>
          this.store.inputs(
            this.scope,
            this.inputId,
            boundedInteger(args(value, true).limit, 20, 1, 50)
          )
      },
      slice: {
        description: "Read a bounded range from a task or its large material.",
        inputSchema: {
          type: "object",
          properties: {
            inputId: { type: "string", minLength: 1, maxLength: 120 },
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
          const input = args(value);
          return this.store.inputSlice(
            this.#resolveInputId(input.inputId),
            input.source,
            input.start,
            input.length
          );
        }
      },
      search: {
        description: "Search literal text in a task or its large material.",
        inputSchema: {
          type: "object",
          properties: {
            inputId: { type: "string", minLength: 1, maxLength: 120 },
            source: { type: "string", enum: ["task", "material"] },
            query: { type: "string", minLength: 2, maxLength: 500 },
            limit: { type: "integer", minimum: 1, maximum: 20, default: 8 }
          },
          required: ["source", "query"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const input = args(value);
          return this.store.searchInput(
            this.#resolveInputId(input.inputId),
            input.source,
            input.query,
            input.limit
          );
        }
      },
      history: {
        description:
          "Return bounded previews of prior user and verified assistant turns.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 30, default: 12 }
          },
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) =>
          this.store.history(
            this.scope,
            boundedInteger(args(value, true).limit, 12, 1, 30)
          )
      }
    };
  }
}

export class KernelConnector extends CodemodeConnector<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    readonly store: RlmStore,
    readonly scope: string,
    readonly inputId: string
  ) {
    super(ctx, env);
  }

  name(): string {
    return "kernel";
  }

  protected instructions(): string {
    return "Durable JSON notebook state. JavaScript variables are ephemeral; save useful state here and call finish for the final answer.";
  }

  protected tools(): ConnectorTools {
    const keySchema = {
      type: "object" as const,
      properties: {
        key: { type: "string" as const, minLength: 1, maxLength: 120 }
      },
      required: ["key"],
      additionalProperties: false
    };
    return {
      get: {
        description:
          "Read and return one durable JSON value directly. The result is the stored value, not a { value } wrapper.",
        inputSchema: keySchema,
        replay: "reexecute",
        execute: (value) => this.store.getKernel(this.scope, args(value).key)
      },
      set: {
        description: "Persist one JSON-serializable value.",
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
          const input = args(value);
          return {
            key: input.key,
            value: this.store.setKernel(this.scope, input.key, input.value)
          };
        }
      },
      list: {
        description: "List durable notebook keys.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        replay: "reexecute",
        execute: () => this.store.listKernel(this.scope)
      },
      delete: {
        description: "Idempotently delete one durable notebook value.",
        inputSchema: keySchema,
        execute: (value) => {
          const key = args(value).key;
          this.store.deleteKernel(this.scope, key);
          return { deleted: true, key };
        }
      },
      finish: {
        description:
          "Store the final answer for this input. The host verifies the enclosing Code Mode execution before serving it.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1, maxLength: 100000 }
          },
          required: ["content"],
          additionalProperties: false
        },
        execute: (value, context?: ToolExecuteContext) => {
          const content = this.store.stageAnswer(
            this.scope,
            this.inputId,
            args(value).content,
            context?.executionId
          );
          return { staged: true, chars: content.length };
        }
      }
    };
  }

  override async disposeExecution(
    executionId: string,
    status: ExecutionEndStatus
  ): Promise<void> {
    if (status === "completed") {
      this.store.verifyAnswer(this.inputId, executionId);
    } else {
      this.store.discardAnswer(this.inputId, executionId);
    }
  }
}

export class HarnessConnector extends CodemodeConnector<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    readonly store: RlmStore,
    readonly allowWrites: boolean,
    readonly inputId: string
  ) {
    super(ctx, env);
  }

  name(): string {
    return "harness";
  }

  protected instructions(): string {
    return this.allowWrites
      ? "Read or update the small versioned continual harness. Make only evidence-backed changes."
      : "Read the small versioned continual harness. Writes exist only in an explicit refinement turn.";
  }

  protected tools(): ConnectorTools {
    const tools: ConnectorTools = {
      read: {
        description:
          "Read the complete supplemental harness and recent revision metadata.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        replay: "reexecute",
        execute: () => ({
          state: this.store.harness(),
          revisions: this.store.harnessRevisions(10)
        })
      }
    };
    if (this.allowWrites) {
      tools.update = {
        description:
          "Atomically upsert or remove a few entries at an expected revision.",
        inputSchema: {
          type: "object",
          properties: {
            expectedRevision: { type: "integer", minimum: 0 },
            reason: { type: "string", minLength: 1, maxLength: 1000 },
            evidence: { type: "string", minLength: 1, maxLength: 8000 },
            upsert: {
              type: "array",
              maxItems: 12,
              items: {
                type: "object",
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 80 },
                  kind: {
                    type: "string",
                    enum: ["instruction", "memory", "delegate"]
                  },
                  content: { type: "string", minLength: 1, maxLength: 12000 }
                },
                required: ["id", "kind", "content"],
                additionalProperties: false
              }
            },
            remove: {
              type: "array",
              maxItems: 12,
              items: { type: "string", minLength: 1, maxLength: 80 }
            }
          },
          required: ["expectedRevision", "reason", "evidence"],
          additionalProperties: false
        },
        execute: (value) =>
          this.store.updateHarness(this.inputId, normalizeHarnessUpdate(value))
      };
      tools.rollback = {
        description:
          "Restore an earlier harness snapshot as a new monotonic revision.",
        inputSchema: {
          type: "object",
          properties: {
            expectedRevision: { type: "integer", minimum: 0 },
            targetRevision: { type: "integer", minimum: 0 },
            evidence: { type: "string", minLength: 1, maxLength: 8000 }
          },
          required: ["expectedRevision", "targetRevision", "evidence"],
          additionalProperties: false
        },
        execute: (value) => {
          const input = args(value);
          return this.store.rollbackHarness(
            this.inputId,
            input.expectedRevision,
            input.targetRevision,
            input.evidence
          );
        }
      };
    }
    return tools;
  }
}

export class RlmConnector extends CodemodeConnector<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    readonly host: RlmHost
  ) {
    super(ctx, env);
  }

  name(): string {
    return "rlm";
  }

  protected instructions(): string {
    return "Delegate bounded semantic work to depth-one Think agents. Stable keys make query, spawn, and follow-up replay-safe.";
  }

  #task(value: unknown): RlmTask {
    const input = args(value);
    return {
      key: requireString(input.key, "key", { min: 1, max: 80 }),
      prompt: requireString(input.prompt, "prompt", { min: 1, max: 32_000 }),
      material: optionalMaterial(input.material)
    };
  }

  protected tools(): ConnectorTools {
    const taskProperties = {
      key: { type: "string" as const, minLength: 1, maxLength: 80 },
      prompt: { type: "string" as const, minLength: 1, maxLength: 32000 },
      material: { type: "string" as const, maxLength: 250000 }
    };
    return {
      query: {
        description:
          "Run one idempotent child turn and wait for its bounded answer.",
        inputSchema: {
          type: "object",
          properties: taskProperties,
          required: ["key", "prompt"],
          additionalProperties: false
        },
        execute: (value) => this.host.query(this.#task(value))
      },
      spawn: {
        description: "Admit work to a retained child and return immediately.",
        inputSchema: {
          type: "object",
          properties: taskProperties,
          required: ["key", "prompt"],
          additionalProperties: false
        },
        execute: (value) => this.host.spawn(this.#task(value))
      },
      followup: {
        description:
          "Admit a follow-up to a retained child. Think serializes its durable queue.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 80 },
            childId: { type: "string", minLength: 1, maxLength: 120 },
            prompt: { type: "string", minLength: 1, maxLength: 32000 },
            material: { type: "string", maxLength: 250000 }
          },
          required: ["key", "childId", "prompt"],
          additionalProperties: false
        },
        execute: (value) => {
          const input = args(value);
          return this.host.followup({
            key: requireString(input.key, "key", { min: 1, max: 80 }),
            childId: requireString(input.childId, "childId", {
              min: 1,
              max: 120
            }),
            prompt: requireString(input.prompt, "prompt", {
              min: 1,
              max: 32_000
            }),
            material: optionalMaterial(input.material)
          });
        }
      },
      status: {
        description: "Inspect a retained child's latest or named turn.",
        inputSchema: {
          type: "object",
          properties: {
            childId: { type: "string", minLength: 1, maxLength: 120 },
            inputId: { type: "string", minLength: 1, maxLength: 120 }
          },
          required: ["childId"],
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) => {
          const input = args(value);
          return this.host.status(
            requireString(input.childId, "childId", { min: 1, max: 120 }),
            optionalInputId(input.inputId)
          );
        }
      },
      list: {
        description: "List retained children using the Agents SDK registry.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 20, default: 10 }
          },
          additionalProperties: false
        },
        replay: "reexecute",
        execute: (value) =>
          this.host.list(boundedInteger(args(value, true).limit, 10, 1, 20))
      },
      read: {
        description: "Read a bounded slice of a completed child answer.",
        inputSchema: {
          type: "object",
          properties: {
            childId: { type: "string", minLength: 1, maxLength: 120 },
            inputId: { type: "string", minLength: 1, maxLength: 120 },
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
        execute: (value) => {
          const input = args(value);
          return this.host.read(
            requireString(input.childId, "childId", { min: 1, max: 120 }),
            optionalInputId(input.inputId),
            boundedInteger(input.start, 0, 0, Number.MAX_SAFE_INTEGER),
            boundedInteger(input.length, 4_000, 1, MAX_CONTEXT_OUTPUT_CHARS)
          );
        }
      }
    };
  }
}
