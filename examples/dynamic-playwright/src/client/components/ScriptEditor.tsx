import { Button, LayerCard, Text } from "@cloudflare/kumo";
import { CodeIcon, PlayIcon, StopIcon } from "@phosphor-icons/react";
import { SCRIPTS } from "../sampleScripts";

type ScriptEditorProps = {
  script: string;
  running: boolean;
  stopping: boolean;
  hasSession: boolean;
  onScriptChange: (script: string) => void;
  onRun: () => void;
  onStop: () => void;
};

export function ScriptEditor({
  script,
  running,
  stopping,
  hasSession,
  onScriptChange,
  onRun,
  onStop
}: ScriptEditorProps) {
  return (
    <LayerCard className="overflow-hidden rounded-xl ring ring-kumo-line">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <div className="flex items-center gap-2">
          <CodeIcon size={16} className="text-kumo-inactive" />
          <Text size="xs" variant="secondary" bold>
            script.js
          </Text>
        </div>
        <div className="flex flex-wrap gap-2">
          {SCRIPTS.map((item) => (
            <Button
              key={item.label}
              variant="secondary"
              size="sm"
              onClick={() => onScriptChange(item.code)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>
      <textarea
        aria-label="Puppeteer script"
        className="h-[520px] w-full resize-none border-0 bg-kumo-base p-4 font-mono text-sm leading-6 text-kumo-default outline-none"
        spellCheck={false}
        value={script}
        onChange={(event) => onScriptChange(event.target.value)}
      />
      <div className="flex items-center justify-between gap-3 border-t border-kumo-line bg-kumo-base px-4 py-3">
        <span>
          <Text size="xs" variant="secondary">
            Export a default function that receives{" "}
            <code className="font-mono">{"{ page }"}</code>.
          </Text>
        </span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<StopIcon size={14} weight="fill" />}
            disabled={!hasSession || running}
            loading={stopping}
            onClick={onStop}
          >
            Stop session
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<PlayIcon size={14} weight="fill" />}
            disabled={!hasSession}
            loading={running}
            onClick={onRun}
          >
            Run
          </Button>
        </div>
      </div>
    </LayerCard>
  );
}
