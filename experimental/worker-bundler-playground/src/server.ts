import { routeAgentRequest, callable } from "agents";
import { Workspace } from "@cloudflare/shell";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  createApp,
  handleAssetRequest,
  createMemoryStorage
} from "@cloudflare/worker-bundler";
import type { CreateAppResult, AssetConfig } from "@cloudflare/worker-bundler";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

export interface AppState {
  built: boolean;
  mainModule?: string;
  moduleNames?: string[];
  clientBundles?: string[];
  assetCount?: number;
  warnings?: string[];
  source?: Record<string, string>;
  assets?: Record<string, string>;
}

export class WorkerPlayground extends AIChatAgent<Env> {
  workspace = new Workspace(this);
  currentAppResult?: CreateAppResult;
  buildVersion = 0;

  async onStart() {
    // Restore build version so loader IDs don't collide after hibernation
    this.buildVersion =
      ((await this.ctx.storage.get("buildVersion")) as number) ?? 0;

    // Restore and broadcast app state from workspace so clients
    // see the right panel immediately on connect / page refresh
    const source = await this.readSourceFiles();
    const assets = await this.readAssetFiles();
    if (Object.keys(source).length > 0) {
      const state: AppState = {
        built: true,
        source,
        assets: Object.keys(assets).length > 0 ? assets : undefined
      };
      this.setState(state);
    }
  }

  private async readSourceFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const entries = await this.workspace.glob("/src/**");

    for (const entry of entries) {
      if (entry.type === "file") {
        const content = await this.workspace.readFile(entry.path);
        if (content !== null) {
          // Strip leading slash to match createApp's expected format
          files[entry.path.slice(1)] = content;
        }
      }
    }

    // Also read root config files (package.json, wrangler.jsonc, etc.)
    for (const name of ["package.json", "wrangler.jsonc", "tsconfig.json"]) {
      const content = await this.workspace.readFile("/" + name);
      if (content !== null) {
        files[name] = content;
      }
    }

