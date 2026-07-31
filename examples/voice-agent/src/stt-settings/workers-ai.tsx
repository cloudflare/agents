import type { SettingsUpdate, SttProvider, SttSettings } from "./types";

export function getWorkersAIQuery(
  settings: SttSettings
): Record<string, string> {
  const query: Record<string, string> = { stt: settings.provider };
  if (settings.keyterms.trim()) query.keyterms = settings.keyterms.trim();
  return query;
}

export function getWorkersAIDescription(provider: SttProvider): string {
  if (provider === "workers-ai-nova-3") {
    return "Workers AI Nova 3 supports keyterm hints through the Workers AI binding.";
  }

  return "Workers AI Flux supports keyterm hints, server-side turn detection, and interruption handling.";
}

export function WorkersAISettings({
  settings,
  disabled,
  update
}: {
  settings: SttSettings;
  disabled: boolean;
  update: SettingsUpdate;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
      Keyterms, comma-separated
      <textarea
        value={settings.keyterms}
        disabled={disabled}
        rows={2}
        onChange={(event) => update({ keyterms: event.target.value })}
        className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
      />
    </label>
  );
}
