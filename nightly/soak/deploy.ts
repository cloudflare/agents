// Global setup: deploy the soak Worker under a unique name and delete it
// afterwards.

import path from "node:path";
import type { TestProject } from "vitest/node";
import { deploy, remove, workerName } from "../shared/deploy";

const DIR = import.meta.dirname;

/**
 * Until an agent's WebSocket opens three times in a row (bounded at 60 s):
 * a fresh deployment can answer HTTP before it accepts WebSocket upgrades,
 * and the rooms open theirs at once.
 */
async function webSocketsReady(url: string, key: string) {
  const ws = `${url.replace(/^http/, "ws")}/agents/probe-think/ready-${crypto.randomUUID()}?key=${encodeURIComponent(key)}`;
  const opens = () =>
    new Promise<boolean>((resolve) => {
      const socket = new WebSocket(ws);
      // An attempt that neither opens nor errors counts as a failure.
      const timer = setTimeout(() => {
        socket.close();
        resolve(false);
      }, 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        socket.close();
        resolve(true);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  const deadline = Date.now() + 60_000;
  let inARow = 0;
  while (inARow < 3) {
    if (Date.now() > deadline)
      throw new Error("the soak Worker never accepted WebSockets");
    inARow = (await opens()) ? inARow + 1 : 0;
    // Polling the deployment: a second between tries.
    if (inARow < 3) await new Promise((r) => setTimeout(r, 1000));
  }
}

export default async function setup(project: TestProject) {
  const name = workerName("soak");
  const key = crypto.randomUUID();
  try {
    const url = await deploy({
      config: path.join(DIR, "wrangler.jsonc"),
      cwd: DIR,
      name,
      key,
      build: "soak"
    });
    project.provide("probeUrl", url);
    project.provide("probeKey", key);
    await webSocketsReady(url, key);
  } catch (e) {
    try {
      remove(name, DIR);
    } catch {
      // never deployed
    }
    throw e;
  }
  return () => remove(name, DIR);
}
