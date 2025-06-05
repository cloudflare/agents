import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

const backgroundProcesses: ChildProcess[] = [];

// Helper function to check if a port is ready
async function waitForPort(
  host: string,
  port: number,
  timeout = 30000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host, port });
        socket.on("connect", () => {
          socket.end();
          resolve();
        });
        socket.on("error", (err) => {
          reject(err);
        });
      });
      console.log(`Port ${port} is ready!`);
      return true;
    } catch (err) {
      // Port not ready yet, wait a bit and try again
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  console.error(`Timed out waiting for port ${port} to be ready`);
  return false;
}

export async function setup() {
  // Start all servers
  backgroundProcesses.push(
    spawn(
      "wrangler",
      [
        "dev",
        "./fixtures/unauthenticated.ts",
        "--port",
        "8788",
        "--inspectorPort",
        "9229",
      ],
      {
        detached: true,
        stdio: "ignore",
        cwd: __dirname,
      }
    )
  );

  backgroundProcesses.push(
    spawn(
      "wrangler",
      [
        "dev",
        "./fixtures/bearer.ts",
        "--port",
        "8789",
        "--inspectorPort",
        "9230",
      ],
      {
        detached: true,
        stdio: "ignore",
        cwd: __dirname,
      }
    )
  );

  backgroundProcesses.push(
    spawn(
      "wrangler",
      [
        "dev",
        "./fixtures/oauth.ts",
        "--port",
        "8790",
        "--inspectorPort",
        "9231",
      ],
      {
        detached: true,
        stdio: "ignore",
        cwd: __dirname,
      }
    )
  );

  // Wait for all servers to be ready
  const ports = [8788, 8789, 8790];
  await Promise.all(ports.map((port) => waitForPort("localhost", port)));

  console.log("All servers are ready!");
}

export async function teardown() {
  // Clean up the background process
  for (const backgroundProcess of backgroundProcesses) {
    backgroundProcess.kill();
  }
}
