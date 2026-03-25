# @cloudflare/voice

## 0.0.4

### Patch Changes

- [#1198](https://github.com/cloudflare/agents/pull/1198) [`dde826e`](https://github.com/cloudflare/agents/commit/dde826ec78f1714d9156d964d720507e3a139d8e) Thanks [@threepointone](https://github.com/threepointone)! - Fix TypeScript 6 declaration emit for `withVoice` and `withVoiceInput` mixin functions. TS6 enforces TS4094 which disallows `#private` members in exported anonymous class types. Added explicit return type interfaces (`VoiceAgentMixinMembers`, `VoiceInputMixinMembers`) so the generated `.d.ts` only exposes the public API surface.

## 0.0.3

### Patch Changes

- [`8fd45cf`](https://github.com/cloudflare/agents/commit/8fd45cf81aaa7eee2b97eb6c4fc2b0b3ce7b8ffd) Thanks [@threepointone](https://github.com/threepointone)! - Initial publish (again)

## 0.0.2

### Patch Changes

- [`d384339`](https://github.com/cloudflare/agents/commit/d384339817cb724fd74dcfacf8194684ecefb81b) Thanks [@threepointone](https://github.com/threepointone)! - Initial publish
