export type ConnState = "connected" | "connecting" | "disconnected";

const config: Record<ConnState, { label: string; dot: string; cls: string }> = {
  connected: {
    label: "Connected",
    dot: "bg-green-500",
    cls: "bg-green-500/10 text-kumo-success"
  },
  connecting: {
    label: "Connecting…",
    dot: "bg-kumo-warning animate-pulse",
    cls: "bg-kumo-warning-tint text-kumo-warning"
  },
  disconnected: {
    label: "Disconnected",
    dot: "bg-kumo-danger",
    cls: "bg-kumo-danger-tint text-kumo-danger"
  }
};

export function StatusPill({ status }: { status: ConnState }) {
  const cfg = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${cfg.cls}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}
