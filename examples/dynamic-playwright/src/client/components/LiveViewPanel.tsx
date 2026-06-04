import { useEffect, useRef, useState } from "react";
import { Button, Empty, LayerCard, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, BrowserIcon } from "@phosphor-icons/react";
import type { BrowserSessionState } from "../types";

type LiveViewPanelProps = {
  browserSession: BrowserSessionState;
};

const LIVE_VIEW_WIDTH = 1280;
const LIVE_VIEW_HEIGHT = 720;

export function LiveViewPanel({ browserSession }: LiveViewPanelProps) {
  const [liveViewSrcBySessionId, setLiveViewSrcBySessionId] = useState<
    Record<string, string>
  >({});
  const {
    sessions,
    selectedSession,
    selectedTarget,
    creatingSession,
    refreshingTargets,
    createSession,
    refreshTargets,
    selectSession
  } = browserSession;
  const selectedSessionId = selectedSession?.sessionId ?? null;

  useEffect(() => {
    if (!selectedSessionId || !selectedTarget) return;

    setLiveViewSrcBySessionId((current) => {
      if (current[selectedSessionId]) return current;
      return {
        ...current,
        [selectedSessionId]: selectedTarget.devtoolsFrontendUrl
      };
    });
  }, [selectedSessionId, selectedTarget]);

  useEffect(() => {
    const sessionIds = new Set(sessions.map((session) => session.sessionId));
    setLiveViewSrcBySessionId((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([sessionId]) =>
          sessionIds.has(sessionId)
        )
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
  }, [sessions]);

  const liveViewSrc = selectedSessionId
    ? (liveViewSrcBySessionId[selectedSessionId] ?? null)
    : null;

  return (
    <LayerCard className="overflow-hidden rounded-xl ring ring-kumo-line">
      <div className="flex items-center justify-between border-b border-kumo-line bg-kumo-base px-4 py-3">
        <div className="flex items-center gap-2">
          <BrowserIcon size={16} className="text-kumo-inactive" />
          <Text size="xs" variant="secondary" bold>
            Live View
          </Text>
        </div>
        {selectedSession && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-kumo-secondary">
              {selectedSession.sessionId.slice(0, 8)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="Refresh Live View"
              icon={<ArrowsClockwiseIcon size={14} />}
              loading={refreshingTargets}
              onClick={refreshTargets}
            />
          </div>
        )}
        {!selectedSession && (
          <Button
            variant="primary"
            size="sm"
            loading={creatingSession}
            onClick={createSession}
          >
            New session
          </Button>
        )}
      </div>
      {sessions.length > 1 && (
        <div className="flex gap-2 overflow-x-auto border-b border-kumo-line bg-kumo-base px-3 py-2">
          {sessions.map((session, index) => (
            <Button
              key={session.sessionId}
              variant={
                session.sessionId === selectedSession?.sessionId
                  ? "primary"
                  : "secondary"
              }
              size="sm"
              onClick={() => selectSession(session.sessionId)}
            >
              Session {index + 1}
            </Button>
          ))}
        </div>
      )}
      <div className="bg-kumo-elevated">
        {liveViewSrc ? (
          <ScaledLiveViewFrame src={liveViewSrc} />
        ) : (
          <div className="aspect-video flex items-center justify-center p-6">
            <Empty
              icon={<BrowserIcon size={28} />}
              title="No page yet"
              description="Run a script to create the session page and mount its Live View here."
            />
          </div>
        )}
      </div>
    </LayerCard>
  );
}

function ScaledLiveViewFrame({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  const scale =
    containerWidth > 0 ? Math.min(1, containerWidth / LIVE_VIEW_WIDTH) : 1;

  return (
    <div
      ref={containerRef}
      className="overflow-hidden"
      style={{ height: LIVE_VIEW_HEIGHT * scale }}
    >
      <iframe
        title="Browser Run Live View"
        src={src}
        className="block border-0 bg-white"
        allow="clipboard-read; clipboard-write"
        height={LIVE_VIEW_HEIGHT * scale}
        width={LIVE_VIEW_WIDTH * scale}
        style={{
          width: LIVE_VIEW_WIDTH,
          height: LIVE_VIEW_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "top left"
        }}
      />
    </div>
  );
}
