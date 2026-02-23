import { useAgent } from "agents/react";
import { useState, useEffect, useCallback } from "react";
import {
  Button,
  Input,
  InputArea,
  Surface,
  Table,
  Text
} from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  HighlightedJson,
  type CodeSection
} from "../../components";
import { useLogs, useUserId, useToast } from "../../hooks";
import type { SqlAgent } from "./sql-agent";

const codeSections: CodeSection[] = [
  {
    title: "Query with the sql tagged template",
    description:
      "Every agent has a built-in SQLite database. Use this.sql with a tagged template literal for safe, parameterized queries — values are automatically escaped.",
    code: `import { Agent, callable } from "agents";

class SqlAgent extends Agent<Env> {
  @callable()
  insertRecord(key: string, value: string) {
    this.sql\`
      CREATE TABLE IF NOT EXISTS playground_data (
        key TEXT PRIMARY KEY,
        value TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    \`;
    this.sql\`
      INSERT OR REPLACE INTO playground_data (key, value)
      VALUES (\${key}, \${value})
    \`;
  }
}`
  },
  {
    title: "Read data back",
    description:
      "this.sql returns results as an array directly — no need to spread a cursor. For lower-level access, this.ctx.storage.sql.exec() returns a raw iterable cursor you can stream through.",
    code: `  @callable()
  getRecords() {
    // this.sql returns T[] directly
    return this.sql\`
      SELECT * FROM playground_data ORDER BY created_at DESC
    \`;
  }

  @callable()
  listTables() {
    return this.sql\`
      SELECT name, type FROM sqlite_master
      WHERE type IN ('table', 'index')
      ORDER BY type, name
    \`;
  }`
  }
];