    return files;
  }

  private async readAssetFiles(): Promise<Record<string, string>> {
    const assets: Record<string, string> = {};
    const entries = await this.workspace.glob("/assets/**");

    for (const entry of entries) {
      if (entry.type === "file") {
        const content = await this.workspace.readFile(entry.path);
        if (content !== null) {
          // Convert /assets/index.html → /index.html
          const pathname = entry.path.replace(/^\/assets/, "");
          assets[pathname] = content;
        }
      }
    }

    return assets;
  }

  @callable({ description: "Clear all workspace files and reset state" })
  async clearWorkspace(): Promise<void> {
    const existing = await this.workspace.glob("/**");
    for (const entry of existing) {
      if (entry.type === "file") {
        await this.workspace.deleteFile(entry.path);
      }
    }
    this.currentAppResult = undefined;
    this.buildVersion = 0;
    await this.ctx.storage.put("buildVersion", 0);
    // Abort the running facet so a fresh one is created on next build
    (
      this.ctx as unknown as {
        facets: { abort(name: string, err: Error): void };
      }
    ).facets.abort("app", new Error("Workspace cleared"));
    this.setState({} as AppState);
  }

  @callable({
    description: "Build a full-stack app from source files and assets"
  })
  async buildApp(
    files: Record<string, string>,
    assets?: Record<string, string>,
    assetConfig?: AssetConfig
  ): Promise<AppState> {
    // Abort the previous facet so storage is preserved but the code refreshes
    (
      this.ctx as unknown as {
        facets: { abort(name: string, err: Error): void };
      }
    ).facets.abort("app", new Error("Rebuilding app"));
    this.buildVersion++;
    await this.ctx.storage.put("buildVersion", this.buildVersion);

    const result = await createApp({
      files,
      server: "src/server.ts",
      assets: assets ?? {},
      assetConfig: assetConfig ?? {
        not_found_handling: "single-page-application"
      }
    });
    this.currentAppResult = result;

    // Persist source files to workspace
    const existing = await this.workspace.glob("/**");
    for (const entry of existing) {
      if (entry.type === "file") {
        await this.workspace.deleteFile(entry.path);
      }
    }
    for (const [path, content] of Object.entries(files)) {
      await this.workspace.writeFile("/" + path, content);
    }

    // Persist assets under /assets/ prefix
    if (assets) {
      for (const [pathname, content] of Object.entries(assets)) {
        await this.workspace.writeFile("/assets" + pathname, content);
      }
    }

    const state: AppState = {
      built: true,
      mainModule: result.mainModule,
      moduleNames: Object.keys(result.modules),
      clientBundles: result.clientBundles,
      assetCount: result.assetManifest.size,
      warnings: result.warnings,
      source: files,
      assets
    };

    // Push to all connected clients so the right panel updates
    this.setState(state);

    return state;
  }

  private async ensureAppBuilt(): Promise<CreateAppResult> {
    if (this.currentAppResult) {
      return this.currentAppResult;
    }

    // Rebuild from workspace files after hibernation
    const source = await this.readSourceFiles();
    if (Object.keys(source).length === 0) {
      throw new Error("No app has been built yet. Build one first.");
    }

    const assets = await this.readAssetFiles();
    const result = await createApp({
      files: source,
      server: "src/server.ts",
      assets,
      assetConfig: { not_found_handling: "single-page-application" }
    });
    this.currentAppResult = result;
    return result;
  }

  private getAppFacet(result: CreateAppResult): Fetcher {
    const loaderId = `${this.name}-v${this.buildVersion}`;
    const worker = this.env.LOADER.get(loaderId, () => ({
      mainModule: result.mainModule,
      modules: result.modules,
      compatibilityDate:
        result.wranglerConfig?.compatibilityDate ?? "2026-01-28",
      compatibilityFlags: result.wranglerConfig?.compatibilityFlags
    }));

    const facets = (
      this.ctx as unknown as {
        facets: {
          get<T>(name: string, init: () => { class: unknown; id: string }): T;
        };
      }
    ).facets;

    return facets.get<Fetcher>("app", () => ({
      // @ts-expect-error experimental api
      class: worker.getDurableObjectClass("App"),
      id: "app"
    }));
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const result = await this.ensureAppBuilt();

      const storage = createMemoryStorage(result.assets);
      const assetResponse = await handleAssetRequest(
        request,
        result.assetManifest,
        storage,
        result.assetConfig
      );
      if (assetResponse) return assetResponse;

      const facet = this.getAppFacet(result);
      return await facet.fetch(request);
    } catch (e) {
      return new Response(e instanceof Error ? e.message : "No app built yet", {
        status: 500
      });
    }
  }

  @callable({
    description: "Send a request to the built app and return the response"
  })
  async testApp(
    method: string,
    path: string,
    body?: string,
    headers?: Record<string, string>
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const result = await this.ensureAppBuilt();

    const reqInit: RequestInit = { method };
    if (body && method !== "GET" && method !== "HEAD") {
      reqInit.body = body;
    }
    if (headers) {
      reqInit.headers = headers;
    }

    const request = new Request("http://playground" + path, reqInit);

    const storage = createMemoryStorage(result.assets);
    const assetResponse = await handleAssetRequest(
      request,
      result.assetManifest,
      storage,
      result.assetConfig
    );

    const response =
      assetResponse ?? (await this.getAppFacet(result).fetch(request));

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value: string, key: string) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body: await response.text()
    };
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
      system: [
        "You are a full-stack app generator for Cloudflare Workers with persistent storage.",
        "The user describes what they want and you generate a complete app with server code and static assets.",
        "When the user asks you to build something, use the generateApp tool to produce source files and assets.",
        "The tool will automatically bundle, serve assets, and load the app so the user can test it.",
        "",
        "Guidelines for generating apps:",
        "- Server code goes in source files (e.g. src/server.ts).",
        "- ALWAYS export a default class that extends DurableObject from 'cloudflare:workers'.",
        "- Use this.ctx.storage for persistent state (get/put/delete/list). State survives across requests and rebuilds.",
        "- Implement a fetch(request: Request) method on the class to handle HTTP requests.",
        "- Static assets (HTML, CSS, images) go in the assets object with pathname keys (e.g. /index.html).",
        "- Assets are served automatically with proper content types, ETags, and caching.",
        "- Unmatched routes fall through to your server code — perfect for APIs.",
        "- Use TypeScript (.ts files) for server code.",
        '- Put the server entry point at "src/server.ts".',
        '- If the user needs npm packages, include a "package.json" with dependencies.',
        "- Keep the code simple and focused on what the user asked for.",
        "- Use modern JS/TS syntax (async/await, template literals, etc.).",
        "",
        "Example: A counter app with HTML + persistent API",
        '  files: { "src/server.ts": [',
        "    \"import { DurableObject } from 'cloudflare:workers';\",",
        '    "export default class App extends DurableObject {",',
        '    "  async fetch(request: Request) {",',
        '    "    const url = new URL(request.url);",',
        "    \"    if (url.pathname === '/api/count') {\",",
        "    \"      const count = ((await this.ctx.storage.get('count')) as number) ?? 0;\",",
        "    \"      await this.ctx.storage.put('count', count + 1);\",",
        '    "      return Response.json({ count });",',
        '    "    }",',
        "    \"    return new Response('Not found', { status: 404 });\",",
        '    "  }",',
        '    "}"',
        "  ].join('\\n') }",
        '  assets: { "/index.html": "<!DOCTYPE html><h1>Counter</h1><script>fetch(\'/api/count\').then(r=>r.json()).then(d=>document.body.innerHTML+=d.count)</script>" }',
        "",
        "After generating, tell the user what you built and suggest they test it.",
        "If they ask to test it, use the testApp tool to send a request and show the response."
      ].join("\n"),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        generateApp: tool({
          description:
            "Generate a full-stack app with server code and static assets, bundle it, and load it. " +
            "Provide source files (with src/server.ts as the entry point) and optional static assets. " +
            "Assets are served automatically; unmatched routes fall through to the server.",
          inputSchema: z.object({
            files: z
              .record(z.string(), z.string())
              .describe(
                'Server source files, e.g. {"src/server.ts": "...", "package.json": "..."}'
              ),
            assets: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                'Static assets with pathname keys, e.g. {"/index.html": "<!DOCTYPE html>...", "/styles.css": "..."}'
              )
          }),
          execute: async ({ files, assets }) => this.buildApp(files, assets)
        }),
        testApp: tool({
          description:
            "Send an HTTP request to the currently loaded app and return the response.",
          inputSchema: z.object({
            method: z
              .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
              .describe("HTTP method"),
            path: z.string().describe("Request path, e.g. / or /api/greet"),
            body: z
              .string()
              .optional()
              .describe("Request body (for POST/PUT/PATCH)"),
            headers: z
              .record(z.string(), z.string())
              .optional()
              .describe("Request headers")
          }),
          execute: async ({ method, path, body, headers }) =>
            this.testApp(method, path, body, headers)
        })
      },
      stopWhen: stepCountIs(8)
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
    if (match) {
      const agentName = decodeURIComponent(match[1]);
      const previewPath = match[2] || "/";
      const previewPrefix = `/preview/${encodeURIComponent(agentName)}`;
      const id = env.WorkerPlayground.idFromName(agentName);
      const stub = env.WorkerPlayground.get(id);
      // Rewrite the URL so the loaded app sees the correct path
      const proxyUrl = new URL(previewPath, request.url);
      const response = await stub.fetch(new Request(proxyUrl, request));

      // Rewrite HTML so all absolute URLs route through the preview proxy
      // instead of hitting the playground's own SPA fallback.
      const ct = response.headers.get("Content-Type") || "";
      const nullBodyStatus = [101, 204, 205, 304].includes(response.status);
      if (ct.includes("text/html") && !nullBodyStatus) {
        let html = await response.text();

        // 1. Rewrite static attributes: href="/…", src="/…", action="/…"
        html = html.replace(
          /(href|src|action)=(["'])\/(?!\/|preview\/)/g,
          `$1=$2${previewPrefix}/`
        );

        // 2. Inject a script that patches fetch() and XMLHttpRequest so
        //    runtime JS calls like fetch("/api/counter") also go through
        //    the proxy.
        const patchScript =
          `<script>(function(){` +
          `var P=${JSON.stringify(previewPrefix)};` +
          `var _f=window.fetch;` +
          `window.fetch=function(i,o){` +
          `if(typeof i==="string"&&i.startsWith("/")&&!i.startsWith("//")&&!i.startsWith(P))` +
          `i=P+i;` +
          `else if(i instanceof Request){` +
          `var u=new URL(i.url);` +
          `if(u.origin===location.origin&&!u.pathname.startsWith(P))` +
          `i=new Request(P+u.pathname+u.search+u.hash,i);` +
          `}` +
          `return _f.call(this,i,o);` +
          `};` +
          `var _o=XMLHttpRequest.prototype.open;` +
          `XMLHttpRequest.prototype.open=function(m,u){` +
          `if(typeof u==="string"&&u.startsWith("/")&&!u.startsWith("//")&&!u.startsWith(P))` +
          `u=P+u;` +
          `return _o.apply(this,[m,u].concat([].slice.call(arguments,2)));` +
          `};` +
          `})()</script>`;

        // Inject right after <head> if present, otherwise prepend
        if (html.includes("<head>")) {
          html = html.replace("<head>", "<head>" + patchScript);
        } else if (html.includes("<head ")) {
          html = html.replace(/<head\s[^>]*>/, "$&" + patchScript);
        } else {
          html = patchScript + html;
        }

        const headers = new Headers(response.headers);
        return new Response(html, {
          status: response.status,
          headers
        });
      }

      return response;
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
