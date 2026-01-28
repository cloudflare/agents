# @cloudflare/ai-chat

## 0.0.5

### Patch Changes

- [#797](https://github.com/cloudflare/agents/pull/797) [`77be4f8`](https://github.com/cloudflare/agents/commit/77be4f8149e41730148a360adfff9e66becdd5ed) Thanks [@iTrooz](https://github.com/iTrooz)! - refactor(ai-chat): put SSE reply and plaintext reply logic into 2 separate functions

- [#800](https://github.com/cloudflare/agents/pull/800) [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#795](https://github.com/cloudflare/agents/pull/795) [`99cbca0`](https://github.com/cloudflare/agents/commit/99cbca0847d0d6c97f44b73f2eb155dabe590032) Thanks [@Jerrynh770](https://github.com/Jerrynh770)! - Fix resumable streaming to avoid delivering live chunks before resume ACK

- Updated dependencies [[`d1a0c2b`](https://github.com/cloudflare/agents/commit/d1a0c2b73b1119d71e120091753a6bcca0e2faa9), [`fd79481`](https://github.com/cloudflare/agents/commit/fd7948180abf066fa3d27911a83ffb4c91b3f099), [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e)]:
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
