import { v7 as uuidv7 } from "uuid";
import { connectWs, sendConfig, sendChat } from "../protocol/connection.js";
import { MSG_CHAT_RESPONSE } from "../protocol/constants.js";
import { extractText } from "../protocol/chunks.js";
import type { ThinkConfig } from "../local/config.js";

interface PrintOptions {
  config: ThinkConfig;
  mode: "text" | "json";
  message?: string;
}

export async function runPrint(options: PrintOptions): Promise<void> {
  let message = options.message;

  if (!message && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    message = Buffer.concat(chunks).toString().trim();
  }

  if (!message) {
    console.error("Usage: think -p \"your prompt\"");
    process.exit(1);
  }

  const session = options.config.session === "new" ? uuidv7() : options.config.session;
  const ws = connectWs(options.config.server, session);
  const requestId = crypto.randomUUID();
  let responseText = "";

  process.on("SIGINT", () => {
    ws.close();
    process.exit(0);
  });

  await new Promise<void>((resolve, reject) => {
    let configSent = false;
    let chatSent = false;

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === "cf_agent_identity" && !configSent) {
        configSent = true;
        sendConfig(ws, options.config);
      }

      if (msg.type === "cf_agent_mcp_servers" && !chatSent) {
        chatSent = true;
        setTimeout(() => sendChat(ws, requestId, message!), 100);
      }

      if (msg.type === MSG_CHAT_RESPONSE) {
        const resp = msg as { id: string; body: string; done: boolean };
        if (resp.id !== requestId) return;

        if (resp.done) {
          ws.close();
          if (options.mode === "text" && responseText && !responseText.endsWith("\n")) {
            process.stdout.write("\n");
          }
          resolve();
          return;
        }

        if (resp.body) {
          try {
            const chunk = JSON.parse(resp.body);
            if (options.mode === "json") {
              console.log(JSON.stringify(chunk));
            } else {
              const text = extractText(chunk);
              if (text) {
                process.stdout.write(text);
                responseText += text;
              }
            }
          } catch {}
        }
      }
    });

    ws.on("error", (err) => {
      console.error(`Error: ${err.message}`);
      reject(err);
    });
  });
}
