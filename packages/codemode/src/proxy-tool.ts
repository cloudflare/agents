/**
 * Model-facing proxy tool.
 *
 * One AI SDK tool with `{ code: string }`. Code runs in the Executor sandbox.
 * The CodemodeRuntime facet makes execution durable via abort-and-replay:
 * every tool call is logged; observations execute and record; approval-required
 * actions abort the run; `continue` replays the log and runs the approved action.
 *
 * Inside the sandbox:
 *   - Connector SDKs as globals: `<connector>.<method>(...)`
 *   - Platform SDK: `codemode.search/describe/connectors/run/save/snippets/pending/step/fork/get/set`
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Executor, ResolvedProvider, ConnectorBinding } from "./executor";
import { runCode } from "./run-code";
import type { CodemodeConnector, ConnectorDescription } from "./connectors";
import { searchConnectors, describeTarget } from "./connectors";
import {
  CodemodeRuntime,
  STEP_CONNECTOR,
  type AnnotationMap,
  type PendingAction,
  type ToolDecision,
  type ToolLogEntry,
  type ExecutionState
} from "./runtime";

/**
 * The RPC surface of the CodemodeRuntime facet, as the proxy tool uses it.
 *
 * Declared explicitly rather than relying on `Fetcher<CodemodeRuntime>`: the
 * RPC type transform collapses discriminated unions like `ToolDecision`
 * (the `unknown` payload doesn't survive serialization inference), which would
 * break `decision.kind` narrowing. This interface keeps the domain types intact.
 */
interface RuntimeStub {
  configure(annotations: AnnotationMap): Promise<void>;
  begin(code: string): Promise<string>;
  resume(id?: string): Promise<ExecutionState | null>;
  decide(
    connector: string,
    method: string,
    args: unknown
  ): Promise<ToolDecision>;
  recordResult(seq: number, result: unknown): Promise<void>;
  complete(result: unknown, logs?: string[]): Promise<void>;
  fail(error: string, logs?: string[]): Promise<void>;
  fork(): Promise<string>;
  listPending(): Promise<PendingAction[]>;
  reject(seq: number): Promise<void>;
  actionsToRevert(): Promise<ToolLogEntry[]>;
  markReverted(seq: number): Promise<void>;
  getExecution(id?: string): Promise<ExecutionState | null>;
  getState(key: string): Promise<unknown>;
  setState(key: string, value: unknown): Promise<void>;
  saveSnippet(name: string, options?: SaveSnippetOptions): Promise<Snippet>;
  getSnippet(name: string): Promise<Snippet | null>;
  listSnippets(): Promise<Snippet[]>;
  deleteSnippet(name: string): Promise<boolean>;
}
import type { Snippet, SaveSnippetOptions } from "./snippet";
import type { CodeOutput } from "./shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProxyToolInput = { code: string };

export type ProxyToolOutput =
  | { status: "completed"; result: unknown; logs?: string[] }
  | {
      status: "paused";
      executionId: string;
      pending: PendingAction[];
    };

export type CreateProxyToolOptions = {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  executor: Executor;
  description?: string;
};

// ---------------------------------------------------------------------------
// Schema + pause sentinel
// ---------------------------------------------------------------------------

const proxySchema = z.object({ code: z.string() });

// Sandbox-side definition of `codemode.step(name, fn)`. Assigned as an own
// property on the codemode namespace so it shadows the dispatch proxy. It
// wraps the local closure: ask the host whether to replay (return recorded
// value) or execute (run fn, record the result). This is the explicit
// side-effect boundary that makes replay correct for arbitrary work.
const STEP_PRELUDE = String.raw`
    codemode.step = async (name, fn) => {
      const decision = await codemode.__stepDecide(name);
      if (decision.kind === "replay") return decision.result;
      const value = await fn();
      await codemode.__stepRecord(decision.seq, value);
      return value;
    };`;

