---
"@cloudflare/think": minor
---

Think's workspace tools are now the `@cloudflare/computer` tools: `read`, `ls`, `find`, `grep`, `write`, `edit`, and `delete`, plus `exec` when the Workspace has execution backends and `publish` when it has assets. Configure them with the new `workspaceTools` property, which takes `createAITools` options (`exec` backends and descriptions, `read`/`edit` limits, `readonly`), or `false` to omit them. Backends and the modules they offer are configured on the `Workspace`.

Every Think agent now has `__getWorkspaceStub()`, so `getWorkspace(stub)` and the Worker shell backend can reach its Workspace.

Breaking changes:

- `@cloudflare/think/tools/workspace`, `createWorkspaceTools`, and `workspaceBash` are removed. The `list` tool is now `ls`. The in-process `bash` tool is gone: add a backend to the Workspace to get `exec`.
- `just-bash` is no longer a dependency.
- Image and PDF reads stored by the old `read` tool replay as an error asking the model to read the file again, instead of being re-read from the workspace.
