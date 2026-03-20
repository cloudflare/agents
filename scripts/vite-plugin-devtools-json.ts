import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import type { Plugin } from "vite";

const ENDPOINT = "/.well-known/appspecific/com.chrome.devtools.json";

function generateUUID(): string {
  return crypto.randomUUID();
}

function isValidUUID(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    uuid
  );
}

export default function devtoolsJson(
  options: { uuid?: string; projectRoot?: string } = {}
): Plugin {
  return {
    name: "devtools-json",
    enforce: "post",

    configureServer(server) {
      const { config } = server;

      if (!config.env.DEV) return;

      const getOrCreateUUID = () => {
        if (options.uuid) return options.uuid;

        let { cacheDir } = config;
        if (!path.isAbsolute(cacheDir)) {
          let { root } = config;
          if (!path.isAbsolute(root)) root = path.resolve(process.cwd(), root);
          cacheDir = path.resolve(root, cacheDir);
        }
        const uuidPath = path.resolve(cacheDir, "uuid.json");
        if (fs.existsSync(uuidPath)) {
          const uuid = fs.readFileSync(uuidPath, { encoding: "utf-8" });
          if (isValidUUID(uuid)) return uuid;
        }
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }
        const uuid = generateUUID();
        fs.writeFileSync(uuidPath, uuid, { encoding: "utf-8" });
        return uuid;
      };

      server.middlewares.use(ENDPOINT, async (_req, res) => {
        let root = options.projectRoot
          ? path.resolve(options.projectRoot)
          : config.root;
        if (!path.isAbsolute(root)) {
          root = path.resolve(process.cwd(), root);
        }

        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            { workspace: { root, uuid: getOrCreateUUID() } },
            null,
            2
          )
        );
      });
    },

    configurePreviewServer(server) {
      server.middlewares.use(ENDPOINT, async (_req, res) => {
        res.writeHead(404);
        res.end();
      });
    }
  };
}
