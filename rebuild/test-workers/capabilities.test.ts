import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createEmailTransport } from "../src/adapters/cloudflare/email.js";
import {
  serviceBindingFetch,
  workersFetch
} from "../src/adapters/cloudflare/http.js";
import { createWorkflowRuntime } from "../src/adapters/cloudflare/workflows.js";
import { NotFoundError } from "../src/kernel/errors.js";

function textFrom(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

function headerValue(raw: string, name: string): string {
  const prefix = `${name.toLowerCase()}:`;
  const lines = raw.split(/\r?\n/);
  const collected: string[] = [];

  for (const line of lines) {
    if (collected.length > 0 && /^[\t ]/.test(line)) {
      collected.push(line.trim());
      continue;
    }

    if (line.toLowerCase().startsWith(prefix)) {
      collected.push(line.slice(prefix.length).trim());
    } else if (collected.length > 0) {
      break;
    }
  }

  if (collected.length === 0) {
    throw new Error(`Missing ${name} header`);
  }

  return collected.join("");
}

function decodeRfc2047(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bB])\?([^?]*)\?=/g,
    (match: string, charset: string, _encoding: string, encoded: string) => {
      try {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return match;
      }
    }
  );
}

async function eventually<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string
): Promise<T> {
  const started = Date.now();
  let last: T;
  while (Date.now() - started < 10_000) {
    last = await fn();
    if (predicate(last)) return last;
    await scheduler.wait(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("Cloudflare capability adapters", () => {
  it("creates a Workflow instance and reads eventual status", async () => {
    const runtime = createWorkflowRuntime((name) => {
      if (name === "capability-workflow") return env.CAPABILITY_WORKFLOW;
      return undefined;
    });

    const id = `wf-${crypto.randomUUID()}`;
    await runtime.create("capability-workflow", {
      id,
      params: { value: "hello" }
    });

    const status = await eventually(
      () => runtime.status("capability-workflow", id),
      (current) => current !== null,
      "workflow status"
    );
    expect(status?.status).toEqual(expect.any(String));
  });

  it("throws NotFoundError for unknown Workflow bindings", async () => {
    const runtime = createWorkflowRuntime(() => undefined);
    await expect(
      runtime.create("missing-workflow", { id: "wf-missing" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("builds MIME and sends through an Email binding", async () => {
    const sent: unknown[] = [];
    const transport = createEmailTransport(
      {
        send: async (message: unknown): Promise<void> => {
          sent.push(message);
        }
      },
      { from: "sender@example.com" },
      {
        idSource: () => "fixed-message-id",
        messageFactory: (_from, _to, raw) => ({ raw })
      }
    );

    const result = await transport.send({
      from: "",
      to: "bob@example.com",
      subject: "Launch note",
      text: "Plain launch update",
      headers: { "X-Demo": "yes" }
    });

    expect(result.messageId).toBe("<fixed-message-id@agents-rebuild.local>");
    expect(sent).toHaveLength(1);
    const raw = (sent[0] as { raw: string }).raw;
    expect(raw).toContain("From: <sender@example.com>");
    expect(raw).toContain("To: <bob@example.com>");
    expect(decodeRfc2047(headerValue(raw, "Subject"))).toBe("Launch note");
    expect(raw).toContain(
      "Message-ID: <fixed-message-id@agents-rebuild.local>"
    );
    expect(raw).toContain("X-Demo: yes");
    expect(raw).toContain("Plain launch update");
  });

  it("fetches through the global Workers fetch adapter", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = SELF.fetch.bind(SELF);
    try {
      const response = await workersFetch("https://x/capabilities/echo", {
        method: "POST"
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-capability")).toBe("fetch");
      expect(response.headers.get("x-method")).toBe("POST");
      expect(await textFrom(await response.arrayBuffer())).toBe(
        "capability echo"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves manual redirects through service binding fetch", async () => {
    const fetchViaSelf = serviceBindingFetch({ fetch: SELF.fetch.bind(SELF) });
    const response = await fetchViaSelf("https://x/capabilities/redirect", {
      redirect: "manual"
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/capabilities/echo");
  });
});