export function SqlDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const { toast } = useToast();
  const [tables, setTables] = useState<Array<{ name: string; type: string }>>(
    []
  );
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [schema, setSchema] = useState<unknown[]>([]);
  const [query, setQuery] = useState("SELECT * FROM cf_agents_state");
  const [queryResult, setQueryResult] = useState<unknown[] | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [records, setRecords] = useState<unknown[]>([]);

  const agent = useAgent<SqlAgent, {}>({
    agent: "sql-agent",
    name: `sql-demo-${userId}`,
    onOpen: () => {
      addLog("info", "connected");
      loadTables();
      loadRecords();
    },
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error")
  });

  const loadTables = useCallback(async () => {
    try {
      const result = (await agent.call("listTables")) as Array<{
        name: string;
        type: string;
      }>;
      setTables(result);
    } catch {
      // Ignore
    }
  }, [agent]);

  const loadRecords = useCallback(async () => {
    try {
      const result = (await agent.call("getRecords")) as unknown[];
      setRecords(result);
    } catch {
      // Ignore
    }
  }, [agent]);

  useEffect(() => {
    if (agent.readyState === WebSocket.OPEN) {
      loadTables();
      loadRecords();
    }
  }, [agent.readyState, loadTables, loadRecords]);

  const handleSelectTable = async (tableName: string) => {
    setSelectedTable(tableName);
    addLog("out", "getTableSchema", tableName);
    try {
      const result = (await agent.call("getTableSchema", [
        tableName
      ])) as unknown[];
      addLog("in", "schema", result);
      setSchema(result);
      setQuery(`SELECT * FROM ${tableName} LIMIT 10`);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleExecuteQuery = async () => {
    addLog("out", "executeQuery", query);
    setQueryResult(null);
    try {
      const result = (await agent.call("executeQuery", [query])) as unknown[];
      addLog("in", "query_result", `${result.length} rows`);
      setQueryResult(result);
      toast(result.length + " rows returned", "success");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleInsertRecord = async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    addLog("out", "insertRecord", { key: newKey, value: newValue });
    try {
      await agent.call("insertRecord", [newKey, newValue]);
      addLog("in", "inserted");
      toast("Record inserted", "success");
      setNewKey("");
      setNewValue("");
      loadRecords();
      loadTables();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <DemoWrapper
      title="SQL Queries"
      description={
        <>
          Every agent instance has its own embedded SQLite database, backed by
          Durable Object storage. Use{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            this.sql
          </code>{" "}
          as a tagged template literal for safe, parameterized queries — values
          are automatically escaped. Explore the tables below, run custom
          queries, or insert your own data.
        </>
      }
      statusIndicator={
        <ConnectionStatus
          status={
            agent.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          {/* Tables */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="flex items-center justify-between mb-4">
              <Text variant="heading3">Tables</Text>
              <Button variant="ghost" size="xs" onClick={loadTables}>
                Refresh
              </Button>
            </div>
            {tables.length === 0 ? (
              <p className="text-sm text-kumo-inactive">Loading...</p>
            ) : (
              <div className="space-y-1">
                {tables
                  .filter((t) => t.type === "table")
                  .map((table) => (
                    <button
                      type="button"
                      key={table.name}
                      onClick={() => handleSelectTable(table.name)}
                      className={`w-full text-left py-1.5 px-2 rounded text-sm transition-colors ${
                        selectedTable === table.name
                          ? "bg-kumo-contrast text-kumo-inverse"
                          : "hover:bg-kumo-tint text-kumo-default"
                      }`}
                    >
                      {table.name}
                    </button>
                  ))}
              </div>
            )}
          </Surface>

          {/* Schema */}
          {selectedTable && schema.length > 0 && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-4">
                <Text variant="heading3">Schema: {selectedTable}</Text>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Column</Table.Head>
                      <Table.Head>Type</Table.Head>
                      <Table.Head>Nullable</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {schema.map((col: unknown, i) => {
                      const c = col as {
                        name: string;
                        type: string;
                        notnull: number;
                      };
                      return (
                        <Table.Row key={i}>
                          <Table.Cell className="font-mono">
                            {c.name}
                          </Table.Cell>
                          <Table.Cell>{c.type}</Table.Cell>
                          <Table.Cell>{c.notnull ? "No" : "Yes"}</Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table>
              </div>
            </Surface>
          )}

          {/* Query */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Execute Query</Text>
            </div>
            <InputArea
              aria-label="SQL query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full h-24 font-mono"
              placeholder="SELECT * FROM ..."
            />
            <Button
              variant="primary"
              onClick={handleExecuteQuery}
              className="mt-2 w-full"
            >
              Execute
            </Button>
            <p className="text-xs text-kumo-subtle mt-2">
              Only SELECT queries are allowed in the playground
            </p>
          </Surface>

          {/* Query Result */}
          {queryResult && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-4">
                <Text variant="heading3">
                  Results ({queryResult.length} rows)
                </Text>
              </div>
              <div className="max-h-60 overflow-y-auto">
                <HighlightedJson data={queryResult} />
              </div>
            </Surface>
          )}

          {/* Insert Record */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Custom Data</Text>
            </div>
            <div className="flex gap-2 mb-3">
              <Input
                aria-label="Record key"
                type="text"
                value={newKey}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setNewKey(e.target.value)
                }
                className="flex-1"
                placeholder="Key"
              />
              <Input
                aria-label="Record value"
                type="text"
                value={newValue}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setNewValue(e.target.value)
                }
                className="flex-1"
                placeholder="Value"
              />
              <Button variant="primary" onClick={handleInsertRecord}>
                Insert
              </Button>
            </div>
            {records.length > 0 && (
              <div className="space-y-1">
                {records.map((r: unknown, i) => {
                  const rec = r as { key: string; value: string };
                  return (
                    <div
                      key={i}
                      className="flex justify-between py-1 px-2 bg-kumo-elevated rounded text-sm"
                    >
                      <span className="font-mono text-kumo-default">
                        {rec.key}
                      </span>
                      <span className="text-kumo-subtle">{rec.value}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Surface>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="400px" />
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
