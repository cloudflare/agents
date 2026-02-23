# AGENTS.md — docs/

User-facing documentation for the Agents SDK. These markdown files are manually synced to [developers.cloudflare.com/agents/](https://developers.cloudflare.com/agents/).

## Diátaxis framework

We follow [Diátaxis](https://diataxis.fr/) to keep docs focused. Every doc should have a clear primary type:

| Type          | Purpose                  | Reader's need | Examples in this folder                                                                         |
| ------------- | ------------------------ | ------------- | ----------------------------------------------------------------------------------------------- |
| **Tutorial**  | "Follow along and learn" | Learning      | `getting-started.md`, `adding-to-existing-project.md`                                           |
| **How-to**    | "Solve a specific task"  | A goal        | `email.md`, `webhooks.md`, `human-in-the-loop.md`, `cross-domain-authentication.md`, migrations |
| **Reference** | "Look up the API"        | Information   | `agent-class.md`, `callable-methods.md`, `client-sdk.md`, `state.md`, `configuration.md`        |

The fourth Diátaxis type — **explanation** ("understand why") — lives in `/design`, not here. If you're writing about _why_ something was designed a certain way, put it there. If you're writing about _how to use_ something, it belongs here.

### Picking the right type

- **New API or feature?** Start with **reference** (signature, params, return types, behaviour) plus a concise example.
- **Multi-step workflow?** Write a **how-to** guide (goal-oriented steps, assumes the reader already understands the basics).
- **Onboarding flow?** Write a **tutorial** (learning-oriented, step-by-step, the reader follows along).
- **Don't hybridise** — a single doc can include a short example in a reference page, but if you're writing a 20-step walkthrough inside a reference doc, it should be a separate how-to.

## Upstream sync

There is no automated sync workflow. Changes here must be manually ported to `cloudflare/cloudflare-docs` (the `src/content/docs/agents/` folder). When updating docs here, also update the corresponding `.mdx` file in cloudflare-docs.

## Writing style

- Write for SDK users, not contributors — assume the reader is building something with the Agents SDK
- Be concrete: code snippets over prose, real examples over abstract descriptions
- No contractions (Cloudflare style guide requirement — "do not" not "don't")
- Use TypeScript for all code examples
- Link to related docs within this folder using relative paths (`./state.md`)

## Adding a new doc

1. Write the markdown file in this folder
2. Add it to `index.md` in the appropriate section
3. If it documents a design decision, consider whether a companion entry in `/design` is warranted

## TODO backlog

`index.md` has ~15 entries marked `TODO` — these are known gaps. When filling one, remove the TODO marker and follow the steps above.
