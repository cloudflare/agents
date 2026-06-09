---
name: test-plan
description: Produce a focused test plan for a change. Use when the user asks how to test a feature, what cases to cover, or for a QA checklist before shipping.
---

# Test Plan

Turn a change description into a short, prioritized test plan.

## Process

1. Restate what changed in one sentence.
2. Identify the riskiest behaviors first (data loss, auth, money, concurrency).
3. List concrete test cases as `given / when / then`, happy paths first, then
   edge cases and failure modes.
4. Note any setup, fixtures, or environment the cases need.
5. Call out what is explicitly out of scope so the plan stays focused.

## Output format

```md
## Risks

- Ranked list of the riskiest areas.

## Cases

1. given … / when … / then …

## Out of scope

- Anything intentionally not covered.
```

Keep the plan small enough to act on immediately. If the change is unclear, ask
for the acceptance criteria before listing cases.
