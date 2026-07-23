import type {
  AssemblyAIMode,
  SettingsUpdate,
  SttSettings,
  VoiceFocus
} from "./types";

export const DEFAULT_ASSEMBLYAI_PROMPT =
  "A helpful Cloudflare voice assistant. Users may ask about Cloudflare Workers, Durable Objects, Workers AI, voice agents, reminders, dates, times, and weather.";

export const DEFAULT_ASSEMBLYAI_KEYTERMS =
  "Cloudflare, Workers AI, Durable Objects, VoiceAgent, Kimi, GLM, GPT OSS";

export const ASSEMBLYAI_DESCRIPTION =
  "AssemblyAI Universal 3.5 Pro Realtime uses prompt and keyterm hints, as well as carrying full agent context to inform transcription.";

export function getAssemblyAIQuery(
  settings: SttSettings
): Record<string, string> {
  const query: Record<string, string> = {
    stt: "assemblyai",
    assemblyaiMode: settings.assemblyaiMode
  };

  if (settings.voiceFocus !== "off") query.voiceFocus = settings.voiceFocus;
  if (settings.assemblyaiLanguageCodes.trim()) {
    query.assemblyaiLanguageCodes = settings.assemblyaiLanguageCodes.trim();
  }
  if (settings.prompt.trim()) query.prompt = settings.prompt.trim();
  if (settings.keyterms.trim()) query.keyterms = settings.keyterms.trim();

  return query;
}

export function AssemblyAISettings({
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
          Mode
          <select
            value={settings.assemblyaiMode}
            disabled={disabled}
            onChange={(event) =>
              update({ assemblyaiMode: event.target.value as AssemblyAIMode })
            }
            className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
          >
            <option value="min_latency">Min latency</option>
            <option value="balanced">Balanced</option>
            <option value="max_accuracy">Max accuracy</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
          Voice Focus
          <select
            value={settings.voiceFocus}
            disabled={disabled}
            onChange={(event) =>
              update({ voiceFocus: event.target.value as VoiceFocus })
            }
            className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
          >
            <option value="off">Off</option>
            <option value="near-field">Near field</option>
            <option value="far-field">Far field</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
        Language codes, comma-separated
        <input
          value={settings.assemblyaiLanguageCodes}
          disabled={disabled}
          placeholder="auto, or en,es"
          onChange={(event) =>
            update({ assemblyaiLanguageCodes: event.target.value })
          }
          className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
        Context prompt
        <textarea
          value={settings.prompt}
          disabled={disabled}
          rows={3}
          onChange={(event) => update({ prompt: event.target.value })}
          className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
        />
      </label>
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
