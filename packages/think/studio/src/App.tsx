import { forwardRef, useEffect, useState } from "react";
import { LinkProvider, type LinkComponentProps } from "@cloudflare/kumo";
import { loadStudioConfig, type StudioConfig } from "./lib/config";
import type { StudioConnection } from "./types";
import { ConnectView } from "./views/ConnectView";
import { Studio } from "./views/Studio";

// Studio has no router; this adapter just renders a plain anchor so Kumo's
// LinkProvider is satisfied for any component that renders a link.
const PlainLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(
  ({ to, ...props }, ref) => (
    // oxlint-disable-next-line jsx-a11y/anchor-has-content -- content via spread
    <a ref={ref} href={typeof to === "string" ? to : undefined} {...props} />
  )
);

export function App() {
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [connection, setConnection] = useState<StudioConnection | null>(null);

  useEffect(() => {
    void loadStudioConfig().then(setConfig);
  }, []);

  return (
    <LinkProvider component={PlainLink}>
      {config === null ? (
        <div className="flex h-full items-center justify-center text-kumo-inactive">
          Loading Think Studio…
        </div>
      ) : connection === null ? (
        <ConnectView config={config} onConnect={setConnection} />
      ) : (
        <Studio
          connection={connection}
          onDisconnect={() => setConnection(null)}
        />
      )}
    </LinkProvider>
  );
}
