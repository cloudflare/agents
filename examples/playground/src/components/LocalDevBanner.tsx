import { WarningIcon } from "@phosphor-icons/react";
import { Banner } from "@cloudflare/kumo";

/**
 * Shows a warning banner when running on localhost or local network IPs.
 * Email routing only works when deployed to Cloudflare.
 */
export function LocalDevBanner() {
  // Check if we're running locally
  const isLocal =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      /^192\.168\./.test(window.location.hostname) ||
      /^10\./.test(window.location.hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(window.location.hostname));

  if (!isLocal) return null;

  return (
    <Banner variant="error" icon={<WarningIcon size={16} />}>
      <strong>Local Development:</strong> Email routing requires deployment to
      Cloudflare. This demo won't receive real emails locally.
    </Banner>
  );
}
