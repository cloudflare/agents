import type { LanguageModelV4 } from "@ai-sdk/provider";
import { RpcTarget } from "cloudflare:workers";
import type { JsonObject, JsonValue } from "./json";
import { toJsonValue } from "./json";
import { runModelRound } from "./model-runner";
import type {
  HarnessInferenceRequest,
  HarnessInferenceResult,
  HarnessMessage,
  HarnessToolDefinition
} from "./runtime-types";
import {
  customToolsFromLegacyDefinitions,
  modelToolDefinitions
} from "./system-tools";
import type { HarnessRevision, SelfModifyingHarnessStore } from "./store";

/** Editable source operations exposed narrowly to the per-turn host bridge. */
export type HarnessSourceOperations = {
  /** Read one harness source file. */
  read(path: string): Promise<string | null>;
  /** Write one harness source file. */
  write(path: string, content: string): Promise<void>;
  /** Delete one harness source file. */
  delete(path: string): Promise<boolean>;
  /** List the harness working tree. */
  list(): Promise<
    Array<{
      readonly path: string;
      readonly size: number;
      readonly updatedAt: number;
    }>
  >;
};

/** Activation operations exposed narrowly to the per-turn host bridge. */
export type HarnessActivation = {
  /** Build and activate the current working tree. */
  activate(note: string, activationKey: string): Promise<HarnessRevision>;
  /** Restore an old source snapshot as a new forward revision. */
  restore(revisionId: number, activationKey: string): Promise<HarnessRevision>;
};

/** Durable event sink used by a running turn. */
export type HarnessEventSink = {
  /** Append a JSON event only when its stable key has not been projected. */
  emit(eventKey: string, event: JsonObject): void;
};

/** Invalid data returned by editable harness code. */
export class HarnessProtocolError extends Error {
  readonly _tag = "HarnessProtocolError" as const;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(
  object: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new HarnessProtocolError(`${label}.${key} must be a string`);
  }
  return value;
}

function numberValue(
  object: Record<string, unknown>,
  key: string,
  label: string
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HarnessProtocolError(`${label}.${key} must be a safe integer`);
  }
  return value;
}

function toolDefinitions(value: unknown): HarnessToolDefinition[] {
  if (!Array.isArray(value)) {
    throw new HarnessProtocolError("inference.customTools must be an array");
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const label = `inference.customTools[${index}]`;
    const record = objectValue(candidate, label);
    const name = stringValue(record, "name", label);
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      throw new HarnessProtocolError(`${label}.name is not a valid tool name`);
    }
    if (seen.has(name)) {
      throw new HarnessProtocolError(
        `Duplicate tool name ${JSON.stringify(name)}`
      );
    }
    seen.add(name);
    const schema = objectValue(record.inputSchema, `${label}.inputSchema`);
    return {
      name,
      description: stringValue(record, "description", label),
      inputSchema: toJsonValue(schema) as JsonObject
    };
  });
}

function inferenceRequest(value: unknown): HarnessInferenceRequest {
  const record = objectValue(value, "inference");
  if (!Array.isArray(record.messages)) {
    throw new HarnessProtocolError("inference.messages must be an array");
  }
  const messages: HarnessMessage[] = record.messages.map((candidate, index) => {
    const label = `inference.messages[${index}]`;
    const message = objectValue(candidate, label);
    const role = stringValue(message, "role", label);
    if (role !== "user" && role !== "assistant") {
      throw new HarnessProtocolError(`${label}.role must be user or assistant`);
    }
    return { role, content: stringValue(message, "content", label) };
  });
  const customTools =
    record.customTools !== undefined
      ? toolDefinitions(record.customTools)
      : customToolsFromLegacyDefinitions(toolDefinitions(record.tools));
  return {
    round: numberValue(record, "round", "inference"),
    system: stringValue(record, "system", "inference"),
    messages,
    customTools
  };
}

