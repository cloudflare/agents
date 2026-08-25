import { env, runInDurableObject } from "cloudflare:test";
import { Lifecycle } from "../../lifecycle";
import {
  MCPClientManager,
  type MCPClientManagerOptions
} from "../../mcp/client";
import {
  ensureMcpServerTable,
  type MCPServerRow
} from "../../mcp/client-storage";

/**
 * Real-Durable-Object harness for capability-level MCP client tests.
 *
 * Each call runs inside a fresh `McpTestHarnessObject` — a bare Durable
 * Object — so managers operate on real SQLite storage through real Lifecycle
 * services instead of hand-rolled storage mocks. `createManager` may be
 * called more than once to simulate a hibernation wake-up: a fresh manager
 * over the same persisted storage.
 */
export type McpHarness = {
  /** The harness object's real Durable Object storage. */
  readonly storage: DurableObjectStorage;
  /** Construct a manager bound to this object through a real Lifecycle. */
  readonly createManager: (
    options?: MCPClientManagerOptions
  ) => MCPClientManager;
  /** Read the persisted MCP server rows, oldest first. */
  readonly serverRows: () => MCPServerRow[];
};

/** Run one test body against a fresh real-Durable-Object MCP harness. */
export async function withMcpHarness<T>(
  fn: (harness: McpHarness) => Promise<T> | T
): Promise<T> {
  const stub = env.McpTestHarnessObject.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (instance, state) => {
    ensureMcpServerTable(state.storage);
    return fn({
      storage: state.storage,
      createManager: (options) => {
        const manager = new MCPClientManager("test-client", "1.0.0", options);
        // Binding without starting matches production timing: services are
        // available from `use()`, while restoration stays an explicit call
        // (`restoreConnectionsFromStorage`) just as tests exercise it.
        new Lifecycle(instance).use(manager);
        return manager;
      },
      serverRows: () => [
        ...state.storage.sql.exec<MCPServerRow>(
          "SELECT * FROM cf_agents_mcp_servers ORDER BY rowid"
        )
      ]
    });
  });
}
