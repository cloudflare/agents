import { useEffect, useRef } from "react";
import { TrashIcon } from "@phosphor-icons/react";
import { Button, Surface } from "@cloudflare/kumo";

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
      case "info":
        return "log-entry log-entry-info";
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

  const getDirectionColor = (direction: LogEntry["direction"]) => {
    switch (direction) {
      case "in":
        return "text-kumo-success";
      case "out":
        return "text-kumo-info";
      case "error":
        return "text-kumo-danger";
      default:
        return "text-kumo-subtle";
    }
  };

  return (
    <Surface className="overflow-hidden rounded-lg ring ring-kumo-line">
      <div className="flex items-center justify-between px-3 py-2 border-b border-kumo-line bg-kumo-elevated">
        <span className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
          Event Log
        </span>
        <Button
          variant="ghost"
          shape="square"
          size="xs"
          aria-label="Clear logs"
          icon={<TrashIcon size={14} />}
          onClick={onClear}
          title="Clear logs"
        />
      </div>

      <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight }}>
        {logs.length === 0 ? (
          <div className="px-3 py-3 text-xs text-kumo-inactive">
            Waiting for events…
          </div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className={getLogClass(log.direction)}>
              <span className="text-kumo-inactive">
                {log.timestamp.toLocaleTimeString()}
              </span>
              <span
                className={`mx-2 font-bold ${getDirectionColor(log.direction)}`}
              >
                {getDirectionLabel(log.direction)}
              </span>
              <span className="font-semibold text-kumo-default">
                {log.type}
              </span>
              {log.data !== undefined && (
                <span className="ml-2 text-kumo-subtle">
                  {typeof log.data === "string"
                    ? log.data
                    : JSON.stringify(log.data)}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </Surface>
  );
}
