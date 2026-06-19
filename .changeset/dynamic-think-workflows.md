---
"@cloudflare/think": minor
---

Add dynamic workflow support via `@cloudflare/think/dynamic-workflows`.

New API:

- `Think.runDynamicWorkflow(workflowName, code, params?, options?)` — stores generated TypeScript and starts a Dynamic Workflow instance
- `Think._getWorkflowCode(wfId)` — internal RPC method used by the loader to retrieve stored code
- `DynamicThinkWorkflow` — export from `@cloudflare/think/dynamic-workflows`, register as `class_name` in your `[[workflows]]` wrangler binding

Generated code extending `ThinkWorkflow` is bundled at runtime with `@cloudflare/worker-bundler` and executed as a Dynamic Worker with full durable execution (`step.prompt()`, `step.do()`, `step.sleep()`, `step.waitForEvent()`).

New dependencies: `@cloudflare/dynamic-workflows` (runtime), `@cloudflare/worker-bundler` (optional peer dep).