// Thrown inside a connector binding when the runtime decides to pause.
// Aborts the sandbox run; the proxy tool detects the pause via runtime state.
const PAUSE_SENTINEL = "__CODEMODE_PAUSE__";

// ---------------------------------------------------------------------------
// Setup — connectors + runtime facet
// ---------------------------------------------------------------------------

type Setup = {
  connectorsByName: Map<string, CodemodeConnector>;
  descriptions: ConnectorDescription[];
  annotations: AnnotationMap;
};

async function loadSetup(connectors: CodemodeConnector[]): Promise<Setup> {
  const connectorsByName = new Map<string, CodemodeConnector>();
  const descriptions: ConnectorDescription[] = [];
  const annotations: AnnotationMap = {};

  for (const connector of connectors) {
    const name = connector.name();
    const description = await connector.describe();
    connectorsByName.set(name, connector);
    descriptions.push(description);
    for (const [method, annotation] of Object.entries(
      description.annotations ?? {}
    )) {
      annotations[`${name}.${method}`] = annotation;
    }
  }

  return { connectorsByName, descriptions, annotations };
}

// ---------------------------------------------------------------------------
// Connector bindings — every call routes through the runtime for a decision
// ---------------------------------------------------------------------------

function buildConnectorBindings(
  setup: Setup,
  runtime: RuntimeStub
): ConnectorBinding[] {
  return setup.descriptions.map((desc) => ({
    name: desc.name,
    binding: {
      callTool: async (method: string, args: unknown): Promise<unknown> => {
        const decision = await runtime.decide(desc.name, method, args);

        if (decision.kind === "replay") {
          return decision.result;
        }
        if (decision.kind === "pause") {
          throw new Error(PAUSE_SENTINEL);
        }
        // execute
        const connector = setup.connectorsByName.get(desc.name);
        if (!connector) throw new Error(`Unknown connector: ${desc.name}`);
        const result = await connector.executeTool(method, args);
        await runtime.recordResult(decision.seq, result);
        return result;
      }
    }
  }));
}

// ---------------------------------------------------------------------------
// Platform provider — codemode namespace
// ---------------------------------------------------------------------------

