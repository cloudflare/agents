# React Compiler Demo

Demonstrates the behavioral difference when React Compiler (`babel-plugin-react-compiler`) is enabled vs disabled.

## How to run

```bash
npm install

# With React Compiler ON
npm start

# With React Compiler OFF
npm run start:no-compiler
```

## What to observe

The app has a parent component (`App`) with a counter button and a child component (`ExpensiveChild`) that tracks its own render count.

`App` creates a `{ theme: "light" }` object and passes it as a prop to `ExpensiveChild`. There is no `React.memo`, no `useMemo`, no `useCallback` — just plain components.

- **Compiler OFF**: Every click on the counter re-renders `ExpensiveChild` because `App` creates a new object reference each render, and React has no reason to skip the child.
- **Compiler ON**: `ExpensiveChild` render count stays at 1. The compiler auto-memoizes the static object and the child's JSX, so React skips re-rendering.

## Inspecting the compiled output

A custom Vite plugin dumps the transformed source of `client.tsx` on each run:

1. Run `npm start` — creates `compiled-output.js`
2. Run `npm run start:no-compiler` — creates `uncompiled-output.js`
3. Diff them:

```bash
diff compiled-output.js uncompiled-output.js
```

In the compiled output, look for:
- `import { c as _c } from "react/compiler-runtime"` — the compiler's runtime cache
- `const $ = _c(N)` — a cache array with N slots
- `if ($[0] === Symbol.for("react.memo_cache_sentinel"))` — cache-miss checks

You can also paste the component source into the [React Compiler Playground](https://playground.react.dev/) to see the transformation side-by-side.
