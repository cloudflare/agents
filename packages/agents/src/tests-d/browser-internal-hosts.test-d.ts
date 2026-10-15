/**
 * Type-level tests for `browserRun({ internalHosts })`: a typed `target`
 * schema types `fetch`'s second argument, a plain JSON Schema leaves it
 * `unknown`, and a host takes exactly one of `fetch` or `fetcher`.
 */
import { z } from "zod";
import { browserRun } from "../browser/providers/browser-run";
import {
  proxyTo,
  type InternalHostRouterLoopback
} from "../browser/internal-hosts";

declare const binding: Fetcher;
declare const router: InternalHostRouterLoopback;
declare const fetcher: Fetcher;
declare function sandboxPort(port: number, request: Request): Promise<Response>;

browserRun(binding, {
  guardrails: { allowedDomains: [] },
  internalHosts: {
    router,
    hosts: {
      "docs.internal": {
        description: "Staging docs",
        fetch: proxyTo("https://docs.example.com", {
          headers: { Authorization: "Bearer token" }
        })
      },
      "api.internal": { fetcher },
      "preview.internal": {
        target: z.object({ port: z.number().int() }),
        fetch: (request, { port }) => {
          const typed: number = port;
          // @ts-expect-error port is a number, not any
          const notString: string = port;
          void notString;
          return sandboxPort(typed, request);
        }
      },
      "site.internal": {
        target: {
          type: "object",
          properties: { folder: { type: "string" } },
          required: ["folder"]
        },
        fetch: async (_request, target) => {
          const untyped: unknown = target;
          // @ts-expect-error a plain JSON Schema leaves the target unknown
          target.folder;
          return new Response(String(untyped));
        }
      }
    }
  }
});

browserRun(binding, {
  internalHosts: {
    router,
    hosts: {
      "preview.internal": {
        target: z.object({ port: z.number() }),
        // @ts-expect-error the target has no `folder`
        fetch: async (_request, { folder }) => new Response(folder)
      }
    }
  }
});

browserRun(binding, {
  internalHosts: {
    hosts: {
      // @ts-expect-error a fetcher host can't also have a target
      "api.internal": { fetcher, target: z.object({ port: z.number() }) }
    }
  }
});
