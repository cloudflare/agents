import type { SettingsUpdate, SttSettings } from "./types";

export function getWorkersAIQuery(
  settings: SttSettings
): Record<string, string> {
  const query: Record<string, string> = { stt: settings.provider };
  if (settings.keyterms.trim()) query.keyterms = settings.keyterms.trim();
  return query;
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
