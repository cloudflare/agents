---
"@cloudflare/codemode": patch
---

Fix grouping in TypeScript declarations generated from JSON Schema.

- Typed arrays now render as `Array<T>`, so union and intersection item types stay inside the array. Nullable string items produce `Array<string | null>` instead of `string | null[]`.
- A schema whose `type` is a list, such as `["array", "null"]` or `["object", "null"]`, now keeps its `items` and `properties`. It used to produce `unknown[] | null`, or drop `| null` from an object.
- Union members of an `allOf` are parenthesised: `(string | number) & Foo` instead of `string | number & Foo`.
- An empty `anyOf`, `oneOf`, `allOf` or `type` list no longer produces an empty type.
