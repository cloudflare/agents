import { useCallback, useRef } from "react";
import { Button, Empty } from "@cloudflare/kumo";
import {
  GlobeIcon,
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon
} from "@phosphor-icons/react";

interface PreviewPanelProps {
  url: string | null;
}

export function PreviewPanel({ url }: PreviewPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const refresh = useCallback(() => {
    if (iframeRef.current && url) {
      iframeRef.current.src = url;
    }
  }, [url]);

  return (
    <div className="flex flex-col h-full bg-kumo-base">
      {/* Preview toolbar */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-kumo-line bg-kumo-base shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {url && (
            <span className="text-[10px] font-mono text-kumo-subtle truncate max-w-[200px]">
              {url}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {url && (
            <>
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                aria-label="Refresh preview"
                icon={<ArrowCounterClockwiseIcon size={12} />}
                onClick={refresh}
              />
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                aria-label="Open in new tab"
                icon={<ArrowSquareOutIcon size={12} />}
                onClick={() => window.open(url, "_blank")}
              />
            </>
          )}
        </div>
      </div>
      {/* Iframe or empty state */}
      {url ? (
        <iframe
          ref={iframeRef}
          src={url}
          title="Sandbox preview"
          className="flex-1 w-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <Empty
            icon={<GlobeIcon size={24} />}
            title="No preview"
            description="Start a web server in the sandbox and the agent will expose it here"
          />
        </div>
      )}
    </div>
  );
}
