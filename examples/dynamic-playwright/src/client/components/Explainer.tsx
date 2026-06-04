import { LayerCard, Text } from "@cloudflare/kumo";
import { InfoIcon } from "@phosphor-icons/react";

export function Explainer() {
  return (
    <LayerCard className="rounded-xl p-4 ring ring-kumo-line">
      <div className="flex gap-3">
        <InfoIcon
          size={20}
          weight="bold"
          className="mt-0.5 shrink-0 text-kumo-accent"
        />
        <div>
          <Text size="sm" bold>
            Script-driven Browser Run session
          </Text>
          <span className="mt-1 block">
            <Text size="xs" variant="secondary">
              Paste a Puppeteer module, run it in a dynamically loaded Worker,
              and control the Browser Run session directly through Puppeteer.
            </Text>
          </span>
        </div>
      </div>
    </LayerCard>
  );
}
