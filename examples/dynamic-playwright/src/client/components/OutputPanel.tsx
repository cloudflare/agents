import { LayerCard, Text } from "@cloudflare/kumo";
import { TerminalIcon } from "@phosphor-icons/react";
import type { RunResponse } from "../types";
import { ResultView } from "./ResultView";

type OutputPanelProps = {
  error: string | null;
  runResponse: RunResponse | null;
};

export function OutputPanel({ error, runResponse }: OutputPanelProps) {
  return (
    <LayerCard className="rounded-xl p-4 ring ring-kumo-line">
      <div className="mb-3 flex items-center gap-2">
        <TerminalIcon size={16} className="text-kumo-inactive" />
        <Text size="xs" variant="secondary" bold>
          Output
        </Text>
      </div>
      {error && (
        <pre className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 font-mono text-xs text-red-500 whitespace-pre-wrap">
          {error}
        </pre>
      )}
      {runResponse?.error && (
        <pre className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 font-mono text-xs text-red-500 whitespace-pre-wrap">
          {runResponse.error}
        </pre>
      )}
      {runResponse?.logs?.length ? (
        <pre className="mb-3 rounded-lg bg-kumo-elevated p-3 font-mono text-xs text-kumo-subtle whitespace-pre-wrap">
          {runResponse.logs.join("\n")}
        </pre>
      ) : null}
      {runResponse?.diagnostics !== undefined ? (
        <pre className="mb-3 rounded-lg bg-kumo-elevated p-3 font-mono text-xs text-kumo-subtle overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(runResponse.diagnostics, null, 2)}
        </pre>
      ) : null}
      {runResponse?.result !== undefined ? (
        <ResultView result={runResponse.result} />
      ) : (
        !error &&
        !runResponse?.error && (
          <Text size="xs" variant="secondary">
            Script logs and return values appear here.
          </Text>
        )
      )}
    </LayerCard>
  );
}
