# AGENTS.md — design/

Internal design records — the "why" behind decisions in this repo and its libraries. This is the Diátaxis **explanation** quadrant: architecture rationale, tradeoffs, and alternatives considered.

## Two kinds of document

### Design docs

Living documents that describe how a concept or subsystem works **right now**. Named by topic: `state.md`, `mcp.md`, `visuals.md`. These are the primary entry point — a contributor looking for "how does state work" should open one file and get the full picture.

Design docs get updated as the implementation evolves. They always reflect the current reality.

### RFCs

Point-in-time decision records for significant changes. Named with an `rfc-` prefix: `rfc-state-v2-sync-protocol.md`. These capture why a specific change was made and what alternatives were considered. They do not get updated after the decision — they are snapshots.

RFCs are never deleted, even after rejection. Rejected RFCs are valuable — they prevent re-litigating the same idea later.

## Workflow

```
1. Propose:  write rfc-<name>.md (status: proposed)
2. Decide:   update status to accepted or rejected
3. Implement: update the relevant design doc to reflect the new reality
              (create one if it does not exist yet)
```

Step 3 is important — the design doc is what people read day-to-day. The RFC is the footnote explaining one particular decision within it.

A design doc may link to multiple RFCs that shaped it over time:

```markdown
## History

- [rfc-state-sync.md](./rfc-state-sync.md) — original bidirectional sync design
- [rfc-state-v2-batching.md](./rfc-state-v2-batching.md) — added batched updates
```

## RFC format

Include a status line at the top:

```
Status: proposed | accepted | rejected
```

Then cover:

- **The problem** — what we need to solve
- **The proposal** — what we want to do
- **The alternatives** — what else we considered and why not
- **The decision** — what was decided (filled in after discussion)

## Design doc format

No strict template. Each file should at minimum cover:

- **How it works** — the current design, kept up to date
- **Key decisions** — link to relevant RFCs for the reasoning
- **Tradeoffs** — what we gave up and why

Keep it concise. A few paragraphs is fine. These are records, not essays.

## What does not belong here

- **API reference or usage guides** — those go in `/docs` (see `/docs/AGENTS.md`)
- **Code comments** — keep inline explanations in the code itself
- **Changelogs** — those live in package `CHANGELOG.md` files

## Current contents

| File                      | Type       | Scope                                                                        |
| ------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `readonly-connections.md` | design doc | Readonly connections — enforcement, storage wrapping, caveats                |
| `retries.md`              | design doc | Retry system — primitives, integration points, backoff strategy, tradeoffs   |
| `visuals.md`              | design doc | UI component library (Kumo), dark mode, custom patterns, routing integration |

## Relationship to `/docs`

`/docs` is user-facing ("how to use the SDK"). `/design` is contributor-facing ("why the SDK works this way"). If a design decision affects how users interact with the SDK, distil the user-relevant parts into a doc in `/docs` and link back here for the full rationale.
