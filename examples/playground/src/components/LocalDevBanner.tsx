import { AlertTriangle } from "lucide-react";

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
    <div className="bg-red-600 text-white px-4 py-3 flex items-center justify-center gap-2 text-sm">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      <span>
        <strong>Local Development:</strong> Email routing requires deployment to
        Cloudflare. This demo won't receive real emails locally.
      </span>
    </div>
  );
}
