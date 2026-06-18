import { Badge, Surface, Text } from "@cloudflare/kumo";
import { StatusPill, type ConnState } from "../components/StatusPill";

export interface InspectorProps {
  status: ConnState;
  identity: { name: string; agent: string } | null;
  endpoint: { host: string; protocol: string; basePath: string };
  state: unknown;
  messageCount: number;
  isStreaming: boolean;
  isRecovering: boolean;
  chatStatus: string;
}

function turnBadge(props: InspectorProps) {
  if (props.isRecovering) return <Badge variant="warning">Recovering</Badge>;
  if (props.isStreaming) return <Badge variant="info">Streaming</Badge>;
  if (props.chatStatus === "submitted")
    return <Badge variant="info">Working</Badge>;
  if (props.chatStatus === "error")
    return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="secondary">Idle</Badge>;
}

function Row({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <Text size="xs" variant="secondary">
        {label}
      </Text>
      <div className="text-right text-xs text-kumo-default break-all">
        {children}
      </div>
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const stateJson =
    props.state === undefined || props.state === null
      ? null
      : JSON.stringify(props.state, null, 2);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <Text size="sm" bold>
        Inspector
      </Text>

      <Surface className="rounded-xl p-3 ring ring-kumo-line">
        <Row label="Agent">{props.identity?.agent ?? "—"}</Row>
        <Row label="Instance">{props.identity?.name ?? "—"}</Row>
        <Row label="Connection">
          <StatusPill status={props.status} />
        </Row>
        <Row label="Turn">{turnBadge(props)}</Row>
        <Row label="History">{props.messageCount} messages</Row>
      </Surface>

      <Surface className="rounded-xl p-3 ring ring-kumo-line">
        <Text size="xs" variant="secondary" bold>
          Endpoint
        </Text>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-kumo-subtle">
          {`${props.endpoint.protocol}://${props.endpoint.host}/${props.endpoint.basePath}`}
        </pre>
      </Surface>

      <Surface className="flex-1 rounded-xl p-3 ring ring-kumo-line">
        <Text size="xs" variant="secondary" bold>
          Live state
        </Text>
        {stateJson === null ? (
          <p className="mt-1 text-xs italic text-kumo-inactive">No state yet</p>
        ) : (
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-kumo-subtle">
            {stateJson}
          </pre>
        )}
      </Surface>
    </div>
  );
}
