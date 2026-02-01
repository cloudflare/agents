interface ConnectionStatusProps {
  status: "connected" | "connecting" | "disconnected";
  agentName?: string;
  instanceName?: string;
}

export function ConnectionStatus({
  status,
  agentName,
  instanceName
}: ConnectionStatusProps) {
  const statusClass =
    status === "connected"
      ? "status-connected"
      : status === "connecting"
        ? "status-connecting"
        : "status-disconnected";

  const statusLabel =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";

  return (
    <div className="flex items-center gap-2 text-sm">
      <div className={`status-dot ${statusClass}`} />
      <span className="text-neutral-600 dark:text-neutral-400">
        {statusLabel}
      </span>
      {agentName && instanceName && status === "connected" && (
        <span className="text-neutral-400 dark:text-neutral-500">
          {agentName}/{instanceName}
        </span>
      )}
    </div>
  );
}
