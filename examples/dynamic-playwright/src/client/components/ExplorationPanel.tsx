import { useState } from "react";
import { Button, LayerCard, Text } from "@cloudflare/kumo";
import { BrowserIcon, SparkleIcon } from "@phosphor-icons/react";
import type { BrowserSessionState, ExplorationResult } from "../types";

type ExplorationPanelProps = {
  browserSession: BrowserSessionState;
  onScriptChange: (script: string) => void;
};

export function ExplorationPanel({
  browserSession,
  onScriptChange
}: ExplorationPanelProps) {
  const [description, setDescription] = useState(
    "Explore https://example.com and write a script that verifies the page title."
  );

  async function explore() {
    const result = await browserSession.explore(description);
    if (result) onScriptChange(result.script);
  }

  return (
    <LayerCard className="rounded-xl p-4 ring ring-kumo-line">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <SparkleIcon size={16} className="mt-0.5 text-kumo-accent" />
          <div>
            <Text size="xs" variant="secondary" bold>
              AI exploration
            </Text>
            <span className="mt-1 block">
              <Text size="xs" variant="secondary">
                Describe a browser task. The agent explores in one session,
                submits a script, then tests it in a fresh session.
              </Text>
            </span>
          </div>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<BrowserIcon size={14} weight="fill" />}
          loading={browserSession.exploring}
          onClick={explore}
        >
          Explore
        </Button>
      </div>

      <textarea
        aria-label="AI exploration description"
        className="min-h-24 w-full resize-y rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm leading-6 text-kumo-default outline-none"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />

      {browserSession.explorationResponse ? (
        <ExplorationResultView result={browserSession.explorationResponse} />
      ) : null}
    </LayerCard>
  );
}

function ExplorationResultView({ result }: { result: ExplorationResult }) {
  return (
    <div className="mt-3 grid gap-3">
      <div className="rounded-lg bg-kumo-elevated p-3">
        <Text size="xs" variant="secondary">
          {result.summary}
        </Text>
      </div>
      <details className="rounded-lg border border-kumo-line bg-kumo-base p-3">
        <summary className="cursor-pointer text-xs font-medium text-kumo-secondary">
          Tool trace ({result.trace.length})
        </summary>
        <pre className="mt-3 max-h-80 overflow-auto font-mono text-xs text-kumo-subtle whitespace-pre-wrap">
          {JSON.stringify(result.trace, null, 2)}
        </pre>
      </details>
    </div>
  );
}
