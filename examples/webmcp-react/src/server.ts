export default {
  fetch() {
    // Cloudflare serves the SPA before invoking this Worker. Only unmatched
    // requests reach this fallback.
    return Response.json({ error: "Not found" }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
