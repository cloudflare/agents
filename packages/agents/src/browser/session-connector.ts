import {
  CodemodeConnector,
  MAX_DURABLE_VALUE_BYTES,
  type ConnectorTool,
  type ConnectorTools,
  type ToolExecuteContext
} from "@cloudflare/codemode";
import {
  BROWSER_FUNCTIONS,
  BROWSER_INSTRUCTIONS,
  BrowserSessionDriver,
  type BrowserExecutionReport,
  type BrowserFunctionDefinition,
  type BrowserFunctionName,
  type BrowserSessionOptions
} from "./session-driver";

export {
  ACTIVE_PAGE_SESSION,
  BROWSER_INSTRUCTIONS,
  type BrowserExecutionReport,
  type BrowserNewTab,
  type BrowserSource
} from "./session-driver";

export type BrowserSessionConnectorOptions = BrowserSessionOptions;

type JsonSchema = NonNullable<ConnectorTool["inputSchema"]>;

/**
 * Calls that read without changing anything, and whose results would bloat
 * the codemode log: a replay runs them again instead of replaying them.
 */
const REEXECUTE: ReadonlySet<BrowserFunctionName> = new Set([
  "spec",
  "getDebugLog"
]);

/**
 * Codemode connector exposing one host-named, persistent browser over the
 * Chrome DevTools Protocol as the `cdp` global. The work is done by a
 * {@link BrowserSessionDriver}; this class maps codemode's tools and pass
 * hooks onto it.
 */
export class BrowserSessionConnector extends CodemodeConnector {
  readonly #driver: BrowserSessionDriver;

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    options: BrowserSessionConnectorOptions
  ) {
    super(ctx, {});
    this.#driver = new BrowserSessionDriver({
      ...options,
      maxResultBytes: MAX_DURABLE_VALUE_BYTES
    });
  }

  name(): string {
    return "cdp";
  }

  protected instructions(): string {
    return BROWSER_INSTRUCTIONS;
  }

  protected tools(): ConnectorTools {
    const tools: ConnectorTools = {};
    for (const name of Object.keys(
      BROWSER_FUNCTIONS
    ) as BrowserFunctionName[]) {
      const definition: BrowserFunctionDefinition = BROWSER_FUNCTIONS[name];
      const tool: ConnectorTool = {
        description: definition.description,
        inputSchema: definition.inputSchema as JsonSchema,
        ...(definition.outputSchema
          ? { outputSchema: definition.outputSchema as JsonSchema }
          : {}),
        ...(REEXECUTE.has(name) ? { replay: "reexecute" as const } : {}),
        execute: (args, ctx) =>
          this.#driver.call(executionIdOf(ctx), name, args)
      };
      tools[name] = tool;
    }
    return tools;
  }

  /** The pass is over: save what it changed and drop the socket. */
  override async onPassEnd(executionId: string): Promise<void> {
    await this.#driver.end(executionId);
  }

  /** Nothing per execution outlives the pass; the named browser persists. */
  override async disposeExecution(executionId: string): Promise<void> {
    this.#driver.dispose(executionId);
  }

  /**
   * Take (and forget) what happened to the browser during an execution.
   * `undefined` when the execution never touched the browser.
   */
  takeReport(executionId: string): BrowserExecutionReport | undefined {
    return this.#driver.takeReport(executionId);
  }
}

function executionIdOf(ctx: ToolExecuteContext | undefined): string {
  if (!ctx?.executionId) {
    throw new Error("Browser tools must run inside a codemode execution");
  }
  return ctx.executionId;
}
