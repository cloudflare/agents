# AGENTS.md

## Scope

Applies to everything under `wip/`.

## Purpose

`wip/` is for work-in-progress notes, implementation sketches, logs, and
temporary planning documents that are useful while a feature is actively
evolving.

This folder is intentionally different from:

- `design/` — design records and RFC-style documents that aim to capture
  stable decisions, alternatives, and architecture
- `docs/` — user-facing documentation

Use `wip/` when the right shape is still being discovered and we want a
running record without prematurely turning it into an RFC or polished design
doc.

## What belongs here

- feature worklogs
- migration notes
- implementation plans that may change quickly
- experiment notes from examples or prototypes
- punch lists and next-step breakdowns

## What should not go here

- finalized RFCs or design decisions that belong in `design/`
- user-facing docs that belong in `docs/`
- long-term product documentation

## Writing guidance

- Prefer clear narrative context over terse bullets. Someone opening a file
  here should be able to understand what is happening without reading the
  entire chat history.
- Include enough background to explain why the work exists now, what changed,
  and what still needs validation.
- Be explicit about what is decided, what is still experimental, and what
  should happen next.
- It is fine for plans here to be opinionated and provisional.
- Keep file names descriptive and feature-specific.

## Maintenance

- When a plan hardens into a real design decision, move or rewrite it into
  `design/`.
- When a worklog stops being useful, it can be deleted or folded into a more
  permanent document.
