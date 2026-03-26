# Structured Input

An AI chat agent that presents interactive, structured input forms to the user — multiple choice, yes/no, free text, and rating scales — using client-side tools with no `execute` function.

## What this demonstrates

The LLM decides _which type of input_ to ask for based on conversation context, then calls a client-side tool that renders the appropriate UI component. The user interacts with the component, and the result is sent back to the model as the tool output.

This pattern is useful for:

- Guided onboarding and intake flows
- Interactive surveys and questionnaires
- Decision-making wizards
- Preference gathering
- Project requirement collection

### How it works

**Server** — Four tools are defined with schemas but no `execute` function:

```ts
const askMultipleChoice = tool({
  description: "Present the user with options to choose from",
  inputSchema: z.object({
    question: z.string(),
    options: z.array(z.string()).min(2),
    allowMultiple: z.boolean().default(false)
  })
  // No execute — the client handles this interactively
});
```

**Client** — Tool parts arrive in state `input-available`. The client renders an interactive component (radio buttons, checkboxes, text input, star rating) and calls `addToolOutput` when the user responds:

```tsx
if (
  part.type === "tool-askMultipleChoice" &&
  part.state === "input-available"
) {
  return (
    <MultipleChoiceInput
      question={part.input.question}
      options={part.input.options}
      onSubmit={(selected) =>
        addToolOutput({ toolCallId: part.toolCallId, output: selected })
      }
    />
  );
}
```

The model receives the selection as the tool result and continues the conversation.

## Running it

```bash
npm install
npm start
```

No API keys needed — uses Workers AI.

## Try these prompts

- "Help me plan a vacation"
- "Run a quick survey about my coffee preferences"
- "Help me pick a tech stack for my new project"
- "I want to rate some movies"

## Related examples

- [`ai-chat`](../ai-chat) — Tools, approval, and MCP integration
- [`human-in-the-loop` guide](../../guides/human-in-the-loop) — Tool execution approval pattern
