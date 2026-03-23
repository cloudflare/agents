# @cloudflare/worker-bundler

## 0.0.4

### Patch Changes

- [#1145](https://github.com/cloudflare/agents/pull/1145) [`94fac05`](https://github.com/cloudflare/agents/commit/94fac057c5f2ad9e668c4f3c38d4a4b52b102299) Thanks [@threepointone](https://github.com/threepointone)! - Separate assets from isolate: `createApp` now returns assets for host-side serving instead of embedding them in the dynamic isolate. Removes DO wrapper code generation and `durableObject` option — mounting is the caller's concern. Preview proxy replaced with Service Worker-based URL rewriting.

## 0.0.3

### Patch Changes

- [`8fd45cf`](https://github.com/cloudflare/agents/commit/8fd45cf81aaa7eee2b97eb6c4fc2b0b3ce7b8ffd) Thanks [@threepointone](https://github.com/threepointone)! - Initial publish (again)

## 0.0.2

### Patch Changes

- [`18c51ec`](https://github.com/cloudflare/agents/commit/18c51ec8968763396cec2fe6faadc8aa5b316abb) Thanks [@threepointone](https://github.com/threepointone)! - Initial publish
