import type { SettingsUpdate, SttSettings } from "./types";

export const ELEVENLABS_DESCRIPTION =
  "ElevenLabs Scribe v2 Realtime uses VAD commits, keyterms, and optional cleanup/background filtering. Requires ELEVENLABS_API_KEY.";

export function getElevenLabsQuery(
  settings: SttSettings
): Record<string, string> {
  const query: Record<string, string> = { stt: "elevenlabs" };

  if (settings.language) query.language = settings.language;
  if (settings.keyterms.trim()) query.keyterms = settings.keyterms.trim();
  query.noVerbatim = String(settings.elevenlabsNoVerbatim);
  query.filterBackgroundAudio = String(
    settings.elevenlabsFilterBackgroundAudio
  );

  return query;
}

export function ElevenLabsSettings({
  settings,
  disabled,
  update
}: {
  settings: SttSettings;
  disabled: boolean;
  update: SettingsUpdate;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
          Language
          <input
            value={settings.language}
            disabled={disabled}
            placeholder="auto"
            onChange={(event) => update({ language: event.target.value })}
            className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
          />
        </label>
        <div className="flex flex-col gap-2 pt-1 text-xs text-kumo-secondary">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.elevenlabsNoVerbatim}
              disabled={disabled}
              onChange={(event) =>
                update({ elevenlabsNoVerbatim: event.target.checked })
              }
            />
            Clean up disfluencies
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.elevenlabsFilterBackgroundAudio}
              disabled={disabled}
              onChange={(event) =>
                update({
                  elevenlabsFilterBackgroundAudio: event.target.checked
                })
              }
            />
            Filter background audio
          </label>
        </div>
      </div>
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
    </>
  );
}
