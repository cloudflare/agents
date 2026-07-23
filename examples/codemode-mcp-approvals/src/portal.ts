import {
  CodemodeConnector,
  sanitizeToolName,
  type ConnectorTool,
  type ConnectorTools
} from "@cloudflare/codemode";

export type PortalMode = "catalog" | "execute";

export type PortalOperation = {
  /** Original upstream name, retained for display and debugging. */
  rawName: string;
  /** Host-owned schema, policy, and implementation for the operation. */
  tool: ConnectorTool;
};

type MappedPortalOperation = PortalOperation & {
  executableName: string;
};

/**
 * A Portal-style dynamic connector over an arbitrary operation list.
 *
 * Catalog mode exposes only `portal.tools()`. Execute mode derives one
 * JavaScript-safe `portal.<name>()` method per operation. Both modes use the
 * same source definitions, so discovery cannot drift from enforcement.
 */
export class PortalConnector<Env> extends CodemodeConnector<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    private readonly operations: PortalOperation[],
    private readonly mode: PortalMode
  ) {
    super(ctx, env);
  }

  name() {
    return "portal";
  }

  protected instructions() {
    return this.mode === "catalog"
      ? "Portal operation catalog. Call tools() to inspect executable names and schemas."
      : "Portal operations. Approval policy is enforced by each host-owned operation definition.";
  }

  protected tools(): ConnectorTools {
    const operations = this.mappedOperations();
    if (this.mode === "catalog") {
      return {
        tools: {
          description:
            "List available Portal operations, including executable names, schemas, and approval policy.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false
          },
          // Catalog reads can be large and are safe to repeat on replay.
          replay: "reexecute",
          execute: () =>
            operations.map(({ executableName, rawName, tool }) => ({
              name: executableName,
              rawName,
              description: tool.description,
              inputSchema: tool.inputSchema ?? { type: "object" },
              outputSchema: tool.outputSchema,
              requiresApproval: tool.requiresApproval ?? false
            }))
        }
      };
    }

    return Object.fromEntries(
      operations.map(({ executableName, tool }) => [executableName, tool])
    );
  }

  private mappedOperations(): MappedPortalOperation[] {
    const rawNamesByExecutableName = new Map<string, string>();
    return this.operations.map((operation) => {
      const executableName = sanitizeToolName(operation.rawName);
      if (executableName === "tools") {
        throw new Error(
          `Portal operation "${operation.rawName}" maps to the reserved ` +
            'name "tools". Give it a different alias.'
        );
      }
      const conflictingRawName = rawNamesByExecutableName.get(executableName);
      if (conflictingRawName) {
        throw new Error(
          `Portal operations "${conflictingRawName}" and ` +
            `"${operation.rawName}" both map to "${executableName}". ` +
            "Give them unique aliases."
        );
      }
      rawNamesByExecutableName.set(executableName, operation.rawName);
      return { ...operation, executableName };
    });
  }
}
