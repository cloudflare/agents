import { useAgent } from "agents/react";
import { useState, useEffect } from "react";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type { SqlAgent } from "./sql-agent";

export function SqlDemo() {
  const { logs, addLog, clearLogs } = useLogs();
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
    name: "sql-demo",
    onOpen: () => {
      addLog("info", "connected");
      loadTables();
      loadRecords();
    },
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error")
  });

  const loadTables = async () => {
    try {
      const result = (await agent.call("listTables")) as Array<{
        name: string;
        type: string;
      }>;
      setTables(result);
    } catch {
      // Ignore
    }
  };

  const loadRecords = async () => {
    try {
      const result = (await agent.call("getRecords")) as unknown[];
      setRecords(result);
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    if (agent.readyState === WebSocket.OPEN) {
      loadTables();
      loadRecords();
    }
  }, [agent.readyState]);

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
      description="Each agent has its own SQLite database. Use the sql template literal for type-safe queries."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Connection</h3>
              <ConnectionStatus
                status={
                  agent.readyState === WebSocket.OPEN
                    ? "connected"
                    : "connecting"
                }
              />
            </div>
          </div>

          {/* Tables */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Tables</h3>
              <button
                type="button"
                onClick={loadTables}
                className="text-xs text-neutral-500 hover:text-black"
              >
                Refresh
              </button>
            </div>
            {tables.length === 0 ? (
              <p className="text-sm text-neutral-400">Loading...</p>
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
                          ? "bg-black text-white"
                          : "hover:bg-neutral-100"
                      }`}
                    >
                      {table.name}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Schema */}
          {selectedTable && schema.length > 0 && (
            <div className="card p-4">
              <h3 className="font-semibold mb-4">Schema: {selectedTable}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200">
                      <th className="text-left py-1">Column</th>
                      <th className="text-left py-1">Type</th>
                      <th className="text-left py-1">Nullable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schema.map((col: unknown, i) => {
                      const c = col as {
                        name: string;
                        type: string;
                        notnull: number;
                      };
                      return (
                        <tr key={i} className="border-b border-neutral-100">
                          <td className="py-1 font-mono">{c.name}</td>
                          <td className="py-1">{c.type}</td>
                          <td className="py-1">{c.notnull ? "No" : "Yes"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Query */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Execute Query</h3>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="input w-full h-24 font-mono text-sm"
              placeholder="SELECT * FROM ..."
            />
            <button
              type="button"
              onClick={handleExecuteQuery}
              className="btn btn-primary mt-2 w-full"
            >
              Execute
            </button>
            <p className="text-xs text-neutral-500 mt-2">
              Only SELECT queries are allowed in the playground
            </p>
          </div>

          {/* Query Result */}
          {queryResult && (
            <div className="card p-4">
              <h3 className="font-semibold mb-4">
                Results ({queryResult.length} rows)
              </h3>
              <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 p-3 rounded overflow-x-auto max-h-60">
                {JSON.stringify(queryResult, null, 2)}
              </pre>
            </div>
          )}

          {/* Insert Record */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Custom Data</h3>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="input flex-1"
                placeholder="Key"
              />
              <input
                type="text"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="input flex-1"
                placeholder="Value"
              />
              <button
                type="button"
                onClick={handleInsertRecord}
                className="btn btn-primary"
              >
                Insert
              </button>
            </div>
            {records.length > 0 && (
              <div className="space-y-1">
                {records.map((r: unknown, i) => {
                  const rec = r as { key: string; value: string };
                  return (
                    <div
                      key={i}
                      className="flex justify-between py-1 px-2 bg-neutral-50 dark:bg-neutral-800 rounded text-sm"
                    >
                      <span className="font-mono">{rec.key}</span>
                      <span>{rec.value}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="400px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
