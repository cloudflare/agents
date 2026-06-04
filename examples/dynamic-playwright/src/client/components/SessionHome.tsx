import { Button, Empty, LayerCard, Text } from "@cloudflare/kumo";
import { BrowserIcon, StopIcon } from "@phosphor-icons/react";
import type { BrowserSessionState, Session } from "../types";

type SessionHomeProps = {
  browserSession: BrowserSessionState;
};

export function SessionHome({ browserSession }: SessionHomeProps) {
  const {
    sessions,
    creatingSession,
    stopping,
    error,
    createSession,
    selectSession,
    stop
  } = browserSession;

  return (
    <LayerCard className="rounded-xl p-5 ring ring-kumo-line">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-kumo-line pb-4">
        <div className="flex items-start gap-3">
          <BrowserIcon size={20} className="mt-0.5 text-kumo-inactive" />
          <div>
            <Text size="sm" bold>
              Browser sessions
            </Text>
            <span className="mt-1 block">
              <Text size="xs" variant="secondary">
                Re-join an existing Browser Run session, stop one you no longer
                need, or start a fresh session.
              </Text>
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={creatingSession}
            onClick={createSession}
          >
            New session
          </Button>
        </div>
      </div>

      {error && (
        <pre className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 p-3 font-mono text-xs text-red-500 whitespace-pre-wrap">
          {error}
        </pre>
      )}

      {sessions.length ? (
        <div className="mt-4 grid gap-3">
          {sessions.map((session, index) => (
            <SessionRow
              key={session.sessionId}
              index={index}
              session={session}
              stopping={stopping}
              onJoin={() => selectSession(session.sessionId)}
              onStop={() => stop(session.sessionId)}
            />
          ))}
        </div>
      ) : (
        <div className="py-12">
          <Empty
            icon={<BrowserIcon size={28} />}
            title="No browser sessions"
            description="Create a session to open the Puppeteer workspace."
          />
        </div>
      )}
    </LayerCard>
  );
}

function SessionRow({
  index,
  session,
  stopping,
  onJoin,
  onStop
}: {
  index: number;
  session: Session;
  stopping: boolean;
  onJoin: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-base p-4">
      <div>
        <Text size="sm" bold>
          Session {index + 1}
        </Text>
        <div className="mt-1 font-mono text-xs text-kumo-secondary">
          {session.sessionId}
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={onJoin}>
          Re-join
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<StopIcon size={14} weight="fill" />}
          loading={stopping}
          onClick={onStop}
        >
          Stop
        </Button>
      </div>
    </div>
  );
}
