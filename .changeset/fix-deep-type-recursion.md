---
"agents": patch
---

Fix TypeScript "excessively deep" error with deeply nested state types

Add a depth counter to `CanSerialize` and `IsSerializableParam` types that bails out to `true` after 10 levels of recursion. This prevents the "Type instantiation is excessively deep and possibly infinite" error when using deeply nested types like AI SDK `CoreMessage[]` as agent state.
