import { Badge } from "@cloudflare/kumo";

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
  return (
    <div className="flex items-center gap-2 text-sm">
      {status === "connected" && <Badge variant="primary">Connected</Badge>}
      {status === "connecting" && <Badge variant="beta">Connecting...</Badge>}
      {status === "disconnected" && (
        <Badge variant="destructive">Disconnected</Badge>
      )}
      {agentName && instanceName && status === "connected" && (
        <span className="text-kumo-inactive">
          {agentName}/{instanceName}
        </span>
      )}
    </div>
  );
}
