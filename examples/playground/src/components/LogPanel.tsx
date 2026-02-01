import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";

export interface LogEntry {
  id: string;
  timestamp: Date;
  direction: "in" | "out" | "error" | "info";
  type: string;
  data: unknown;
}

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
  maxHeight?: string;
}

export function LogPanel({
  logs,
  onClear,
  maxHeight = "300px"
}: LogPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const getLogClass = (direction: LogEntry["direction"]) => {
    switch (direction) {
      case "in":
        return "log-entry log-entry-in";
      case "out":
        return "log-entry log-entry-out";
      case "error":
        return "log-entry log-entry-error";
      default:
        return "log-entry";
    }
  };

  const getDirectionLabel = (direction: LogEntry["direction"]) => {
    switch (direction) {
      case "in":
        return "←";
      case "out":
        return "→";
      case "error":
        return "✕";
      default:
        return "•";
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          Event Log
        </span>
        <button
          type="button"
          onClick={onClear}
          className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
          title="Clear logs"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight }}>
        {logs.length === 0 ? (
          <div className="px-3 py-4 text-xs text-neutral-400 text-center">
            No events yet
          </div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className={getLogClass(log.direction)}>
              <span className="text-neutral-400">
                {log.timestamp.toLocaleTimeString()}
              </span>
              <span className="mx-2 font-bold">
                {getDirectionLabel(log.direction)}
              </span>
              <span className="font-semibold">{log.type}</span>
              {log.data !== undefined && (
                <span className="ml-2 text-neutral-600 dark:text-neutral-400">
                  {typeof log.data === "string"
                    ? log.data
                    : JSON.stringify(log.data)}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
