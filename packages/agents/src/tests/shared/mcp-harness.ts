import {
  MCPClientManager,
  type MCPClientManagerOptions
} from "../../mcp/client";
import {
  ensureMcpServerTable,
  type MCPServerRow
} from "../../mcp/client/storage";
import { withCapabilityHarness } from "./capability-harness";

/**
 * Real-Durable-Object harness for MCP client manager tests, built on the
 * generic capability harness: managers operate on real SQLite storage
 * through real Lifecycle services instead of hand-rolled storage mocks.
 * `createManager` may be called more than once to simulate a hibernation
 * wake-up — a fresh manager over the same persisted storage.
 */
export type McpHarness = {
  /** The harness object's real Durable Object storage. */
  readonly storage: DurableObjectStorage;
  /** Construct a manager bound to this object through a real Lifecycle. */
  readonly createManager: (
    options?: MCPClientManagerOptions
  ) => MCPClientManager;
  /**
   * Bind a pre-constructed manager — for example a test subclass — to this
   * object through a real Lifecycle and return it.
   */
  readonly installManager: <Manager extends MCPClientManager>(
    manager: Manager
  ) => Manager;
  /** Read the persisted MCP server rows, oldest first. */
  readonly serverRows: () => MCPServerRow[];
};

/** Run one test body against a fresh real-Durable-Object MCP harness. */
export async function withMcpHarness<T>(
  fn: (harness: McpHarness) => Promise<T> | T
): Promise<T> {
  return withCapabilityHarness(async ({ storage, install }) => {
    ensureMcpServerTable(storage);
    // Binding without starting matches production timing: services are
    // available from `use()`, while restoration stays an explicit call
    // (`restoreConnectionsFromStorage`) just as tests exercise it.
    const installManager = <Manager extends MCPClientManager>(
      manager: Manager
    ): Manager => install(manager).capability;
    return fn({
      storage,
      createManager: (options) =>
        installManager(new MCPClientManager("test-client", "1.0.0", options)),
      installManager,
      serverRows: () => [
        ...storage.sql.exec<MCPServerRow>(
          "SELECT * FROM cf_agents_mcp_servers ORDER BY rowid"
        )
      ]
    });
  });
}
