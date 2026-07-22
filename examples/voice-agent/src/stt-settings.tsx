import { Surface } from "@cloudflare/kumo";
import {
  ASSEMBLYAI_DESCRIPTION,
  AssemblyAISettings,
  DEFAULT_ASSEMBLYAI_KEYTERMS,
  DEFAULT_ASSEMBLYAI_PROMPT,
  getAssemblyAIQuery
} from "./stt-settings/assemblyai";
import {
  ELEVENLABS_DESCRIPTION,
  ElevenLabsSettings,
  getElevenLabsQuery
} from "./stt-settings/elevenlabs";
import {
  TELNYX_DESCRIPTION,
  TelnyxSettings,
  getTelnyxQuery
} from "./stt-settings/telnyx";
import type { SttProvider, SttSettings } from "./stt-settings/types";
import {
  getWorkersAIDescription,
  getWorkersAIQuery
} from "./stt-settings/workers-ai";

export type { SttSettings } from "./stt-settings/types";

export const DEFAULT_STT_SETTINGS: SttSettings = {
  provider: "workers-ai-flux",
  assemblyaiMode: "balanced",
  voiceFocus: "off",
  assemblyaiLanguageCodes: "",
  prompt: DEFAULT_ASSEMBLYAI_PROMPT,
  keyterms: DEFAULT_ASSEMBLYAI_KEYTERMS,
  telnyxEngine: "Telnyx",
  telnyxModel: "",
  language: "",
  elevenlabsNoVerbatim: false,
  elevenlabsFilterBackgroundAudio: false
};

export function getSttQuery(settings: SttSettings): Record<string, string> {
  switch (settings.provider) {
    case "assemblyai":
      return getAssemblyAIQuery(settings);
    case "telnyx":
      return getTelnyxQuery(settings);
    case "elevenlabs":
      return getElevenLabsQuery(settings);
    case "workers-ai-flux":
    case "workers-ai-nova-3":
      return getWorkersAIQuery(settings.provider);
  }
}

function getProviderDescription(provider: SttProvider): string {
  switch (provider) {
    case "assemblyai":
      return ASSEMBLYAI_DESCRIPTION;
    case "telnyx":
      return TELNYX_DESCRIPTION;
    case "elevenlabs":
      return ELEVENLABS_DESCRIPTION;
    case "workers-ai-flux":
    case "workers-ai-nova-3":
      return getWorkersAIDescription(provider);
  }
}

export function ProviderSettings({
  settings,
  disabled,
  onChange
}: {
  settings: SttSettings;
  disabled: boolean;
  onChange: (settings: SttSettings) => void;
}) {
  const update = (patch: Partial<SttSettings>) => {
    onChange({ ...settings, ...patch });
  };
  const hasAdvancedSettings =
    settings.provider === "assemblyai" ||
    settings.provider === "telnyx" ||
    settings.provider === "elevenlabs";

  return (
    <Surface className="mb-4 rounded-xl p-3 ring ring-kumo-line">
      <div className="mb-3 flex flex-col gap-2">
        <span className="text-xs text-kumo-secondary">STT Provider</span>
        <select
          aria-label="Speech-to-text provider"
          value={settings.provider}
          disabled={disabled}
          onChange={(event) =>
            update({ provider: event.target.value as SttProvider })
          }
          className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
        >
          <option value="workers-ai-flux">Workers AI Flux</option>
          <option value="workers-ai-nova-3">Workers AI Nova 3</option>
          <option value="assemblyai">AssemblyAI Universal 3.5 Pro</option>
          <option value="telnyx">Telnyx STT</option>
          <option value="elevenlabs">ElevenLabs Scribe v2 Realtime</option>
        </select>
      </div>

      {hasAdvancedSettings && (
        <details className="mt-3 rounded-lg border border-kumo-line p-3">
          <summary className="cursor-pointer text-xs text-kumo-secondary">
            Advanced provider settings
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {settings.provider === "assemblyai" && (
              <AssemblyAISettings
                settings={settings}
                disabled={disabled}
                update={update}
              />
            )}
            {settings.provider === "telnyx" && (
              <TelnyxSettings
                settings={settings}
                disabled={disabled}
                update={update}
              />
            )}
            {settings.provider === "elevenlabs" && (
              <ElevenLabsSettings
                settings={settings}
                disabled={disabled}
                update={update}
              />
            )}
          </div>
        </details>
      )}

      <p className="mt-3 text-xs text-kumo-secondary">
        {getProviderDescription(settings.provider)}
      </p>
    </Surface>
  );
}
