# Context

The design record for `agents/context`, the module that decides what a model actually sees.

`agents/sessions` stores messages. `agents/context` turns a stored transcript plus a system prompt
into one model request. The two never merge: storage has no opinion about token budgets, and context
has no opinion about rows.

## What belongs here

| concern         | acts on                                                   | when                 | reversible                 |
| --------------- | --------------------------------------------------------- | -------------------- | -------------------------- |
| prompt assembly | labelled blocks rendered into a system prompt             | per turn             | yes                        |
| history shaping | truncation of old text and tool output, compaction policy | per turn             | yes                        |
| intake shaping  | what a tool result is allowed to contribute               | at the tool boundary | n/a, nothing is stored yet |

The first exists today as `ContextBlocks`. The second lives in `agents/chat` and
`agents/sessions` and should move here, since both read history and shape it before it reaches a
model, which is middleware over the session stream rather than anything host-specific.

The third does not exist and is the largest gap.

Retention is deliberately NOT here. Think's media eviction permanently rewrites stored history to
move bytes into its Workspace. That is a destructive storage policy that happens to buy context, and
it belongs with the host that owns the file store.

## Intake shaping

Everything we have shapes context _after_ the fact. A tool returns a 3 MB file, it lands in the
transcript, and later passes trim it, evict it, or summarize it. Pi does the opposite and caps at the
boundary, before anything is stored.

Measured against pi's own tools:

|                   | pi                                                        | Think today         |
| ----------------- | --------------------------------------------------------- | ------------------- |
| text read cap     | 2,000 lines or 50 KB, whichever first                     | 2,000 lines, 3.5 MB |
| over-cap behavior | truncate and tell the model `offset=N` to continue        | truncate the line   |
| images            | optional `imageProcessor`, `autoResizeImages` defaults on | none                |

Two differences matter. Pi's cap is roughly seventy times smaller, and pi hands back a _continuation
affordance_ rather than a dead end: the model knows exactly how to read the rest if it needs it,
which is what makes an aggressive cap safe. Think has no image path at all, so a full-resolution
screenshot enters context at whatever size the tool produced it.

The reason this belongs in `agents/context` rather than in each tool is that most tools are written
by users of the SDK. A guardrail that every tool author has to implement is a guardrail almost nobody
has. If the context layer wraps tool results on the way in, every host gets the behavior and a tool
author has to opt out rather than opt in.

Shape to aim for: a size budget applied to any tool result, truncation that always carries a
continuation hint, and an image step that downscales before the bytes become part of the request.
Defaults should be pi's, because they are the ones proven against real agent workloads.

## Open questions

- Does intake shaping run before or after the result is persisted? Before means the transcript never
  holds what the model never saw, which is simpler and smaller; after means a later policy change can
  still recover the full output. Storage is lossless either way, so this is a context decision.
- Interaction with prompt caching: a cap that trims at a _sliding_ boundary rewrites the prompt
  prefix on every turn. See the caching investigation before choosing where the boundary anchors.