function inferenceResult(value: JsonValue): HarnessInferenceResult {
  const record = objectValue(value, "inference result");
  if (!Array.isArray(record.toolCalls)) {
    throw new HarnessProtocolError(
      "inference result.toolCalls must be an array"
    );
  }
  return {
    text: stringValue(record, "text", "inference result"),
    finishReason: stringValue(record, "finishReason", "inference result"),
    toolCalls: record.toolCalls.map((candidate, index) => {
      const label = `inference result.toolCalls[${index}]`;
      const call = objectValue(candidate, label);
      return {
        callId: stringValue(call, "callId", label),
        name: stringValue(call, "name", label),
        input: toJsonValue(call.input)
      };
    })
  };
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toolFailure(error: unknown): JsonObject {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

function isToolFailure(value: JsonValue): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.ok === false &&
    typeof value.error === "string"
  );
}

function requireMatchingEffect(
  storedHash: string,
  nextHash: string,
  label: string
): void {
  if (storedHash !== nextHash) {
    throw new HarnessProtocolError(
      `${label} reused a stable effect key with different input`
    );
  }
}

/**
 * Temporary RPC authority for one Dynamic Worker turn.
 *
 * The editable isolate receives this object as a call argument. It never sees
 * Durable Object storage, model bindings, Worker Loader, or raw credentials.
 */
export class SelfModifyingTurnHost extends RpcTarget {
  readonly #turnId: string;
  readonly #source: HarnessSourceOperations;
  readonly #store: SelfModifyingHarnessStore;
  readonly #model: LanguageModelV4;
  readonly #activation: HarnessActivation;
  readonly #events: HarnessEventSink;

  /** Construct one turn-scoped authority object. */
  constructor(options: {
    readonly turnId: string;
    readonly source: HarnessSourceOperations;
    readonly store: SelfModifyingHarnessStore;
    readonly model: LanguageModelV4;
    readonly activation: HarnessActivation;
    readonly events: HarnessEventSink;
  }) {
    super();
    this.#turnId = options.turnId;
    this.#source = options.source;
    this.#store = options.store;
    this.#model = options.model;
    this.#activation = options.activation;
    this.#events = options.events;
  }

