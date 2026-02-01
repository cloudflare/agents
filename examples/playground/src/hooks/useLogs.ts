import { useState } from "react";
import { nanoid } from "nanoid";
import type { LogEntry } from "../components";

export function useLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = (
    direction: LogEntry["direction"],
    type: string,
    data?: unknown
  ) => {
    setLogs((prev) => [
      ...prev,
      { id: nanoid(), timestamp: new Date(), direction, type, data }
    ]);
  };

  const clearLogs = () => setLogs([]);

  return { logs, addLog, clearLogs };
}
