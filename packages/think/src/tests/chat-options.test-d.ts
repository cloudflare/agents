/**
 * Type-level tests for the client-tool surface of Think's `chat()` RPC entry
 * point (cloudflare/agents#1709).
 *
 * These lock the public shape of {@link ChatOptions.clientTools} and
 * {@link ChatOptions.onClientToolCall}, plus the {@link ClientToolExecutor}
 * contract re-used from `agents/chat`. A regression in either — a dropped
 * field, a narrowed type, or a changed executor signature — would silently
 * break parent agents delegating to a Think sub-agent over RPC.
 *
 * Checked by the typecheck script, not vitest (filename ends in `.test-d.ts`,
 * which the workers vitest `**\/*.test.ts` glob does not match).
 */

import type { ClientToolExecutor, ClientToolSchema } from "agents/chat";
import type { ChatOptions } from "../think";

// ── ChatOptions.clientTools ────────────────────────────────────────

// Accepts an array of client tool schemas.
const withClientTools: ChatOptions = {
  clientTools: [
    {
      name: "getLocation",
      description: "Get the user's current location",
      parameters: { type: "object", properties: {} }
    }
  ]
};
void withClientTools;

// `clientTools` is optional — an empty options object compiles.
const emptyOptions: ChatOptions = {};
void emptyOptions;

// `parameters`/`description` are optional on a schema entry.
const minimalSchema: ChatOptions = {
  clientTools: [{ name: "ping" }]
};
void minimalSchema;

const wrongClientTools: ChatOptions = {
  // @ts-expect-error — clientTools must be an array of schemas, not a string.
  clientTools: "getLocation"
};
void wrongClientTools;

const schemaMissingName: ChatOptions = {
  clientTools: [
    // @ts-expect-error — `name` is required on a client tool schema.
    { description: "no name" }
  ]
};
void schemaMissingName;

// ── ChatOptions.onClientToolCall ───────────────────────────────────

// Accepts a synchronous executor returning a value.
const syncExecutor: ChatOptions = {
  onClientToolCall: ({ toolName, input, toolCallId }) => {
    void toolName;
    void input;
    void toolCallId;
    return { ok: true };
  }
};
void syncExecutor;

// Accepts an async executor returning a promise.
const asyncExecutor: ChatOptions = {
  onClientToolCall: async () => ({ ok: true })
};
void asyncExecutor;

// A bare `ClientToolExecutor` is assignable to the option.
const executor: ClientToolExecutor = (call) => call.input;
const fromTyped: ChatOptions = { onClientToolCall: executor };
void fromTyped;

const wrongExecutor: ChatOptions = {
  // @ts-expect-error — onClientToolCall must be a function, not a string.
  onClientToolCall: "run"
};
void wrongExecutor;

const extraOption: ChatOptions = {
  // @ts-expect-error — unknown options are rejected (guards against typos
  // such as `onClientToolCalls` / `clientTool`).
  onClientToolCalls: executor
};
void extraOption;

// ── ClientToolExecutor call shape ──────────────────────────────────

// The executor is invoked with `{ toolName, input, toolCallId }`; `input` is
// `unknown` (the wire schema is untyped JSON) and the ids are strings.
const probeExecutor: ClientToolExecutor = (call) => {
  const name: string = call.toolName;
  const id: string = call.toolCallId;
  const input: unknown = call.input;
  void name;
  void id;
  void input;

  // @ts-expect-error — `input` is `unknown`; it must be narrowed before use.
  const length: number = call.input.length;
  void length;

  return undefined;
};
void probeExecutor;

// A schema entry is structurally a `ClientToolSchema`.
const schema: ClientToolSchema = { name: "noop" };
void schema;
