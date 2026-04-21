---
"@cloudflare/think": minor
---

Align `Think` generics with `Agent` / `AIChatAgent`.

`Think` is now `Think<Env, State, Props>` and extends `Agent<Env, State, Props>`, so subclasses get properly typed `this.state`, `this.setState()`, `initialState`, and `this.ctx.props`. The previous `Config` class generic is removed.

`configure()` and `getConfig()` remain, but the config type is now specified at the call site via a method-level generic:

```ts
// Before
export class MyAgent extends Think<Env, MyConfig> {
  getModel() {
    const tier = this.getConfig()?.modelTier ?? "fast";
    // ...
  }
}

// After
export class MyAgent extends Think<Env> {
  getModel() {
    const tier = this.getConfig<MyConfig>()?.modelTier ?? "fast";
    // ...
  }
}
```

This is a breaking change for anyone using the second type parameter of `Think`. Update the class declaration and any direct `configure(...)` / `getConfig()` call sites that relied on the class-level `Config` type.
