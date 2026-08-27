# @cloudflare/channels

## 0.1.0

### Minor Changes

- [#2129](https://github.com/cloudflare/agents/pull/2129) [`4890dc6`](https://github.com/cloudflare/agents/commit/4890dc69c2763a0eb04d4ed57281813820387ad8) Thanks [@cjol](https://github.com/cjol)! - Add the experimental `@cloudflare/channels` package: one transport-neutral way to receive and send messages over Slack, Telegram, email, and channels of your own.

  A stateless `ChannelHost` authenticates and normalizes provider input, and your application decides where each event belongs and how to store it. Outbound delivery reports honest per-attempt outcomes, approvals can be rendered natively by each provider, and channel identities can be linked to your own users.

### Patch Changes

- Updated dependencies [[`f08ee06`](https://github.com/cloudflare/agents/commit/f08ee06fd610756de0d8abf539dfe9b746bdd7c5)]:
  - @cloudflare/voice@0.4.0
