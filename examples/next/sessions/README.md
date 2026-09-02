# Next: sessions

A server-only example of `Sessions` on a plain Durable Object. It demonstrates streamed history reads, branches, compaction overlays, and Sessions-owned file attachments.

Message JSON stays in Durable Object SQLite. Payloads at or above 32 KiB become content-addressed `attachment:sha256:` pointers: `data:` URL file parts, text and reasoning parts, and strings nested in tool outputs alike. Offload is lossless, so the default read reconstructs the original part byte for byte, and nothing is ever truncated to make a row fit.

Sessions stores payloads below 1,500,000 bytes in 1.5 MiB SQLite windows and streams larger payloads to R2, so small attachments avoid R2 requests while large images and PDFs stay out of message rows.

## Run

```sh
pnpm install
pnpm run dev
```

Exercise the named object `demo`:

```sh
# Append a root message.
curl -X POST http://localhost:8787/agents/session-object/demo/messages \
  -H 'content-type: application/json' \
  -d '{"id":"m1","role":"user","parts":[{"type":"text","text":"hello"}]}'

# Append a child. Omit parent to use the active leaf automatically.
curl -X POST 'http://localhost:8787/agents/session-object/demo/messages?parent=m1' \
  -H 'content-type: application/json' \
  -d '{"id":"m2","role":"assistant","parts":[{"type":"text","text":"hi"}]}'

# Stream the active path as newline-delimited JSON.
curl -N http://localhost:8787/agents/session-object/demo/history

# Read without loading attachment bytes.
curl -N 'http://localhost:8787/agents/session-object/demo/history?attachments=pointer'

# List children of m1.
curl http://localhost:8787/agents/session-object/demo/branches/m1

# Add a non-destructive compaction overlay.
curl -X POST http://localhost:8787/agents/session-object/demo/compactions \
  -H 'content-type: application/json' \
  -d '{"summary":"The user greeted the assistant.","fromMessageId":"m1","toMessageId":"m2"}'
```

A file part can contain a `data:` URL. Sessions writes the decoded bytes before committing the pointer row:

```json
{
  "id": "image-1",
  "role": "user",
  "parts": [
    { "type": "text", "text": "inspect this image" },
    {
      "type": "file",
      "mediaType": "image/png",
      "filename": "screen.png",
      "url": "data:image/png;base64,..."
    }
  ]
}
```

The append response contains `attachment:sha256:<hash>`. Fetch it without buffering through:

```sh
curl http://localhost:8787/agents/session-object/demo/attachments/<hash> --output screen.png
```

`history?attachments=pointer` is the memory-safe path for exports, reconciliation, and maintenance. The default history route reconstructs file parts as data URLs for consumers that require complete AI SDK messages.

For measured storage and latency numbers against a deployed worker with a real R2 bucket, see [`examples/next/sessions-slam`](../sessions-slam).
