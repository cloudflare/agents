/**
 * Run the Worker locally behind a cloudflared tunnel and provision Plivo
 * against the tunnel URL — one command for local development.
 *
 * Plivo's cloud can't reach localhost, so cloudflared exposes the dev server
 * on a public *.trycloudflare.com URL. This script starts both, captures that
 * URL as the tunnel comes up, and points the Plivo application at it.
 * Requires cloudflared on PATH.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setupPlivoApplication } from "@cloudflare/voice-plivo";
import { requirePlivoEnv } from "./env.js";

const env = requirePlivoEnv();
const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Worker on localhost:8787.
const wrangler = spawn("wrangler", ["dev", "--port", "8787"], {
  stdio: "inherit"
});
children.push(wrangler);
wrangler.on("exit", () => shutdown(0));

// cloudflared quick tunnel → public URL.
const cloudflared = spawn("cloudflared", [
  "tunnel",
  "--url",
  "http://localhost:8787"
]);
children.push(cloudflared);

cloudflared.on("error", (err: Error & { code?: string }) => {
  if (err.code === "ENOENT") {
    console.error(
      "\ncloudflared is not installed. Get it from\n" +
        "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    );
  } else {
    console.error("\ncloudflared failed:", err.message);
  }
  shutdown(1);
});

let provisioned = false;

function onTunnelOutput(chunk: Buffer): void {
  const text = chunk.toString();
  process.stderr.write(text);
  if (provisioned) return;

  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!match) return;

  provisioned = true;
  const tunnelUrl = match[0];
  setupPlivoApplication({ ...env, answerUrl: `${tunnelUrl}/answer` })
    .then(() => {
      console.log(
        `\n✅ ${env.phoneNumber} → ${tunnelUrl}/answer. Call it. Ctrl+C to stop.`
      );
    })
    .catch((err: unknown) => {
      console.error("\nPlivo provisioning failed:", (err as Error).message);
      shutdown(1);
    });
}

cloudflared.stdout?.on("data", onTunnelOutput);
cloudflared.stderr?.on("data", onTunnelOutput);
