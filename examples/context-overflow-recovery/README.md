# Context-Overflow Recovery

A [Think](../../packages/think) agent that recovers from **mid-turn context-window overflow** against a real Workers AI model, instead of letting the turn die.

## Run it

```bash
npm install
npm start
```

Then open the dev server and click **"Add background document"** 3+ times — each appends a large exchange to the stored history (no model turn). Now send a normal message: the assembled prompt exceeds the model's context window (`@cf/meta/llama-3.1-8b-instruct` is only ~8K tokens), so instead of failing, Think compacts the bulky history and answers anyway. Every recovery shows up in the **Compactions** panel.

> Why inflate via _history_ rather than the message you send? Recovery compacts the oldest messages and keeps the most recent. If the triggering message itself were huge, compaction couldn't shrink below it. Putting the bulk in history (and sending a small message) is the realistic shape — a long conversation or a big pasted document earlier in the thread.

No secrets required — it uses the Workers AI binding (`AI`), verified live against `@cf/meta/llama-3.1-8b-instruct`.

## The pattern

Recovery is opt-in and provider-agnostic. The agent configures both layers and tells Think which errors are overflows:

```ts
export class ContextOverflowAgent extends Think<Env> {
  // Proactive guard (compacts before a step when usage nears the budget) +
  // reactive backstop (compacts and retries if the provider still rejects).
  override contextOverflow = {
    reactive: true,
    proactive: { maxInputTokens: 8000 }
  };

  // Bundled classifier matches the common providers' context-window errors.
  override classifyChatError = defaultContextOverflowClassifier;

  // Recovery reuses your session's compaction strategy.
  override configureSession(session: Session): Session {
    return session.onCompaction(async (messages) => {
      const keep = 2;
      if (messages.length <= keep + 1) return null;
      const collapsed = messages.slice(0, messages.length - keep);
      return {
        summary: `[Summary] ${collapsed.length} earlier message(s) condensed to fit the window.`,
        fromMessageId: collapsed[0].id,
        toMessageId: collapsed[collapsed.length - 1].id
      };
    });
  }
}
```

Key points:

- **Both layers reuse `onCompaction`** — recovery is only as good as your compaction strategy. This one summarizes a _range_ of the oldest messages (dropping bulk), so the retry actually fits.
- **Tune `maxInputTokens`** to your model's window. The demo uses a small value so it trips quickly.
- A no-op compaction or a spent retry budget surfaces the overflow terminally through `onChatError` — recovery never loops or ends silently.

See the [Think context-overflow recovery docs](../../docs/think/index.md#context-window-overflow-recovery) for the full design.

## Related examples

- [`assistant`](../assistant) — full Think feature showcase
- [`agent-skills`](../agent-skills) — Think + Agent Skills
