import { XIcon } from "@phosphor-icons/react";
import ShellCommand from "./ShellCommand";

const LocalhostWarningModal = ({
  visible,
  handleHide
}: {
  visible: boolean;
  handleHide: (e: React.MouseEvent<HTMLDivElement>) => void;
}) => {
  if (!visible) return null;

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- modal backdrop dismiss
    <div
      onClick={handleHide}
      className="fixed inset-0 bg-kumo-base/50 backdrop-blur-sm z-20 flex md:items-center md:justify-center items-end md:p-16"
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- stop propagation */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-kumo-base shadow-xl rounded-lg md:max-w-2xl w-full p-6 ring ring-kumo-line"
      >
        <h2 className="font-semibold text-xl flex items-center text-kumo-default">
          Localhost is not allowed
          {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- close button */}
          <div
            onClick={handleHide}
            className="ml-auto text-kumo-secondary cursor-pointer hover:text-kumo-default"
          >
            <XIcon size={24} />
          </div>
        </h2>
        <p className="mt-2 text-kumo-secondary">
          MCP servers are connected server-side. Localhost URLs cannot be
          accessed.
        </p>

        <div className="mt-4">
          <h3 className="font-semibold text-sm mb-3 text-kumo-default">
            Use Cloudflare Tunnel for Local Development
          </h3>

          <div className="space-y-3">
            <ShellCommand
              command="brew install cloudflared"
              description="1. Install cloudflared (one-time setup)"
            />
            <ShellCommand
              command="npx wrangler dev"
              description="2. Start your dev server"
            />
            <ShellCommand
              command="cloudflared tunnel --url http://localhost:8787"
              description="3. In a new terminal, start the tunnel"
            />
          </div>

          <p className="text-sm text-kumo-secondary mt-4">
            Copy the tunnel URL (e.g., https://xyz.trycloudflare.com) and use it
            as your MCP server endpoint. Note you will need to add the /mcp
            path.
          </p>
        </div>
      </div>
    </div>
  );
};

export default LocalhostWarningModal;
