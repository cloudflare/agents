/**
 * E2E Test Helpers
 *
 * Shared utilities for E2E tests that run against the wrangler dev server.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Config file written by globalSetup
const CONFIG_FILE = join(__dirname, ".e2e-config.json");

// Cache the base URL after first read
let cachedBaseUrl: string | null = null;

/**
 * Get the base URL for the E2E server.
 * Reads from config file written by globalSetup.
 */
export function getBaseUrl(): string {
  if (cachedBaseUrl) {
    return cachedBaseUrl;
  }

  // Check config file first
  if (existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      if (config.baseUrl) {
        cachedBaseUrl = config.baseUrl as string;
        return cachedBaseUrl;
      }
    } catch {
      // Fall through to error
    }
  }

  // Fallback to env var
  if (process.env.E2E_URL) {
    cachedBaseUrl = process.env.E2E_URL;
    return cachedBaseUrl;
  }

  throw new Error(
    "E2E config not found. Make sure globalSetup ran correctly or set E2E_URL."
  );
}

/**
 * Generate a unique agent ID for test isolation.
 */
export function uniqueAgentId(prefix = "e2e"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Make a request to an agent endpoint.
 * Agent routes use the pattern: /agents/think/{roomId}{path}
 */
export async function agentRequest(
  agentId: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const baseUrl = getBaseUrl();
  // The agent SDK routes to /agents/{agentName}/{roomId}
  // Our agent is named "coder" in wrangler.jsonc
  const url = `${baseUrl}/agents/think/${agentId}${path}`;

  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });
}

/**
 * Send a chat message and wait for response.
 */
export async function sendChatMessage(
  agentId: string,
  message: string
): Promise<{ status: number; data: unknown }> {
  const response = await agentRequest(agentId, "/chat", {
    method: "POST",
    body: JSON.stringify({ message })
  });

  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Get agent state.
 */
export async function getAgentState(
  agentId: string
): Promise<{ status: number; data: unknown }> {
  const response = await agentRequest(agentId, "/state", {
    method: "GET"
  });

  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Get task list from agent.
 */
export async function getTasks(
  agentId: string
): Promise<{ status: number; data: unknown }> {
  const response = await agentRequest(agentId, "/tasks", {
    method: "GET"
  });

  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Get subagent status (requires ENABLE_SUBAGENT_API=true).
 */
export async function getSubagents(
  agentId: string
): Promise<{ status: number; data: unknown }> {
  const response = await agentRequest(agentId, "/subagents", {
    method: "GET"
  });

  if (response.status === 404) {
    return { status: 404, data: { error: "Subagent API disabled" } };
  }

  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Spawn a subagent for a task (requires ENABLE_SUBAGENT_API=true).
 */
export async function spawnSubagent(
  agentId: string,
  taskId: string
): Promise<{ status: number; data: unknown }> {
  const response = await agentRequest(agentId, "/subagents/spawn", {
    method: "POST",
    body: JSON.stringify({ taskId })
  });

  if (response.status === 404) {
    return { status: 404, data: { error: "Subagent API disabled" } };
  }

  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Wait for a condition with polling.
 */
export async function waitFor<T>(
  fn: () => Promise<T>,
  options: {
    condition: (result: T) => boolean;
    timeout?: number;
    interval?: number;
    description?: string;
  }
): Promise<T> {
  const { condition, timeout = 30000, interval = 1000, description } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await fn();
    if (condition(result)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Timeout waiting for ${description || "condition"} after ${timeout}ms`
  );
}

/**
 * Connect to agent WebSocket and collect events.
 */
export class WebSocketClient {
  private ws: WebSocket | null = null;
  private events: Array<{ type: string; data: unknown; timestamp: number }> =
    [];
  private closePromise: Promise<void> | null = null;

  async connect(agentId: string): Promise<void> {
    const baseUrl = getBaseUrl().replace("http://", "ws://");
    const url = `${baseUrl}/agents/${agentId}/websocket`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        resolve();
      };

      this.ws.onerror = (error) => {
        reject(new Error(`WebSocket error: ${error}`));
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          this.events.push({
            type: data.type,
            data,
            timestamp: Date.now()
          });
        } catch {
          // Non-JSON message
          this.events.push({
            type: "raw",
            data: event.data,
            timestamp: Date.now()
          });
        }
      };

      this.closePromise = new Promise((resolveClose) => {
        this.ws!.onclose = () => {
          resolveClose();
        };
      });
    });
  }

  getEvents(): Array<{ type: string; data: unknown; timestamp: number }> {
    return [...this.events];
  }

  getEventsByType(type: string): Array<{ data: unknown; timestamp: number }> {
    return this.events
      .filter((e) => e.type === type)
      .map((e) => ({ data: e.data, timestamp: e.timestamp }));
  }

  clearEvents(): void {
    this.events = [];
  }

  send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      throw new Error("WebSocket not connected");
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      await this.closePromise;
    }
  }

  async waitForEvent(
    type: string,
    timeout = 30000
  ): Promise<{ data: unknown; timestamp: number }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const events = this.getEventsByType(type);
      if (events.length > 0) {
        return events[events.length - 1];
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for WebSocket event: ${type}`);
  }
}

/**
 * Check if we have an OpenAI API key for LLM tests.
 * Reads from config file (set by globalSetup from .env)
 */
export function hasOpenAIKey(): boolean {
  // First check env var directly
  if (process.env.OPENAI_API_KEY) return true;

  // Then check config file (set by setup.ts which loads .env)
  if (existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      if (config.hasApiKey) return true;
    } catch {
      // Fall through
    }
  }

  return false;
}

/**
 * Skip description for tests requiring API key.
 */
export function skipWithoutApiKey(): string | false {
  return hasOpenAIKey() ? false : "OPENAI_API_KEY not set";
}
