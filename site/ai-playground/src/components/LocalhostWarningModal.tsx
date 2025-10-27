/** biome-ignore-all lint/a11y/noStaticElementInteractions: it's fine */
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
    <div
      onClick={handleHide}
      className="fixed top-0 left-0 bottom-0 right-0 bg-[rgba(255,255,255,0.5)] backdrop-blur-sm z-20 flex md:items-center md:justify-center items-end md:p-16"
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
        }}
        className="bg-white shadow-xl rounded-md md:max-w-2xl w-full p-6"
      >
        <h2 className="font-semibold text-xl flex items-center">
          Localhost is not allowed
          <div
            onClick={handleHide}
            className="ml-auto text-4xl text-gray-400 font-thin cursor-pointer"
          >
            ×
          </div>
        </h2>
        <p className="mt-2 text-gray-500">
          MCP servers are connected server-side. Localhost URLs cannot be
          accessed.
        </p>

        <div className="mt-4">
          <h3 className="font-semibold text-sm mb-3">
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

          <p className="text-sm text-gray-500 mt-4">
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
