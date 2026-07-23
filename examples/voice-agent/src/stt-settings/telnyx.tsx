import type { SettingsUpdate, SttSettings, TelnyxEngine } from "./types";

export const TELNYX_DESCRIPTION =
  "Telnyx STT streams the same browser microphone audio to Telnyx's transcription WebSocket. Requires TELNYX_API_KEY.";

export function getTelnyxQuery(settings: SttSettings): Record<string, string> {
  const query: Record<string, string> = {
    stt: "telnyx",
    telnyxEngine: settings.telnyxEngine
  };

  if (settings.telnyxEngine === "Deepgram" && settings.telnyxModel) {
    query.telnyxModel = settings.telnyxModel;
  }
  if (settings.language) query.language = settings.language;

  return query;
}

export function TelnyxSettings({
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
          Engine
          <select
            value={settings.telnyxEngine}
            disabled={disabled}
            onChange={(event) =>
              update({
                telnyxEngine: event.target.value as TelnyxEngine,
                telnyxModel:
                  event.target.value === "Deepgram"
                    ? settings.telnyxModel || "flux"
                    : ""
              })
            }
            className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
          >
            <option value="Telnyx">Telnyx native</option>
            <option value="Deepgram">Deepgram via Telnyx</option>
          </select>
        </label>
        {settings.telnyxEngine === "Deepgram" && (
          <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
            Model
            <select
              value={settings.telnyxModel}
              disabled={disabled}
              onChange={(event) => update({ telnyxModel: event.target.value })}
              className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
            >
              <option value="flux">Flux</option>
              <option value="nova-3">Nova 3</option>
            </select>
          </label>
        )}
      </div>
      <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
        Language
        <input
          value={settings.language}
          disabled={disabled}
          placeholder="en"
          onChange={(event) => update({ language: event.target.value })}
          className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
        />
      </label>
      <p className="text-xs text-kumo-secondary">
        Telnyx live interim transcripts require the Deepgram engine.
      </p>
    </>
  );
}