  /** Run or replay one model round selected by the editable harness. */
  async infer(value: unknown): Promise<HarnessInferenceResult> {
    const request = inferenceRequest(value);
    const effectKey = String(request.round);
    const hash = await requestHash(request);
    const existing = this.#store.effect(this.#turnId, "model", effectKey);
    if (existing) {
      requireMatchingEffect(
        existing.requestHash,
        hash,
        `model round ${effectKey}`
      );
      if (existing.state === "completed" && existing.result !== null) {
        const replayed = inferenceResult(existing.result);
        this.#events.emit(`model:${effectKey}:start`, {
          type: "model_started",
          round: request.round
        });
        this.#events.emit(`model:${effectKey}:finish`, {
          type: "model_completed",
          round: request.round,
          finishReason: replayed.finishReason,
          toolCalls: replayed.toolCalls.length
        });
        return replayed;
      }
    } else {
      this.#store.beginEffect(this.#turnId, "model", effectKey, hash);
    }

    this.#events.emit(`model:${effectKey}:start`, {
      type: "model_started",
      round: request.round
    });
    const result = await runModelRound(this.#model, {
      round: request.round,
      system: request.system,
      messages: request.messages,
      tools: modelToolDefinitions(request.customTools)
    });
    const json = toJsonValue(result);
    this.#store.completeEffect(this.#turnId, "model", effectKey, json);
    this.#events.emit(`model:${effectKey}:finish`, {
      type: "model_completed",
      round: request.round,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls.length
    });
    return result;
  }

  /** Run or replay one trusted System tool call. */
  async callTool(
    callId: string,
    name: string,
    input: JsonValue
  ): Promise<JsonValue> {
    if (typeof callId !== "string" || callId.length === 0) {
      throw new HarnessProtocolError("tool callId must be a non-empty string");
    }
    if (typeof name !== "string" || name.length === 0) {
      throw new HarnessProtocolError("tool name must be a non-empty string");
    }
    const request = { name, input };
    const hash = await requestHash(request);
    const existing = this.#store.effect(this.#turnId, "tool", callId);
    if (existing) {
      requireMatchingEffect(existing.requestHash, hash, `tool call ${callId}`);
      if (existing.state === "completed" && existing.result !== null) {
        this.#events.emit(`tool:${callId}:start`, {
          type: "tool_started",
          callId,
          name,
          input
        });
        this.#events.emit(`tool:${callId}:finish`, {
          type: isToolFailure(existing.result)
            ? "tool_failed"
            : "tool_completed",
          callId,
          name,
          result: existing.result
        });
        return existing.result;
      }
    } else {
      this.#store.beginEffect(this.#turnId, "tool", callId, hash);
    }

    this.#events.emit(`tool:${callId}:start`, {
      type: "tool_started",
      callId,
      name,
      input
    });
    let result: JsonValue;
    try {
      result = await this.#executeTool(callId, name, input);
    } catch (error) {
      result = toolFailure(error);
    }
    this.#store.completeEffect(this.#turnId, "tool", callId, result);
    this.#events.emit(`tool:${callId}:finish`, {
      type: isToolFailure(result) ? "tool_failed" : "tool_completed",
      callId,
      name,
      result
    });
    return result;
  }

  /** Append one stable-keyed note from editable code to the trusted journal. */
  note(key: string, text: string): Promise<void> {
    if (typeof key !== "string" || key.trim() === "") {
      throw new HarnessProtocolError(
        "journal note key must be a non-empty string"
      );
    }
    if (typeof text !== "string") {
      throw new HarnessProtocolError("journal note must be a string");
    }
    this.#store.journal(
      this.#turnId,
      "note",
      { text: text.slice(0, 4000) },
      `turn:${this.#turnId}:runtime-note:${key.slice(0, 200)}`
    );
    return Promise.resolve();
  }

  async #executeTool(
    callId: string,
    name: string,
    input: JsonValue
  ): Promise<JsonValue> {
    const record = objectValue(input, `tool ${name} input`);
    switch (name) {
      case "read_file": {
        const path = stringValue(record, "path", name);
        return { path, content: await this.#source.read(path) };
      }
      case "write_file": {
        const path = stringValue(record, "path", name);
        const content = stringValue(record, "content", name);
        await this.#source.write(path, content);
        this.#store.journal(
          this.#turnId,
          "source_written",
          {
            path,
            bytes: new TextEncoder().encode(content).byteLength
          },
          `turn:${this.#turnId}:tool:${callId}:source-written`
        );
        return {
          path,
          size: new TextEncoder().encode(content).byteLength
        };
      }
      case "delete_file": {
        const path = stringValue(record, "path", name);
        const deleted = await this.#source.delete(path);
        this.#store.journal(
          this.#turnId,
          "source_deleted",
          { path, deleted },
          `turn:${this.#turnId}:tool:${callId}:source-deleted`
        );
        return { path, deleted };
      }
      case "list_files":
        return toJsonValue(await this.#source.list());
      case "activate_harness": {
        const note = stringValue(record, "note", name);
        return toJsonValue(
          await this.#activation.activate(
            note,
            `tool:${this.#turnId}:${callId}:activate`
          )
        );
      }
      case "list_revisions":
        return toJsonValue(this.#store.revisions());
      case "restore_revision":
        return toJsonValue(
          await this.#activation.restore(
            numberValue(record, "revisionId", name),
            `tool:${this.#turnId}:${callId}:restore`
          )
        );
      case "journal_note": {
        const text = stringValue(record, "text", name).slice(0, 4000);
        this.#store.journal(
          this.#turnId,
          "note",
          { text },
          `turn:${this.#turnId}:tool:${callId}:note`
        );
        return { recorded: true };
      }
      default:
        throw new HarnessProtocolError(
          `Unknown trusted tool ${JSON.stringify(name)}`
        );
    }
  }
}
