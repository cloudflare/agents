# @cloudflare/ai-chat

## 0.0.8

### Patch Changes

- [#882](https://github.com/cloudflare/agents/pull/882) [`584cebe`](https://github.com/cloudflare/agents/commit/584cebe882f437a685b96b26b15200dc50ba70e1) Thanks [@alexanderjacobsen](https://github.com/alexanderjacobsen)! - Fix multi-step client tool calling: pass stored client tool schemas to `onChatMessage` during tool continuations so the LLM can call additional client tools after auto-continuation. Also add a re-trigger mechanism to the client-side tool resolution effect to handle tool calls arriving during active resolution.

- [#891](https://github.com/cloudflare/agents/pull/891) [`0723b99`](https://github.com/cloudflare/agents/commit/0723b9909f037d494e0c7db43e031c952578c82e) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fix `getCurrentAgent()` returning `undefined` connection when used with `@cloudflare/ai-chat` and Vite SSR

  Re-export `agentContext` as `__DO_NOT_USE_WILL_BREAK__agentContext` from the main `agents` entry point and update `@cloudflare/ai-chat` to import it from `agents` instead of the `agents/internal_context` subpath export. This prevents Vite SSR pre-bundling from creating two separate `AsyncLocalStorage` instances, which caused `getCurrentAgent().connection` to be `undefined` inside `onChatMessage` and tool `execute` functions.

  The `agents/internal_context` subpath export has been removed from `package.json` and the deprecated `agentContext` alias has been removed from `internal_context.ts`. This was never a public API.

- [#886](https://github.com/cloudflare/agents/pull/886) [`4292f6b`](https://github.com/cloudflare/agents/commit/4292f6ba6d49201c88b09553452c3b243620f35b) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Forward custom body fields from client requests to `onChatMessage` options

  Custom data sent via `prepareSendMessagesRequest` or the AI SDK's `body` option in `sendMessage` is now available in the `onChatMessage` handler through `options.body`. This allows passing dynamic context (e.g., model selection, temperature, custom metadata) from the client to the server without workarounds.

## 0.0.7

### Patch Changes

- [#859](https://github.com/cloudflare/agents/pull/859) [`3de98a3`](https://github.com/cloudflare/agents/commit/3de98a398d55aeca51c7b845ed4c5d6051887d6d) Thanks [@threepointone](https://github.com/threepointone)! - broaden peer deps

- [#865](https://github.com/cloudflare/agents/pull/865) [`c3211d0`](https://github.com/cloudflare/agents/commit/c3211d0b0cc36aa294c15569ae650d3afeab9926) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.6

### Patch Changes

- [#829](https://github.com/cloudflare/agents/pull/829) [`83f137f`](https://github.com/cloudflare/agents/commit/83f137f7046aeafc3b480b5aa4518f6290b14406) Thanks [@Muhammad-Bin-Ali](https://github.com/Muhammad-Bin-Ali)! - Fix duplicate assistant messages when using needsApproval tools

  When calling `addToolApprovalResponse`, the original assistant message is now updated in place instead of creating a duplicate with a new ID.

- Updated dependencies [[`68916bf`](https://github.com/cloudflare/agents/commit/68916bfa08358d4bb5d61aff37acd8dc4ffc950e), [`3f490d0`](https://github.com/cloudflare/agents/commit/3f490d045844e4884db741afbb66ca1fe65d4093)]:
  - agents@0.3.10

## 0.0.5

### Patch Changes

- [#813](https://github.com/cloudflare/agents/pull/813) [`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#797](https://github.com/cloudflare/agents/pull/797) [`77be4f8`](https://github.com/cloudflare/agents/commit/77be4f8149e41730148a360adfff9e66becdd5ed) Thanks [@iTrooz](https://github.com/iTrooz)! - refactor(ai-chat): put SSE reply and plaintext reply logic into 2 separate functions

- [#800](https://github.com/cloudflare/agents/pull/800) [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#818](https://github.com/cloudflare/agents/pull/818) [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#795](https://github.com/cloudflare/agents/pull/795) [`99cbca0`](https://github.com/cloudflare/agents/commit/99cbca0847d0d6c97f44b73f2eb155dabe590032) Thanks [@Jerrynh770](https://github.com/Jerrynh770)! - Fix resumable streaming to avoid delivering live chunks before resume ACK

- Updated dependencies [[`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`d1a0c2b`](https://github.com/cloudflare/agents/commit/d1a0c2b73b1119d71e120091753a6bcca0e2faa9), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`fd79481`](https://github.com/cloudflare/agents/commit/fd7948180abf066fa3d27911a83ffb4c91b3f099), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`e20da53`](https://github.com/cloudflare/agents/commit/e20da5319eb46bac6ac580edf71836b00ac6f8bb), [`f604008`](https://github.com/cloudflare/agents/commit/f604008957f136241815909319a552bad6738b58), [`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db), [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e), [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`ded8d3e`](https://github.com/cloudflare/agents/commit/ded8d3e8aeba0358ebd4aecb5ba15344b5a21db1)]:
  - agents@0.3.7

## 0.0.4

### Patch Changes

- [#761](https://github.com/cloudflare/agents/pull/761) [`0e8fc1e`](https://github.com/cloudflare/agents/commit/0e8fc1e8cca3ad5acb51f5a0c92528c5b6beb358) Thanks [@iTrooz](https://github.com/iTrooz)! - Allow returning a non-streaming reponse from onChatMessage()

- [#771](https://github.com/cloudflare/agents/pull/771) [`87dc96d`](https://github.com/cloudflare/agents/commit/87dc96d19de1d26dbb2badecbb9955a4eb8e9e2e) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- Updated dependencies [[`cf8a1e7`](https://github.com/cloudflare/agents/commit/cf8a1e7a24ecaac62c2aefca7b0fd5bf1373e8bd), [`87dc96d`](https://github.com/cloudflare/agents/commit/87dc96d19de1d26dbb2badecbb9955a4eb8e9e2e)]:
  - agents@0.3.4

## 0.0.3

### Patch Changes

- [`a5d0137`](https://github.com/cloudflare/agents/commit/a5d01379b9ad2d88bc028c50f1858b4e69f106c5) Thanks [@threepointone](https://github.com/threepointone)! - trigger a new release

- Updated dependencies [[`a5d0137`](https://github.com/cloudflare/agents/commit/a5d01379b9ad2d88bc028c50f1858b4e69f106c5)]:
  - agents@0.3.3

## 0.0.2

### Patch Changes

- [#756](https://github.com/cloudflare/agents/pull/756) [`0c4275f`](https://github.com/cloudflare/agents/commit/0c4275f8f4b71c264c32c3742d151ef705739c2f) Thanks [@threepointone](https://github.com/threepointone)! - feat: split ai-chat and codemode into separate packages

  Extract @cloudflare/ai-chat and @cloudflare/codemode into their own packages
  with comprehensive READMEs. Update agents README to remove chat-specific
  content and point to new packages. Fix documentation imports to reflect
  new package structure.

  Maintains backward compatibility, no breaking changes.

- Updated dependencies [[`0c4275f`](https://github.com/cloudflare/agents/commit/0c4275f8f4b71c264c32c3742d151ef705739c2f), [`f12553f`](https://github.com/cloudflare/agents/commit/f12553f2fa65912c68d9a7620b9a11b70b8790a2)]:
  - agents@0.3.2
