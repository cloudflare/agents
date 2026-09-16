# Next: sessions

A server-only example of `Sessions` on a plain Durable Object. It demonstrates streamed history reads, branches, and compaction overlays.

Sessions stores MESSAGES; it is not a file store. Message JSON stays in Durable Object SQLite. A message whose serialized JSON exceeds the 1.5 MiB row budget is split across continuation rows and reassembled on read, so a round-trip is byte-exact, nothing is truncated, and no message is too large to store.

Continuation rows live in the same Durable Object as the message they belong to, so a Durable Object's 10 GB ceiling is the real bound on how much one conversation can hold, and Sessions imposes no per-message limit of its own. An application that handles files should keep them in a file store and put a reference in the message.

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

# Stream the path ending at a chosen leaf.
curl -N 'http://localhost:8787/agents/session-object/demo/history?leaf=m2'

# List children of m1.
curl http://localhost:8787/agents/session-object/demo/branches/m1

# Add a non-destructive compaction overlay.
curl -X POST http://localhost:8787/agents/session-object/demo/compactions \
  -H 'content-type: application/json' \
  -d '{"summary":"The user greeted the assistant.","fromMessageId":"m1","toMessageId":"m2"}'
```

A message can carry a file part with an inline `data:` URL. It rides in the message like any other content — split across continuation rows when it is large — and reads back byte for byte:

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

Read one message back by id:

```sh
curl http://localhost:8787/agents/session-object/demo/messages/image-1
```
