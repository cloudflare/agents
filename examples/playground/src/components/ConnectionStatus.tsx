interface ConnectionStatusProps {
  status: "connected" | "connecting" | "disconnected";
  agentName?: string;
  instanceName?: string;
}

const statusConfig = {
  connected: {
    label: "Connected",
    dot: "bg-green-500",
    text: "text-kumo-success",
    bg: "bg-green-500/10"
  },
  connecting: {
    label: "Connecting…",
    dot: "bg-kumo-warning animate-pulse",
    text: "text-kumo-warning",
    bg: "bg-kumo-warning-tint"
  },
  disconnected: {
    label: "Disconnected",
    dot: "bg-kumo-danger",
    text: "text-kumo-danger",
    bg: "bg-kumo-danger-tint"
  }
} as const;

export function ConnectionStatus({
  status,
  agentName,
  instanceName
}: ConnectionStatusProps) {
  const cfg = statusConfig[status];

  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={`inline-flex items-center justify-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium min-w-[6.5rem] ${cfg.bg} ${cfg.text}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
        {cfg.label}
      </span>
      {agentName && instanceName && status === "connected" && (
        <span className="text-kumo-inactive text-xs">
          {agentName}/{instanceName}
        </span>
      )}
    </div>
  );
}
