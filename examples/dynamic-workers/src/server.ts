const DEFAULT_CODE = `export default {
  fetch() {
    return new Response("Hello from a dynamic Worker!");
  },
};`;

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/run" && request.method === "POST") {
      const body = await request.json<{ code?: string }>();
      const code = body.code?.trim() || DEFAULT_CODE;

      try {
        const worker = env.LOADER.load({
          compatibilityDate: "2026-01-28",
          mainModule: "worker.js",
          modules: {
            "worker.js": code
          },
          globalOutbound: null
        });

        const result = await worker
          .getEntrypoint()
          .fetch(new Request("https://worker/"));
        const text = await result.text();

        return Response.json({
          ok: true,
          status: result.status,
          output: text
        });
      } catch (err) {
        return Response.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          },
          { status: 400 }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