function createPlatformProvider(
  setup: Setup,
  bindings: ConnectorBinding[],
  runtime: RuntimeStub,
  executor: Executor
): ResolvedProvider {
  const { descriptions } = setup;
  return {
    name: "codemode",
    prelude: STEP_PRELUDE,
    fns: {
      // Discovery
      search: async (query: unknown) =>
        searchConnectors(
          String(query),
          descriptions,
          await runtime.listSnippets()
        ),

      describe: async (target: unknown) =>
        describeTarget(
          String(target),
          descriptions,
          await runtime.listSnippets()
        ),

      connectors: async () =>
        descriptions.map((d) => ({
          name: d.name,
          instructions: d.instructions,
          methodCount: Object.keys(d.descriptors).length
        })),

      // Execution control
      pending: async () => runtime.listPending(),

      fork: async () => runtime.fork(),

      // Per-execution scratchpad
      get: async (key: unknown) => runtime.getState(String(key)),

      set: async (key: unknown, value: unknown) => {
        await runtime.setState(String(key), value);
        return true;
      },

      // Snippets — durable, addressable saved scripts
      save: async (name: unknown, options?: unknown) =>
        runtime.saveSnippet(
          String(name),
          options as SaveSnippetOptions | undefined
        ),

      snippets: async () => runtime.listSnippets(),

      run: async (...args: unknown[]) => {
        const snippet = await runtime.getSnippet(String(args[0]));
        if (!snippet) return { error: `Snippet "${args[0]}" not found.` };
        const result = await runCode({
          code: `async () => {\n  const snippet = (${snippet.code});\n  return await snippet(${JSON.stringify(args[1])});\n}`,
          executor,
          providers: [],
          connectors: bindings
        });
        return result.result;
      },

      // Host primitives backing the codemode.step() prelude. The closure
      // can't cross the RPC boundary, so step decides + records here while the
      // sandbox runs the closure locally only when told to execute.
      __stepDecide: async (name: unknown) =>
        runtime.decide(STEP_CONNECTOR, String(name), undefined),

      __stepRecord: async (seq: unknown, value: unknown) => {
        await runtime.recordResult(Number(seq), value);
        return true;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Tool description
// ---------------------------------------------------------------------------

function buildDescription(
  connectors: CodemodeConnector[],
  customDescription?: string
): string {
  if (customDescription) return customDescription;

  const namespaces = connectors.map((c) => `- \`${c.name()}\``).join("\n");

  const lines = [
    "Execute TypeScript in a sandbox with access to connector SDKs.",
    "",
    "## Workflow",
    "",
    '1. `const matches = await codemode.search("short intent phrase");`',
    "2. `const docs = await codemode.describe(matches.results[0].path);`",
    "3. Call the method: `await <connector>.<method>(args);`",
    "",
    "## Rules",
    "",
    "- `codemode.search(query)` returns ranked matches across connector methods and saved snippets.",
    '- `codemode.describe("connector.method")` returns TypeScript type declarations.',
    "- `codemode.connectors()` lists available connectors.",
    "- `codemode.pending()` lists actions awaiting approval.",
    "- `codemode.get(key)` / `codemode.set(key, value)` persist state across runs.",
    "- `codemode.step(name, fn)` wraps side-effectful or nondeterministic work (raw fetch, random, time) so it runs once and is replayed on resume. Use it for anything that isn't a connector call.",
    "- Some methods require approval. The run pauses until the user approves, then resumes automatically. Write code as if the call returns normally.",
    "- All code outside connector calls and `codemode.step` must be deterministic so resume can replay it.",
    "- Connector SDKs are available as globals named after each connector.",
    "- Do not use `fetch` — use connector SDKs.",
    "",
    "## Snippets",
    "",
    "Snippets are saved scripts you can reuse.",
    '- `codemode.save("name", { description })` saves the current script so you can run it again later. Save a script once it works and is worth reusing.',
    '- `codemode.run("name", input)` runs a saved snippet. If a snippet needs input, write it as `async (input) => { ... }`.',
    "- `codemode.snippets()` lists saved snippets.",
    "",
    "## Available connectors",
    "",
    namespaces
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run one pass of the code through the executor.
// ---------------------------------------------------------------------------

async function runPass(
  code: string,
  setup: Setup,
  runtime: RuntimeStub,
  executor: Executor
): Promise<ProxyToolOutput> {
  const bindings = buildConnectorBindings(setup, runtime);
  const platformProvider = createPlatformProvider(
    setup,
    bindings,
    runtime,
    executor
  );

  let output: CodeOutput | undefined;
  let threw: unknown;
  try {
    output = await runCode({
      code,
      executor,
      providers: [platformProvider],
      connectors: bindings
    });
  } catch (err) {
    threw = err;
  }

  // The facet status is the source of truth: a pause records itself there
  // before aborting the run. The PAUSE_SENTINEL only stops the sandbox; it
  // is never the deciding signal here.
  const execution = await runtime.getExecution();
  if (execution?.status === "paused") {
    return {
      status: "paused",
      executionId: execution.id,
      pending: await runtime.listPending()
    };
  }

  if (threw) {
    const message = threw instanceof Error ? threw.message : String(threw);
    await runtime.fail(message);
    throw threw;
  }

  const result = output?.result;
  await runtime.complete(result, output?.logs);
  return { status: "completed", result, logs: output?.logs };
}

// ---------------------------------------------------------------------------
// createProxyTool
// ---------------------------------------------------------------------------

export function createProxyTool(
  options: CreateProxyToolOptions
): Tool<ProxyToolInput, ProxyToolOutput> {
  const connectors = options.connectors;

  for (const connector of connectors) {
    if (connector.name() === "codemode") {
      throw new Error(
        'Connector name "codemode" is reserved for the codemode platform SDK.'
      );
    }
  }

  // Spawn the runtime facet on the agent DO. The facet's identity is derived
  // from the connector set, so changing connectors yields a different runtime
  // — which guarantees every snippet stored in a runtime only ever references
  // connectors that are present.
  const runtime = getRuntime(options.ctx, connectors);

  let setupPromise: Promise<Setup> | undefined;
  function getSetup() {
    return (setupPromise ??= loadSetup(connectors));
  }

  return tool({
    description: buildDescription(connectors, options.description),
    inputSchema: proxySchema,
    execute: async ({ code }) => {
      const setup = await getSetup();
      await runtime.configure(setup.annotations);
      await runtime.begin(code);
      return runPass(code, setup, runtime, options.executor);
    }
  });
}

// ---------------------------------------------------------------------------
// Shared facet handle
// ---------------------------------------------------------------------------

/**
 * Fingerprint the connector set: sorted connector names. The runtime facet is
 * keyed by this, so a given runtime (and its saved snippets + paused
 * executions) is bound to exactly the connectors it was created with. Add,
 * remove, or rename a connector and you address a fresh runtime — stale
 * snippets that reference a now-absent connector can never surface.
 */
function runtimeFacetName(connectors: CodemodeConnector[]): string {
  const names = connectors
    .map((c) => c.name())
    .sort()
    .join(",");
  return `codemode:${names}`;
}

function getRuntime(
  ctx: DurableObjectState,
  connectors: CodemodeConnector[]
): RuntimeStub {
  return ctx.facets.get<CodemodeRuntime>(runtimeFacetName(connectors), () => ({
    class: CodemodeRuntime
  })) as unknown as RuntimeStub;
}

// ---------------------------------------------------------------------------
// Resume — approve a pending action and continue via replay
// ---------------------------------------------------------------------------

export type ResumeCodemodeOptions = {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  executor: Executor;
  /** Execution id to resume. Omit to resume the current execution. */
  executionId?: string;
};

/**
 * Approve a pending action and continue the paused execution. Re-runs the
 * stored code; the runtime replays the log up to the approved action, runs it
 * for real, and proceeds to the next pause or completion.
 */
export async function resumeCodemode(
  options: ResumeCodemodeOptions
): Promise<ProxyToolOutput> {
  const runtime = getRuntime(options.ctx, options.connectors);

  const setup = await loadSetup(options.connectors);

  const execution = await runtime.resume(options.executionId);
  if (!execution) throw new Error("No paused execution to resume.");

  await runtime.configure(setup.annotations);
  return runPass(execution.code, setup, runtime, options.executor);
}

// ---------------------------------------------------------------------------
// Fork — snapshot the current execution into an independent branch
// ---------------------------------------------------------------------------

/**
 * Clone the current (typically paused) execution into a new independent
 * execution and return its id. The fork inherits the full log and scratchpad
 * but diverges going forward — useful for checkpoints, handing a task off to a
 * subagent, or trying alternative inputs. Resume the fork with
 * `resumeCodemode({ executionId })`.
 */
export async function forkCodemode(options: {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
}): Promise<string> {
  return getRuntime(options.ctx, options.connectors).fork();
}

// ---------------------------------------------------------------------------
// Reject — reject a pending action, ending the execution
// ---------------------------------------------------------------------------

export async function rejectCodemode(options: {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  seq: number;
}): Promise<void> {
  await getRuntime(options.ctx, options.connectors).reject(options.seq);
}

// ---------------------------------------------------------------------------
// Rollback — revert applied actions in reverse order
// ---------------------------------------------------------------------------

export async function rollbackCodemode(options: {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
}): Promise<void> {
  const runtime = getRuntime(options.ctx, options.connectors);

  const byName = new Map(options.connectors.map((c) => [c.name(), c]));
  const actions = await runtime.actionsToRevert();

  for (const action of actions) {
    const connector = byName.get(action.connector);
    if (connector?.revertAction) {
      await connector.revertAction(action.method, action.args, action.result);
    }
    await runtime.markReverted(action.seq);
  }
}
