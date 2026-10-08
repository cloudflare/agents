import { Select, Switch } from "@cloudflare/kumo";
import {
  isWebFetchFormat,
  MAX_PAGE_CHARS,
  MIN_PAGE_CHARS,
  type LabSettings
} from "./shared";

/**
 * The host-side fetch options, stored in the agent's state. The chat's
 * `web_fetch` tool and the URL Lab both read them; changes apply from the
 * next fetch.
 */
export function SettingsPanel({
  settings,
  disabled,
  onChange,
  popupContainer
}: {
  settings: LabSettings;
  disabled: boolean;
  onChange: (settings: LabSettings) => void;
  popupContainer?: HTMLElement | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="page-chars" className="text-sm text-kumo-default">
          Page size
        </label>
        <div className="flex items-center gap-2">
          <input
            id="page-chars"
            type="range"
            min={MIN_PAGE_CHARS}
            max={MAX_PAGE_CHARS}
            step={1_000}
            value={settings.pageChars}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...settings, pageChars: Number(event.target.value) })
            }
            className="w-28 accent-kumo-brand"
          />
          <span className="w-12 text-right text-sm text-kumo-default tabular-nums">
            {(settings.pageChars / 1000).toFixed(0)}k
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span id="format-label" className="text-sm text-kumo-default">
          Default format
        </span>
        <Select
          size="sm"
          aria-labelledby="format-label"
          className="w-28"
          disabled={disabled}
          container={popupContainer}
          value={settings.format}
          items={[
            { value: "auto", label: "auto" },
            { value: "raw", label: "raw" }
          ]}
          onValueChange={(value) => {
            if (isWebFetchFormat(value))
              onChange({ ...settings, format: value });
          }}
        />
      </div>
      <Switch
        label="Allow private hosts"
        controlFirst={false}
        size="sm"
        checked={settings.allowPrivateHosts}
        disabled={disabled}
        onCheckedChange={(allowPrivateHosts) =>
          onChange({ ...settings, allowPrivateHosts })
        }
      />
      <p className="text-xs leading-relaxed text-kumo-subtle">
        Page size is how many characters the model reads per call. Private hosts
        (localhost, 10.x, 169.254.x…) are refused unless allowed; in a deployed
        Worker they can't reach your machine anyway.
      </p>
    </div>
  );
}
