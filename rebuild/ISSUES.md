# Issues

Lightweight local tracker for known gaps and deferred work surfaced while building
and domain-modeling the clean-room rebuild. Just enough to not lose the thread —
not a replacement for a real tracker. Resolve or delete entries as they're
addressed.

Use this for *gaps to fix later*. Decisions we're happy to stand behind go in
[`docs/adr/`](./docs/adr/) instead.

**Status:** `open` · `in-progress` · `resolved`

---

## ISSUE-001 — Reasoning is output-only; not replayable to providers that support it

**Status:** open · **Area:** Conversation + Infrastructure (`ModelMessage` port)

The `ModelMessage` port carries reasoning on the way *out* (`ModelChunk`
`reasoning-delta`) but has no reasoning variant on the way *in* — assistant
`content` is `text | tool-call` only. So `toModelMessages` drops reasoning, and no
adapter can resend it. This bakes a provider assumption — "no provider accepts
reasoning back" — into the domain contract, which is **false**: Anthropic
(interleaved thinking, signed) and OpenAI (reasoning items) replay reasoning in
multi-step tool flows.

Reasoning is still persisted on the `ChatMessage` and streamed to clients; only
*provider replay* is missing.

Correct handling (deferred):
- Add a reasoning variant to assistant `ModelMessage` content, carrying the
  provider's opaque/signed payload — not just display text (today's reasoning part
  is `{ type: "reasoning"; text }`, insufficient for faithful replay).
- Capture that payload at generation time.
- Move the drop/keep decision into the per-provider adapters (filter if
  unsupported) rather than dropping unconditionally in the domain.

Not an ADR: this is a gap to fix, not a decision to enshrine.

---

## ISSUE-002 — Channels hard-codes an implicit "web" channel

**Status:** resolved · **Area:** Channels (`src/domain/channels/`)

Dropped `IMPLICIT_WEB` and the `kind === "web"` special case. The transcript is now
the default delivery sink; `web` is just a normal (optional) channel; a channel with
no `deliver` hook falls back to the transcript (the uniform sub-choice, replacing the
old out-of-turn throw). Channels glossary DRAFT lifted.
