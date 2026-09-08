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

The first exists today as `ContextBlocks`.

The second is deliberately deferred. It reads as middleware over the session stream, so on shape
alone it belongs here — but truncating old tool output slides the boundary a little further every
turn, and a sliding boundary rewrites the prompt prefix, which is precisely what invalidates a
cache. Moving it here before that is understood would relocate the problem into the module meant to
solve it. It stays in Think until the caching investigation settles where the boundary anchors.

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

Shape to aim for: a size budget applied to any tool result, and truncation that always carries a
continuation hint. Defaults should be pi's, because they are the ones proven against real agent
workloads. This is not built yet.

## Settled: before or after persist

The question was whether intake shaping runs before or after the result is stored. It splits, and
the two halves answer differently.

**Attachment extraction is lossless** — the bytes move to a content-addressed store and a read puts
them back exactly. So it runs before persist, in `agents/sessions`, on the write path, always on. A
host cannot forget to do it and nothing is given up by doing it early.

**Capping a tool result is lossy** — whatever is cut, the model cannot recover. So it runs on the
read path, here, and storage keeps the full result. A cap is then a policy that can change next
month without having destroyed anything, which is the same reason retention lives with hosts rather
than with the store.

Sessions stays lossless; context shapes. That line holds everywhere else in the design and it holds
here.

## Open questions

- Interaction with prompt caching: a cap that trims at a _sliding_ boundary rewrites the prompt
  prefix on every turn. See the caching investigation before choosing where the boundary anchors.
