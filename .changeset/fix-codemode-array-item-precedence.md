---
"@cloudflare/codemode": patch
---

Fix array item type grouping in generated TypeScript declarations.
Use `Array<T>` so union and intersection item types stay inside the array.
For example, nullable string items now produce `Array<string | null>` instead of `string | null[]`.
