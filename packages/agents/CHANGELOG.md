# @cloudflare/agents

## 0.2.13

### Patch Changes

- [#531](https://github.com/cloudflare/agents/pull/531) [`cdfc590`](https://github.com/cloudflare/agents/commit/cdfc590640bcc08da888d8707f923b926ca73225) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - update our cache key in useAgentChat to include agent name (fix for #420)

## 0.2.12

### Patch Changes

- [#559](https://github.com/cloudflare/agents/pull/559) [`3667584`](https://github.com/cloudflare/agents/commit/3667584792aba94aa47760160ef573af4a33a9a9) Thanks [@threepointone](https://github.com/threepointone)! - use lazy imports for ai sdk

## 0.2.11

### Patch Changes

- [#554](https://github.com/cloudflare/agents/pull/554) [`2cc0f02`](https://github.com/cloudflare/agents/commit/2cc0f020323f6e8e363002cebcc6516f7da75c01) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#554](https://github.com/cloudflare/agents/pull/554) [`2cc0f02`](https://github.com/cloudflare/agents/commit/2cc0f020323f6e8e363002cebcc6516f7da75c01) Thanks [@threepointone](https://github.com/threepointone)! - move to tsdown, slim down generated bundles

## 0.2.10

### Patch Changes

- [#550](https://github.com/cloudflare/agents/pull/550) [`336602f`](https://github.com/cloudflare/agents/commit/336602fe3b2eeb9933822b690c8626024da669dd) Thanks [@ainergiz](https://github.com/ainergiz)! - encode MCP message headers with Base64

- [#544](https://github.com/cloudflare/agents/pull/544) [`afd9efd`](https://github.com/cloudflare/agents/commit/afd9efd6da74a9e8f961aa55e87328c9b18fab12) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Startup time optimisations

## 0.2.9

### Patch Changes

- [#545](https://github.com/cloudflare/agents/pull/545) [`70499f1`](https://github.com/cloudflare/agents/commit/70499f1cb30d71af621ec6e16e5d43786559f75d) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Update mcp sdk

## 0.2.8

### Patch Changes

- [#527](https://github.com/cloudflare/agents/pull/527) [`b060233`](https://github.com/cloudflare/agents/commit/b060233cf16c80b4f5b2718afa6358aea8db45ae) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - remove isToolCallInProgress

- [#535](https://github.com/cloudflare/agents/pull/535) [`75865eb`](https://github.com/cloudflare/agents/commit/75865ebae6c1550aea3a130944df35de203a7ef9) Thanks [@threepointone](https://github.com/threepointone)! - move x402 to peerDependencies

- [#525](https://github.com/cloudflare/agents/pull/525) [`789141e`](https://github.com/cloudflare/agents/commit/789141efa79be3d20ac1c098ff1452da488a9f2d) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - use INSERT OR REPLACE for message persistence to allow tool call updates

- [#529](https://github.com/cloudflare/agents/pull/529) [`c41ebbc`](https://github.com/cloudflare/agents/commit/c41ebbcd148b5bab30883fea763401219e66bdcd) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - persist and stream reply in saveMessages

## 0.2.7

### Patch Changes

- [#521](https://github.com/cloudflare/agents/pull/521) [`1bd0c75`](https://github.com/cloudflare/agents/commit/1bd0c75f44bc164e16f81bd20c9c9bd6fe790898) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix OAuth state parameter security vulnerability by replacing client_id with secure random tokens

- [#524](https://github.com/cloudflare/agents/pull/524) [`06b2ab0`](https://github.com/cloudflare/agents/commit/06b2ab0b7fe1a981441a590ad8779e30a4f0e924) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.2.6

### Patch Changes

- [`b388447`](https://github.com/cloudflare/agents/commit/b3884475a7c3a268fe27fae2eb55f30c73cef4ab) Thanks [@threepointone](https://github.com/threepointone)! - fix: getAITools shouldn't include hyphens in tool names

## 0.2.5

### Patch Changes

- [`a90de5d`](https://github.com/cloudflare/agents/commit/a90de5d23d99246da8a1bef0bfa557316f75585f) Thanks [@threepointone](https://github.com/threepointone)! - codemode: remove stray logs, fix demo

## 0.2.4

### Patch Changes

- [`9a8fed7`](https://github.com/cloudflare/agents/commit/9a8fed774c263778bb51840e3b2d4891125ccaec) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.2.3

### Patch Changes

- [#458](https://github.com/cloudflare/agents/pull/458) [`d3e7a68`](https://github.com/cloudflare/agents/commit/d3e7a6853ca60bfbe998785ec63938e5b4d7fe90) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add unified async authentication support to useAgent hook
  The useAgent hook now automatically detects and handles both sync and async query patterns

- [#512](https://github.com/cloudflare/agents/pull/512) [`f9f03b4`](https://github.com/cloudflare/agents/commit/f9f03b447a6e48eb3fad1c22a91d46d5b147da4c) Thanks [@threepointone](https://github.com/threepointone)! - codemode: a tool that generates code to run your tools

- [#499](https://github.com/cloudflare/agents/pull/499) [`fb62d22`](https://github.com/cloudflare/agents/commit/fb62d2280fe2674bd4893e4e3d720fc7b3bb13a7) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - handle all message types in the reply streaming handler

- [#509](https://github.com/cloudflare/agents/pull/509) [`71def6b`](https://github.com/cloudflare/agents/commit/71def6b8b9bfc75ed0b6e905bc204a78de63c772) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix OAuth authentication for MCP servers and add transport configuration
  - Fix authorization codes being consumed during transport fallback
  - Add transport type option to addMcpServer() for explicit control
  - Add configurable OAuth callback handling (redirects, custom responses)
  - Fix callback URL persistence across Durable Object hibernation

## 0.2.2

### Patch Changes

- [#504](https://github.com/cloudflare/agents/pull/504) [`da56baa`](https://github.com/cloudflare/agents/commit/da56baa831781ee1f31026daabf2f79c51e3c897) Thanks [@threepointone](https://github.com/threepointone)! - fix attribution

## 0.2.1

### Patch Changes

- [`5969a16`](https://github.com/cloudflare/agents/commit/5969a162b89eb7a8506e63b5a829a2df7ccae77e) Thanks [@threepointone](https://github.com/threepointone)! - trigger a release

## 0.2.0

### Minor Changes

- [#495](https://github.com/cloudflare/agents/pull/495) [`ff9329f`](https://github.com/cloudflare/agents/commit/ff9329f4fbcdcf770eeaaa0c9d2adb27e72bb0f6) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix OAuth callback handling and add HOST auto-detection
  - Fix OAuth callback "Not found" errors by removing MCPClientManager
    override
  - Add OAuth callback URL persistence across Durable Object hibernation
  - Fix OAuth connection reuse during reconnect to prevent state loss
  - Add OAuth transport tracking to prevent authorization code consumption
    during auto-fallback
  - Preserve PKCE verifier across transport attempts
  - Make callbackHost parameter optional with automatic request-based
    detection
  - Add URL normalization for consistent transport endpoint handling

### Patch Changes

- [#465](https://github.com/cloudflare/agents/pull/465) [`6db2cd6`](https://github.com/cloudflare/agents/commit/6db2cd6f1497705f8636b1761a2db364d49d4861) Thanks [@BeiXiao](https://github.com/BeiXiao)! - fix(ai-react): prevent stale agent capture in aiFetch; ensure active connection is used

- [#440](https://github.com/cloudflare/agents/pull/440) [`9ef35e2`](https://github.com/cloudflare/agents/commit/9ef35e218e711b7ba6d7f40d20573944ae68b44a) Thanks [@axuj](https://github.com/axuj)! - fix: pass agent.\_pk as id to useChat to prevent stale WebSocket instances

## 0.1.6

### Patch Changes

- [#492](https://github.com/cloudflare/agents/pull/492) [`00ba881`](https://github.com/cloudflare/agents/commit/00ba88115d62b608564e783faac18754dc8a79cc) Thanks [@threepointone](https://github.com/threepointone)! - fix: this.mcp.getAITools now includes outputSchema

- [#494](https://github.com/cloudflare/agents/pull/494) [`ecbd795`](https://github.com/cloudflare/agents/commit/ecbd7950dd0656e27ca3fcd8cdf69aa7292ec5ba) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.1.5

### Patch Changes

- [#478](https://github.com/cloudflare/agents/pull/478) [`8234d41`](https://github.com/cloudflare/agents/commit/8234d413538add212738d4e9436ace3d0fd222d1) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Refactor streamable HTTP transport

- [#486](https://github.com/cloudflare/agents/pull/486) [`4abd78a`](https://github.com/cloudflare/agents/commit/4abd78af111d297fc1a3a7763728ca36b14a0a29) Thanks [@threepointone](https://github.com/threepointone)! - fix: don't context wrap methods on Agents that have already been wrapped

- [#480](https://github.com/cloudflare/agents/pull/480) [`23db655`](https://github.com/cloudflare/agents/commit/23db65588effe698a77cc9514857dd9611def927) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Update mcp tools and client for x402 support

## 0.1.4

### Patch Changes

- [#470](https://github.com/cloudflare/agents/pull/470) [`28013ba`](https://github.com/cloudflare/agents/commit/28013ba700f6c2c0ce09dd3406f6da95569d68bf) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Store initialize requests and set them in onStart

- [#467](https://github.com/cloudflare/agents/pull/467) [`b8eba58`](https://github.com/cloudflare/agents/commit/b8eba582af89cc119ff15f155636fe7ba05d8534) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Silently handle writer close errors

- [`bfc9c75`](https://github.com/cloudflare/agents/commit/bfc9c75bbe8be4f078051cab9a4b95d3cab73ffc) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add response metadata

- [#469](https://github.com/cloudflare/agents/pull/469) [`fac1fe8`](https://github.com/cloudflare/agents/commit/fac1fe879892711b6e91760c45780fcbfc56f602) Thanks [@umgefahren](https://github.com/umgefahren)! - Include reasoning parts in finalized and persistet message.

- [#472](https://github.com/cloudflare/agents/pull/472) [`2d0d2e1`](https://github.com/cloudflare/agents/commit/2d0d2e1e1a0883bd71c6e250da5f007a2dce0229) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - use header for session ids in streamable http GET streams

- [`7d9b939`](https://github.com/cloudflare/agents/commit/7d9b9398e982737b4caa7f99c3a521e36df4961d) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.1.3

### Patch Changes

- [#459](https://github.com/cloudflare/agents/pull/459) [`0ffa9eb`](https://github.com/cloudflare/agents/commit/0ffa9ebeb9a03eae86d167c0624c19858600dd5c) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - update mcp sdk

## 0.1.2

### Patch Changes

- [#415](https://github.com/cloudflare/agents/pull/415) [`f7bd395`](https://github.com/cloudflare/agents/commit/f7bd3959a49ac732baaa2ee9a92cd5544fa0ec29) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Make McpAgent extend Agent + Streaming HTTP protocol features

## 0.1.1

### Patch Changes

- [#451](https://github.com/cloudflare/agents/pull/451) [`9beccdd`](https://github.com/cloudflare/agents/commit/9beccdd7cb4299222eaed72b79278986ef256a73) Thanks [@threepointone](https://github.com/threepointone)! - udpate dependencies

- [#447](https://github.com/cloudflare/agents/pull/447) [`3e523ea`](https://github.com/cloudflare/agents/commit/3e523ea3ed249416b8a464756086bcf3056edd6d) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add support for plain text responses alongside SSE streaming

## 0.1.0

### Minor Changes

- [#391](https://github.com/cloudflare/agents/pull/391) [`ecf8926`](https://github.com/cloudflare/agents/commit/ecf89262da1acc3874bb9aec9effc3be3c1c5a87) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - update to ai sdk v5

### Patch Changes

- [#445](https://github.com/cloudflare/agents/pull/445) [`14616d3`](https://github.com/cloudflare/agents/commit/14616d3254df1c292730d09a69846d5cffbb1590) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Fix MCP client to treat `client_uri` as a valid URL

- [#410](https://github.com/cloudflare/agents/pull/410) [`25b261e`](https://github.com/cloudflare/agents/commit/25b261e6d7ac2e5cb1b1b7df7dcc9fdef84e9931) Thanks [@amorriscode](https://github.com/amorriscode)! - docs: minor fixes

- [`2684ade`](https://github.com/cloudflare/agents/commit/2684adeb3f545c9c48d23e3a004050efe94735ce) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [`01b919d`](https://github.com/cloudflare/agents/commit/01b919db6ab6bb0fd3895e1f6c7c2fdb0905bca2) Thanks [@threepointone](https://github.com/threepointone)! - remove unstable\_ prefixes with deprecation warnings

  This deprecates all unstable\_ prefixes with deprecation warnings. Specifically:
  - unstable_callable -> callable
  - unstable_getAITools -> getAITools
  - unstable_getSchedulePrompt -> getSchedulePrompt
  - unstable_scheduleSchema -> scheduleSchema

  Using the unstable\_ prefixed versions will now emit a deprecation warning. In the next major version, the unstable\_ prefixed versions will be removed.

- [#434](https://github.com/cloudflare/agents/pull/434) [`f0c6dce`](https://github.com/cloudflare/agents/commit/f0c6dceea9eaf4a682d3b0f3ecdbedcf3cc93c19) Thanks [@threepointone](https://github.com/threepointone)! - don't autowrap getters on an agent

- [#446](https://github.com/cloudflare/agents/pull/446) [`696d33e`](https://github.com/cloudflare/agents/commit/696d33e5fcc0821317276b6b18231818f5c54772) Thanks [@Flouse](https://github.com/Flouse)! - fix: use Object.getOwnPropertyDescriptor for property check

- [`1e4188c`](https://github.com/cloudflare/agents/commit/1e4188cb1256bd920ed9dcdb224a7437ac415506) Thanks [@threepointone](https://github.com/threepointone)! - update workers-ai-provider

- [#436](https://github.com/cloudflare/agents/pull/436) [`8dac62c`](https://github.com/cloudflare/agents/commit/8dac62c6f6c513d7fd481eb3b519b533bac17f1f) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Fix onConnect race condition

- [#409](https://github.com/cloudflare/agents/pull/409) [`352d62c`](https://github.com/cloudflare/agents/commit/352d62c6383797512be112ff3efcb462c0e44395) Thanks [@MrgSub](https://github.com/MrgSub)! - Refactor message types to use enum in AIChatAgent and related files

- [#442](https://github.com/cloudflare/agents/pull/442) [`0dace6e`](https://github.com/cloudflare/agents/commit/0dace6e34cb32a018f0122c036e87d6c7f47d318) Thanks [@threepointone](https://github.com/threepointone)! - fix: don't wrap a method with an agent context if it's already wrapped

## 0.0.113

### Patch Changes

- [`fd59ae2`](https://github.com/cloudflare/agents/commit/fd59ae225019ed8f3b20aa23f853d70d6d36b5db) Thanks [@threepointone](https://github.com/threepointone)! - fix: prefix mcp tool names with tool\_

## 0.0.112

### Patch Changes

- [#404](https://github.com/cloudflare/agents/pull/404) [`2a6e66e`](https://github.com/cloudflare/agents/commit/2a6e66e9e54e14e00a06c87065980bdeefd85369) Thanks [@threepointone](https://github.com/threepointone)! - udpate dependencies

- [#404](https://github.com/cloudflare/agents/pull/404) [`2a6e66e`](https://github.com/cloudflare/agents/commit/2a6e66e9e54e14e00a06c87065980bdeefd85369) Thanks [@threepointone](https://github.com/threepointone)! - log less data

  as part of our observability impl, we were logging way too much data, making it a probable data leak, but also blowing past the max size limit on o11y messages. This reduces the amount of data logged.

## 0.0.111

### Patch Changes

- [`0cf8e80`](https://github.com/cloudflare/agents/commit/0cf8e802b29fed4d83d7ff2c55fdfb72a1fa5a0f) Thanks [@threepointone](https://github.com/threepointone)! - trigegr a release

## 0.0.110

### Patch Changes

- [#392](https://github.com/cloudflare/agents/pull/392) [`669a2b0`](https://github.com/cloudflare/agents/commit/669a2b0d75844495da7fcefed2127d5bd820c551) Thanks [@Maximo-Guk](https://github.com/Maximo-Guk)! - fix: Ensure McpAgent props stay current

- [#394](https://github.com/cloudflare/agents/pull/394) [`e4a2352`](https://github.com/cloudflare/agents/commit/e4a2352b04a588f3e593ebe8bbf78df9cb2ecff8) Thanks [@threepointone](https://github.com/threepointone)! - update state incrementally as mcp servers connect

- [#390](https://github.com/cloudflare/agents/pull/390) [`b123357`](https://github.com/cloudflare/agents/commit/b123357202884e2610cbcdb5857e38b94944fca9) Thanks [@threepointone](https://github.com/threepointone)! - update (most) dependencies

- [#376](https://github.com/cloudflare/agents/pull/376) [`1eac06e`](https://github.com/cloudflare/agents/commit/1eac06e1f3ad61a91227ef54351521435762182d) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add elicitation support and examples

- [`3bcb134`](https://github.com/cloudflare/agents/commit/3bcb134710d6e7db7830281e29c91c504e6841b9) Thanks [@threepointone](https://github.com/threepointone)! - update partysocket

- [#374](https://github.com/cloudflare/agents/pull/374) [`b63b4a6`](https://github.com/cloudflare/agents/commit/b63b4a6740a8d437109a138d7bea64615afdc1c6) Thanks [@laulauland](https://github.com/laulauland)! - Improve MCP client connection resilience with Promise.allSettled

- [#378](https://github.com/cloudflare/agents/pull/378) [`c69f616`](https://github.com/cloudflare/agents/commit/c69f616c15db81c09916cbd68eb6d07abe023a0b) Thanks [@amorriscode](https://github.com/amorriscode)! - add auto transport option

- [#387](https://github.com/cloudflare/agents/pull/387) [`8c2713f`](https://github.com/cloudflare/agents/commit/8c2713f59f5ba04af7ae06e2f6c28f6fcf6d6d37) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix/mcp agent error handling

## 0.0.109

### Patch Changes

- [#372](https://github.com/cloudflare/agents/pull/372) [`a45f8f3`](https://github.com/cloudflare/agents/commit/a45f8f3cd8f4f392d585cc13c721570e263094d7) Thanks [@threepointone](https://github.com/threepointone)! - default Agent's Env to cloudflare's Env

## 0.0.108

### Patch Changes

- [#357](https://github.com/cloudflare/agents/pull/357) [`40bd73c`](https://github.com/cloudflare/agents/commit/40bd73cbb29e5fc4a2625ce7d895b9e8c70d76a3) Thanks [@davemurphysf](https://github.com/davemurphysf)! - Pass incoming headers to the DO fetch method

## 0.0.107

### Patch Changes

- [#364](https://github.com/cloudflare/agents/pull/364) [`885b3db`](https://github.com/cloudflare/agents/commit/885b3db8af3f482b2892764077c05afc491f0b35) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add HTTP Streamable support

## 0.0.106

### Patch Changes

- [#359](https://github.com/cloudflare/agents/pull/359) [`14bb798`](https://github.com/cloudflare/agents/commit/14bb798a1f79ef4052a9134dc5f5a4baee042812) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix email routing to be case-insensitive for agent names

## 0.0.105

### Patch Changes

- [#354](https://github.com/cloudflare/agents/pull/354) [`f31397c`](https://github.com/cloudflare/agents/commit/f31397cb7f8b67fc736faece51364edeaf52e5a0) Thanks [@jahands](https://github.com/jahands)! - fix: dequeue items in DB after each task is complete

  Prevents a single failure from causing all items in the queue from being retried (including previously processed items that were successful).

## 0.0.104

### Patch Changes

- [#319](https://github.com/cloudflare/agents/pull/319) [`e48e5f9`](https://github.com/cloudflare/agents/commit/e48e5f928030e3cc8d8a73cfa8783354be0b7648) Thanks [@threepointone](https://github.com/threepointone)! - add lightweight .queue

- [#352](https://github.com/cloudflare/agents/pull/352) [`0bb74b8`](https://github.com/cloudflare/agents/commit/0bb74b89db99c7c31a1b7a9a35e0f2aa9814962d) Thanks [@threepointone](https://github.com/threepointone)! - email adaptor

- [#345](https://github.com/cloudflare/agents/pull/345) [`c5e3a32`](https://github.com/cloudflare/agents/commit/c5e3a324b16c75ace2b48a5842a2755546db4539) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add automatic context wrapping for custom Agent methods

## 0.0.103

### Patch Changes

- [#350](https://github.com/cloudflare/agents/pull/350) [`70ed631`](https://github.com/cloudflare/agents/commit/70ed6317bc50d32115f39119133fea5f154cde94) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix TypeScript types resolution by reordering export conditions

## 0.0.102

### Patch Changes

- [#238](https://github.com/cloudflare/agents/pull/238) [`dc7a99c`](https://github.com/cloudflare/agents/commit/dc7a99ca3cc60a8be069bb1094c6dd15bd2555f2) Thanks [@zebp](https://github.com/zebp)! - Basic observability instrumentation

## 0.0.101

### Patch Changes

- [#339](https://github.com/cloudflare/agents/pull/339) [`22d140b`](https://github.com/cloudflare/agents/commit/22d140b360365ac51ed9ebdad2beab6bc7095c9e) Thanks [@threepointone](https://github.com/threepointone)! - udpate dependencies

## 0.0.100

### Patch Changes

- [#331](https://github.com/cloudflare/agents/pull/331) [`7acfd65`](https://github.com/cloudflare/agents/commit/7acfd654bc1773c975fd8f61111c76e83c132fe5) Thanks [@geelen](https://github.com/geelen)! - Adding a new MCP header to the CORS allowlist to follow the updated spec

## 0.0.99

### Patch Changes

- [#332](https://github.com/cloudflare/agents/pull/332) [`75614c2`](https://github.com/cloudflare/agents/commit/75614c2532ab3e9f95e4a45e6e5b4a62be33a846) Thanks [@mchockal](https://github.com/mchockal)! - MCP connect / reconnect refactor

## 0.0.98

### Patch Changes

- [`b4ebb44`](https://github.com/cloudflare/agents/commit/b4ebb44196ff423e06beb347bb0e7b16f08773b4) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.97

### Patch Changes

- [`efffe3e`](https://github.com/cloudflare/agents/commit/efffe3e2e42a7cf3d97f05122cfd5ffc3ab1ad64) Thanks [@threepointone](https://github.com/threepointone)! - trigger release

## 0.0.96

### Patch Changes

- [#325](https://github.com/cloudflare/agents/pull/325) [`7e0777b`](https://github.com/cloudflare/agents/commit/7e0777b12624cb6903053976742a33ef54ba65d7) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.95

### Patch Changes

- [#316](https://github.com/cloudflare/agents/pull/316) [`7856b4d`](https://github.com/cloudflare/agents/commit/7856b4d90afbd3faf59f2d264b59f878648153dd) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add fallback message when agent returns no response

## 0.0.94

### Patch Changes

- [`9c6b2d7`](https://github.com/cloudflare/agents/commit/9c6b2d7c79ff91c1d73279608fa55568f8b91a5a) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#311](https://github.com/cloudflare/agents/pull/311) [`8a4558c`](https://github.com/cloudflare/agents/commit/8a4558cd9f95c1194f3d696bcb23050c3db7d257) Thanks [@threepointone](https://github.com/threepointone)! - Added a call to `this.ctx.abort('destroyed')` in the `destroy` method to ensure the agent is properly evicted during cleanup.

## 0.0.93

### Patch Changes

- [#302](https://github.com/cloudflare/agents/pull/302) [`b57e1d9`](https://github.com/cloudflare/agents/commit/b57e1d918d02607dcb68e1ca55790b6362964090) Thanks [@cmsparks](https://github.com/cmsparks)! - Fix an error where MCP servers pending connection would trigger an error

## 0.0.92

### Patch Changes

- [#299](https://github.com/cloudflare/agents/pull/299) [`eeb70e2`](https://github.com/cloudflare/agents/commit/eeb70e256594d688bb291fd49d96faa6839e4d8a) Thanks [@courtney-sims](https://github.com/courtney-sims)! - Prevent auth url from being regenerated during oauth flow

## 0.0.91

### Patch Changes

- [`7972da4`](https://github.com/cloudflare/agents/commit/7972da40a639611f253c4b4e27d18d4ff3c5a5e2) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.90

### Patch Changes

- [#295](https://github.com/cloudflare/agents/pull/295) [`cac66b8`](https://github.com/cloudflare/agents/commit/cac66b824c6dbfeb81623eed18c0e0d13db6d363) Thanks [@threepointone](https://github.com/threepointone)! - duck typing DurableObjectNamespace type

## 0.0.89

### Patch Changes

- [`87b44ab`](https://github.com/cloudflare/agents/commit/87b44ab1e277d691181eabcebde878bedc30bc2d) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#292](https://github.com/cloudflare/agents/pull/292) [`aacf837`](https://github.com/cloudflare/agents/commit/aacf8375ccafad2b3004ee8dca2077e589eccfe7) Thanks [@cmsparks](https://github.com/cmsparks)! - Fix issue where stray MCP connection state is left after closing connection

## 0.0.88

### Patch Changes

- [#289](https://github.com/cloudflare/agents/pull/289) [`86cae6f`](https://github.com/cloudflare/agents/commit/86cae6f7d2190c6b2442bdc2682f75a504f39ae8) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Type-safe serializable RPC methods

- [#287](https://github.com/cloudflare/agents/pull/287) [`94d9a2e`](https://github.com/cloudflare/agents/commit/94d9a2e362fe10764c85327d700ee4c90a0f957e) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Improve agent types

## 0.0.87

### Patch Changes

- [#283](https://github.com/cloudflare/agents/pull/283) [`041b40f`](https://github.com/cloudflare/agents/commit/041b40f7022af097288cc3a29c1b421cde434bb9) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Improve Agent stub

## 0.0.86

### Patch Changes

- [#274](https://github.com/cloudflare/agents/pull/274) [`93ccdbd`](https://github.com/cloudflare/agents/commit/93ccdbd254c083dad9f24f34b524006ce02572ed) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Stub for Agent RPC

## 0.0.85

### Patch Changes

- [#273](https://github.com/cloudflare/agents/pull/273) [`d1f6c02`](https://github.com/cloudflare/agents/commit/d1f6c02fb425ab3f699da77693f70ad3f05652a0) Thanks [@cmsparks](https://github.com/cmsparks)! - Expose getMcpServerState internally in agent

- [#276](https://github.com/cloudflare/agents/pull/276) [`b275dea`](https://github.com/cloudflare/agents/commit/b275dea97ebb96f2a103ee34d8c53d32a02ae5c0) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Fix non-optional parameters after undefined ones

- [#279](https://github.com/cloudflare/agents/pull/279) [`2801d35`](https://github.com/cloudflare/agents/commit/2801d35ff03fb41c75904fe96690766457e6b307) Thanks [@threepointone](https://github.com/threepointone)! - rename getMcpServerState/getMcpServers

## 0.0.84

### Patch Changes

- [#269](https://github.com/cloudflare/agents/pull/269) [`0ac89c6`](https://github.com/cloudflare/agents/commit/0ac89c62b8e829e28034a9eae91d08fc280b93b9) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Add type support to react useAgent().call

## 0.0.83

### Patch Changes

- [#270](https://github.com/cloudflare/agents/pull/270) [`d6a4eda`](https://github.com/cloudflare/agents/commit/d6a4eda221bc36fd9f1bb13f5240697e153ce619) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.82

### Patch Changes

- [`04d925e`](https://github.com/cloudflare/agents/commit/04d925ee6795b907de19bcd40940062fb9e99b1b) Thanks [@threepointone](https://github.com/threepointone)! - convert two missed #methods to a private \_methods

## 0.0.81

### Patch Changes

- [#265](https://github.com/cloudflare/agents/pull/265) [`ac0e999`](https://github.com/cloudflare/agents/commit/ac0e999652919600f087f0314ce61c98d3eaf069) Thanks [@threepointone](https://github.com/threepointone)! - refactor #method/#property to private method/private property

- [#267](https://github.com/cloudflare/agents/pull/267) [`385f0b2`](https://github.com/cloudflare/agents/commit/385f0b29c716f8fa1c9719b0c68e5c830767953e) Thanks [@threepointone](https://github.com/threepointone)! - prefix private methods/properties with \_

## 0.0.80

### Patch Changes

- [#254](https://github.com/cloudflare/agents/pull/254) [`25aeaf2`](https://github.com/cloudflare/agents/commit/25aeaf24692bb82601c5df9fdce215cf2c509711) Thanks [@cmsparks](https://github.com/cmsparks)! - Move MCP lifecycle+auth handling into the Agents class

## 0.0.79

### Patch Changes

- [#261](https://github.com/cloudflare/agents/pull/261) [`881f11e`](https://github.com/cloudflare/agents/commit/881f11ec71d539c0bc53fd754662a40c9b9dc090) Thanks [@geelen](https://github.com/geelen)! - update dependencies

- [#253](https://github.com/cloudflare/agents/pull/253) [`8ebc079`](https://github.com/cloudflare/agents/commit/8ebc07945d9c282bc0b6bfd5c41f69380a82f7e6) Thanks [@adesege](https://github.com/adesege)! - fix: allow overriding fetch and request headers in SSEEdgeClientTransport

- [#260](https://github.com/cloudflare/agents/pull/260) [`ca44ae8`](https://github.com/cloudflare/agents/commit/ca44ae8257eac71170540221ddd7bf88ff8756a1) Thanks [@nickfujita](https://github.com/nickfujita)! - Update Agent.alarm to readonly, linking to schedule-task docs

- [#261](https://github.com/cloudflare/agents/pull/261) [`881f11e`](https://github.com/cloudflare/agents/commit/881f11ec71d539c0bc53fd754662a40c9b9dc090) Thanks [@geelen](https://github.com/geelen)! - Adding `mcp-session-id` to McpAgents' CORS headers to permit web-based MCP clients

## 0.0.78

### Patch Changes

- [#258](https://github.com/cloudflare/agents/pull/258) [`eede2bd`](https://github.com/cloudflare/agents/commit/eede2bd61532abeb403417dbbfe1f8e6424b39dc) Thanks [@threepointone](https://github.com/threepointone)! - wrap onRequest so getCurrentAgent works

  Fixes https://github.com/cloudflare/agents/issues/256

## 0.0.77

### Patch Changes

- [#249](https://github.com/cloudflare/agents/pull/249) [`c18c28a`](https://github.com/cloudflare/agents/commit/c18c28a253be85e582a71172e074eb97884894e9) Thanks [@dexxiez](https://github.com/dexxiez)! - chore: add top level default types to package.json

- [#246](https://github.com/cloudflare/agents/pull/246) [`c4d53d7`](https://github.com/cloudflare/agents/commit/c4d53d786da3adf67a658b8a343909ce0f3fb70d) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Ensure we are passing ctx.props to McpAgent for the Streamable transport

- [#251](https://github.com/cloudflare/agents/pull/251) [`96a8138`](https://github.com/cloudflare/agents/commit/96a81383f6b48be0cc854b8cc72f33317824721c) Thanks [@brettimus](https://github.com/brettimus)! - Ensure isLoading is false after you `stop` an ongoing chat agent request

## 0.0.76

### Patch Changes

- [#242](https://github.com/cloudflare/agents/pull/242) [`c8f53b8`](https://github.com/cloudflare/agents/commit/c8f53b860b40a27f5d2ccfe119b37945454e6576) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#240](https://github.com/cloudflare/agents/pull/240) [`9ff62ed`](https://github.com/cloudflare/agents/commit/9ff62ed03a08837845056adb054b3cb3fda71405) Thanks [@threepointone](https://github.com/threepointone)! - mcp: Log when an error is caught inside onSSEMcpMessage

- [#239](https://github.com/cloudflare/agents/pull/239) [`7bd597a`](https://github.com/cloudflare/agents/commit/7bd597ad453a704bca98204ca2de5dc610808fcf) Thanks [@sushichan044](https://github.com/sushichan044)! - fix(types): explicitly annotate this with void to avoid unbound method warning

## 0.0.75

### Patch Changes

- [`6c24007`](https://github.com/cloudflare/agents/commit/6c240075fb435642407f3a8751a12f3c8df53b6c) Thanks [@threepointone](https://github.com/threepointone)! - Revert "fool typescript into thinking agent will always be defined in ge…

## 0.0.74

### Patch Changes

- [`ad0054b`](https://github.com/cloudflare/agents/commit/ad0054be3b6beffcf77dff616b02a3ab1e60bbb5) Thanks [@threepointone](https://github.com/threepointone)! - fool typescript into thinking agent will always be defined in getCurrentAgent()

## 0.0.73

### Patch Changes

- [#231](https://github.com/cloudflare/agents/pull/231) [`ba99b7c`](https://github.com/cloudflare/agents/commit/ba99b7c789df990ca82191fbd174402dbce79b42) Thanks [@threepointone](https://github.com/threepointone)! - update deps to pick up a potential fix for onStart not firing

## 0.0.72

### Patch Changes

- [`a25eb55`](https://github.com/cloudflare/agents/commit/a25eb55790f8be7b47d4aabac91e167c49ac18a4) Thanks [@threepointone](https://github.com/threepointone)! - don't throw if no current agent

## 0.0.71

### Patch Changes

- [#228](https://github.com/cloudflare/agents/pull/228) [`f973b54`](https://github.com/cloudflare/agents/commit/f973b540fc2b5fdd1a4a7a0d473bb26c785fa2c3) Thanks [@threepointone](https://github.com/threepointone)! - mcp client: fix tool name generation

## 0.0.70

### Patch Changes

- [#226](https://github.com/cloudflare/agents/pull/226) [`5b7f03e`](https://github.com/cloudflare/agents/commit/5b7f03e6126498da25b4e84f83569c06f76b4cbd) Thanks [@threepointone](https://github.com/threepointone)! - mcp client: closeConnection(id) and closeAllConnections()

## 0.0.69

### Patch Changes

- [#224](https://github.com/cloudflare/agents/pull/224) [`b342dcf`](https://github.com/cloudflare/agents/commit/b342dcfcce1192935d83585312b777cd96c33e71) Thanks [@threepointone](https://github.com/threepointone)! - getCurrentAgent()

## 0.0.68

### Patch Changes

- [#222](https://github.com/cloudflare/agents/pull/222) [`44dc3a4`](https://github.com/cloudflare/agents/commit/44dc3a428a7026650c60af95aff64e5b12c76b04) Thanks [@threepointone](https://github.com/threepointone)! - prepend mcp tool names with server id, use nanoid everywhere

- [#221](https://github.com/cloudflare/agents/pull/221) [`f59e6a2`](https://github.com/cloudflare/agents/commit/f59e6a222fffe1422340b43ccab33c2db5251f0b) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Support server as promises in McpAgent

## 0.0.67

### Patch Changes

- [#219](https://github.com/cloudflare/agents/pull/219) [`aa5f972`](https://github.com/cloudflare/agents/commit/aa5f972ee2942107addafd45d6163ae56579f862) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Fix type error for McpAgent.serve and McpAgent.serveSSE

## 0.0.66

### Patch Changes

- [#215](https://github.com/cloudflare/agents/pull/215) [`be4b7a3`](https://github.com/cloudflare/agents/commit/be4b7a38e7f462cfeed2da0812f0782b23767b9d) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [`843745d`](https://github.com/cloudflare/agents/commit/843745dfd5cec77463aa00021d841c2ed1abf51d) Thanks [@threepointone](https://github.com/threepointone)! - Thanks @brettimus for #105: Propagate cancellation signals from useAgentChat to ChatAgent

- [#217](https://github.com/cloudflare/agents/pull/217) [`8d8216c`](https://github.com/cloudflare/agents/commit/8d8216c1e233fabf779994578da6447f1d20cf2b) Thanks [@threepointone](https://github.com/threepointone)! - Add .mcp to the Agent class, and add a helper to McpClientManager to convert tools to work with AI SDK

- [#212](https://github.com/cloudflare/agents/pull/212) [`5342ce4`](https://github.com/cloudflare/agents/commit/5342ce4f67485b2199eed6f4cd6027330964c60f) Thanks [@pbteja1998](https://github.com/pbteja1998)! - do not remove search params and hash from mcp endpoint message

## 0.0.65

### Patch Changes

- [#205](https://github.com/cloudflare/agents/pull/205) [`3f532ba`](https://github.com/cloudflare/agents/commit/3f532bafda1a24ab6a2e8872302093bbc5b51b61) Thanks [@threepointone](https://github.com/threepointone)! - Let .server on McpAgent be a Server or McpServer

- [#208](https://github.com/cloudflare/agents/pull/208) [`85d8edd`](https://github.com/cloudflare/agents/commit/85d8eddc7ab62499cc27100adcd0894be0c8c974) Thanks [@a-type](https://github.com/a-type)! - Fix: resolved a problem in useAgentChat where initial messages would be refetched on re-render when using React StrictMode

## 0.0.64

### Patch Changes

- [#206](https://github.com/cloudflare/agents/pull/206) [`0c4b61c`](https://github.com/cloudflare/agents/commit/0c4b61cc78d6520523eed23a41b0b851ac763753) Thanks [@threepointone](https://github.com/threepointone)! - mcp client: result schema and options are optional

## 0.0.63

### Patch Changes

- [#202](https://github.com/cloudflare/agents/pull/202) [`1e060d3`](https://github.com/cloudflare/agents/commit/1e060d361d1b49aef3717f9d760d521577c06ff9) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - await stream writer calls in websocket handlers

- [#199](https://github.com/cloudflare/agents/pull/199) [`717b21f`](https://github.com/cloudflare/agents/commit/717b21f7763362c8c1321e9befb037dc6664f433) Thanks [@pauldraper](https://github.com/pauldraper)! - Add missing dependencies to agents

- [#203](https://github.com/cloudflare/agents/pull/203) [`f5b5854`](https://github.com/cloudflare/agents/commit/f5b5854aee4f3487974f4ac6452c1064181c1809) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Jmorrell/fix streamable hibernation issue

- [#186](https://github.com/cloudflare/agents/pull/186) [`90db5ba`](https://github.com/cloudflare/agents/commit/90db5ba878b48ad831ba889d0dff475268971943) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Rename McpAgent.mount to McpAgent.serveSSE with McpAgent.mount serving as an alias for backward compatibility

- [#186](https://github.com/cloudflare/agents/pull/186) [`90db5ba`](https://github.com/cloudflare/agents/commit/90db5ba878b48ad831ba889d0dff475268971943) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Update dependencies

## 0.0.62

### Patch Changes

- [#197](https://github.com/cloudflare/agents/pull/197) [`b30ffda`](https://github.com/cloudflare/agents/commit/b30ffda6d7bfd11f5346310c8cdb0f369f505560) Thanks [@threepointone](https://github.com/threepointone)! - fix websocket missing message trigger

## 0.0.61

### Patch Changes

- [#196](https://github.com/cloudflare/agents/pull/196) [`ba5a5fe`](https://github.com/cloudflare/agents/commit/ba5a5fedae6b8ea6e83a3116ea115f5a9465ef0a) Thanks [@threepointone](https://github.com/threepointone)! - expose persistMessages on AIChatAgent

- [#126](https://github.com/cloudflare/agents/pull/126) [`1bfd6a7`](https://github.com/cloudflare/agents/commit/1bfd6a77f2c2019b54f40f5a72ff7e4b4df57157) Thanks [@nickfujita](https://github.com/nickfujita)! - Add ai-types to esm exports

## 0.0.60

### Patch Changes

- [#173](https://github.com/cloudflare/agents/pull/173) [`49fb428`](https://github.com/cloudflare/agents/commit/49fb4282870c77ab9f3ab2a4ae49b7b60cabbfb2) Thanks [@cmsparks](https://github.com/cmsparks)! - fix: require authProvider on client connect and handle client "Method not found" initialization errors

## 0.0.59

### Patch Changes

- [#168](https://github.com/cloudflare/agents/pull/168) [`2781f7d`](https://github.com/cloudflare/agents/commit/2781f7d7275bfada743c6c5531aab42db5e675a7) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.58

### Patch Changes

- [`33b22fe`](https://github.com/cloudflare/agents/commit/33b22fe146bb8b721b4d33c607a044ea64c0706a) Thanks [@threepointone](https://github.com/threepointone)! - don't import WorkflowEntrypoint

  fixes https://github.com/cloudflare/agents/issues/166

## 0.0.57

### Patch Changes

- [#163](https://github.com/cloudflare/agents/pull/163) [`956c772`](https://github.com/cloudflare/agents/commit/956c772712962dfeef21d2b7ab6740600b308596) Thanks [@brishin](https://github.com/brishin)! - Fix: Missing agent dep in useCallback

- [#164](https://github.com/cloudflare/agents/pull/164) [`3824fd4`](https://github.com/cloudflare/agents/commit/3824fd4dfdd99c80cba5ea031e950a460d495256) Thanks [@threepointone](https://github.com/threepointone)! - revert https://github.com/cloudflare/agents/pull/161

## 0.0.56

### Patch Changes

- [#161](https://github.com/cloudflare/agents/pull/161) [`1f6598e`](https://github.com/cloudflare/agents/commit/1f6598eda2d6c4528797870fe74529e41142ff96) Thanks [@threepointone](https://github.com/threepointone)! - mcp: remove duplicate agent init, await root .init()

## 0.0.55

### Patch Changes

- [#159](https://github.com/cloudflare/agents/pull/159) [`b8377c1`](https://github.com/cloudflare/agents/commit/b8377c1efcd00fa2719676edc9e8d2ef02a20a23) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Fix issues with McpAgent and setState introduced by hibernation changes

## 0.0.54

### Patch Changes

- [#140](https://github.com/cloudflare/agents/pull/140) [`2f5cb3a`](https://github.com/cloudflare/agents/commit/2f5cb3ac4a9fbb9dc79b137b74336681f60be5a0) Thanks [@cmsparks](https://github.com/cmsparks)! - Remote MCP Client with auth support

  This PR adds:
  - Support for authentication for MCP Clients (Via a DO based auth provider)
  - Some improvements to the client API per #135
  - A more in depth example of MCP Client, which allows you to add any number of remote MCP servers with or without auth

## 0.0.53

### Patch Changes

- [#149](https://github.com/cloudflare/agents/pull/149) [`49e8b36`](https://github.com/cloudflare/agents/commit/49e8b362d77a68f2e891f655b9971b737e394f9e) Thanks [@irvinebroque](https://github.com/irvinebroque)! - Automatically change "/" path to "/\*" in MCP server mount() method

## 0.0.52

### Patch Changes

- [#151](https://github.com/cloudflare/agents/pull/151) [`e376805`](https://github.com/cloudflare/agents/commit/e376805ccd88b08e853b1894cc703e6f67f2ed1d) Thanks [@threepointone](https://github.com/threepointone)! - useAgent: don't throw when `query` is an async url provider

## 0.0.51

### Patch Changes

- [#146](https://github.com/cloudflare/agents/pull/146) [`316f98c`](https://github.com/cloudflare/agents/commit/316f98c3f70792f6daa86d3e92f8a466b5509bb5) Thanks [@threepointone](https://github.com/threepointone)! - remove lowercase warning for agent names

## 0.0.50

### Patch Changes

- [#142](https://github.com/cloudflare/agents/pull/142) [`1461795`](https://github.com/cloudflare/agents/commit/146179598b05945ee07e95261e6a83979c9a07d9) Thanks [@threepointone](https://github.com/threepointone)! - ai-chat-agent: pass query params correctly in /get-messages

## 0.0.49

### Patch Changes

- [#138](https://github.com/cloudflare/agents/pull/138) [`3bbbf81`](https://github.com/cloudflare/agents/commit/3bbbf812bbe3d1a2c3252e88a0ca49c7127b4820) Thanks [@geelen](https://github.com/geelen)! - Fixed internal build issue that caused incomplete package to be published

## 0.0.48

### Patch Changes

- [#125](https://github.com/cloudflare/agents/pull/125) [`62d4e85`](https://github.com/cloudflare/agents/commit/62d4e854e76204737c8b3bd7392934f37abeb3ca) Thanks [@cmsparks](https://github.com/cmsparks)! - MCP Client x Agents Implementation

- [#128](https://github.com/cloudflare/agents/pull/128) [`df716f2`](https://github.com/cloudflare/agents/commit/df716f2911acfc0e7461d3698f8e1b06947ea38b) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - MCP: Hibernate-able transport

- [#137](https://github.com/cloudflare/agents/pull/137) [`c3e8618`](https://github.com/cloudflare/agents/commit/c3e8618fbe64565e3bf039331a445c12945bf9ed) Thanks [@threepointone](https://github.com/threepointone)! - convert input `agent` in clients to kebab-case as expected by the server

## 0.0.47

### Patch Changes

- [#133](https://github.com/cloudflare/agents/pull/133) [`6dc3b6a`](https://github.com/cloudflare/agents/commit/6dc3b6aa2b4137f0a3022932d2038def9e03f5d2) Thanks [@threepointone](https://github.com/threepointone)! - remove description as an arg from getSchedules

- [#130](https://github.com/cloudflare/agents/pull/130) [`7ff0509`](https://github.com/cloudflare/agents/commit/7ff050994c223bbd1cb390e3a085b31023c2554f) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.46

### Patch Changes

- [`7c40201`](https://github.com/cloudflare/agents/commit/7c402012fa43c606e5455a13604ef7a6369989ed) Thanks [@threepointone](https://github.com/threepointone)! - mark context as unstable\_

## 0.0.45

### Patch Changes

- [#122](https://github.com/cloudflare/agents/pull/122) [`d045755`](https://github.com/cloudflare/agents/commit/d045755a3f465481531ca7556317c0a0be811438) Thanks [@threepointone](https://github.com/threepointone)! - `import {context} from 'agents';`

  Export the current agent, request, and connection from a shared context. Particularly useful for tool calls that might not have access to the current agent in their module scope.

## 0.0.44

### Patch Changes

- [#118](https://github.com/cloudflare/agents/pull/118) [`6e66bd4`](https://github.com/cloudflare/agents/commit/6e66bd4471d1eef10043297208033bd172898f10) Thanks [@max-stytch](https://github.com/max-stytch)! - fix: Pass Env param thru to DurableObject definition

- [#121](https://github.com/cloudflare/agents/pull/121) [`82d5412`](https://github.com/cloudflare/agents/commit/82d54121a6fa8c035a1e2d6b036165eae0624899) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.43

### Patch Changes

- [#111](https://github.com/cloudflare/agents/pull/111) [`eb6827a`](https://github.com/cloudflare/agents/commit/eb6827a8b97b3ce5f7e06afbe83a01201350d26a) Thanks [@threepointone](https://github.com/threepointone)! - update deps

  replace the beta release of partysocket with a real one

## 0.0.42

### Patch Changes

- [#107](https://github.com/cloudflare/agents/pull/107) [`4f3dfc7`](https://github.com/cloudflare/agents/commit/4f3dfc710797697aedaa29cef64923533a2cb071) Thanks [@threepointone](https://github.com/threepointone)! - update deps, allow sub/path/prefix, AND_BINDINGS_LIKE_THIS

  of note,
  - the partyserver update now allows for prefixes that/have/sub/paths
  - bindings THAT_LOOK_LIKE_THIS are correctly converted to kebabcase now

## 0.0.41

### Patch Changes

- [#106](https://github.com/cloudflare/agents/pull/106) [`1d1b74c`](https://github.com/cloudflare/agents/commit/1d1b74ce9f4a5f5fc698da280da71c08f0a7c7ce) Thanks [@geelen](https://github.com/geelen)! - Adding the first iteration of McpAgent

- [#103](https://github.com/cloudflare/agents/pull/103) [`9be8008`](https://github.com/cloudflare/agents/commit/9be80083a80a89c1b106599bda28d4a8aa7292f2) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.40

### Patch Changes

- [#100](https://github.com/cloudflare/agents/pull/100) [`ee727ca`](https://github.com/cloudflare/agents/commit/ee727caf52071221fbf79fd651f37ce12185bdae) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Pass state generic through `useAgentChat`

## 0.0.39

### Patch Changes

- [#96](https://github.com/cloudflare/agents/pull/96) [`d7d2876`](https://github.com/cloudflare/agents/commit/d7d287608fcdf78a4c914ee0590ea4ef8e81623f) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.38

### Patch Changes

- [#94](https://github.com/cloudflare/agents/pull/94) [`fb4d0a6`](https://github.com/cloudflare/agents/commit/fb4d0a6a564824a7faba02d7a181ae4b170ba820) Thanks [@threepointone](https://github.com/threepointone)! - better error handling (based on #65 by @elithrar)
  - implement `this.onError` for custom error handling
  - log errors from more places
  - catch some missed async errors and log them
  - mark some methods as actually private

## 0.0.37

### Patch Changes

- [#92](https://github.com/cloudflare/agents/pull/92) [`fbaa8f7`](https://github.com/cloudflare/agents/commit/fbaa8f799d1c666aba57b38bfc342580f19be70e) Thanks [@threepointone](https://github.com/threepointone)! - Renamed agents-sdk -> agents

## 0.0.36

### Patch Changes

- [#74](https://github.com/cloudflare/agents/pull/74) [`7bcdd83`](https://github.com/cloudflare/agents/commit/7bcdd8396d6789b1fc7323be465fbd61311c5181) Thanks [@gingerhendrix](https://github.com/gingerhendrix)! - Replace discriminatedUnion with simple object for Gemini models

## 0.0.35

### Patch Changes

- [#88](https://github.com/cloudflare/agents/pull/88) [`7532166`](https://github.com/cloudflare/agents/commit/7532166ecfc2bcf4f169907d0dd9c399336212ac) Thanks [@threepointone](https://github.com/threepointone)! - pass `cors:true` to `routeAgentRequest` to automatically use across domains

## 0.0.34

### Patch Changes

- [`39197ab`](https://github.com/cloudflare/agents/commit/39197ab65a08784b4d5851d5844cb5287c43040e) Thanks [@threepointone](https://github.com/threepointone)! - remove `cf_agent_chat_init` message

## 0.0.33

### Patch Changes

- [#85](https://github.com/cloudflare/agents/pull/85) [`acbc34e`](https://github.com/cloudflare/agents/commit/acbc34e0122835fbeae3a18b88932cc1b0a1802d) Thanks [@threepointone](https://github.com/threepointone)! - Add RPC support with `unstable_callable` decorator for method exposure. This feature enables:
  - Remote procedure calls from clients to agents
  - Method decoration with `@unstable_callable` to expose agent methods
  - Support for both regular and streaming RPC calls
  - Type-safe RPC calls with automatic response handling
  - Real-time streaming responses for long-running operations

  Note: The `callable` decorator has been renamed to `unstable_callable` to indicate its experimental status.

## 0.0.32

### Patch Changes

- [#83](https://github.com/cloudflare/agents/pull/83) [`a9248c7`](https://github.com/cloudflare/agents/commit/a9248c74c3b7af2a0085d15f02712c243e870cc3) Thanks [@threepointone](https://github.com/threepointone)! - add state sync to the regular agent client

  fixes https://github.com/cloudflare/agents/issues/9

## 0.0.31

### Patch Changes

- [`2c077c7`](https://github.com/cloudflare/agents/commit/2c077c7e800d20679afe23a37b6bbbec87ed53ac) Thanks [@threepointone](https://github.com/threepointone)! - warn if agent/name passed to client isn't in lowercase

## 0.0.30

### Patch Changes

- [`db70ceb`](https://github.com/cloudflare/agents/commit/db70ceb22e8d27717ca13cbdcf9d6364a792d1ab) Thanks [@threepointone](https://github.com/threepointone)! - fix async/await error for useAgentChat

## 0.0.29

### Patch Changes

- [#79](https://github.com/cloudflare/agents/pull/79) [`1dad549`](https://github.com/cloudflare/agents/commit/1dad5492fbf7e07af76da83767b48af56c503763) Thanks [@threepointone](https://github.com/threepointone)! - clear initial message cache on unmount, add getInitialMessages

  This clears the initial messages cache whenever useAgentChat is unmounted. Additionally, it adds a getInitialMessages option to pass your own custom method for setting initial messages. Setting getInitialMessages:null disables any fetch for initial messages, so that the user can populate initialMessages by themselves if they'd like.

  I also added a chat example to the playground.

## 0.0.28

### Patch Changes

- [`8ade3af`](https://github.com/cloudflare/agents/commit/8ade3af36d1b18636adfeb2491805e1368fba9d7) Thanks [@threepointone](https://github.com/threepointone)! - export Schedule type

- [#77](https://github.com/cloudflare/agents/pull/77) [`82f277d`](https://github.com/cloudflare/agents/commit/82f277d118b925af822e147240aa9918a5f3851e) Thanks [@threepointone](https://github.com/threepointone)! - pass credentials to get-messages call

## 0.0.27

### Patch Changes

- [`5b96c8a`](https://github.com/cloudflare/agents/commit/5b96c8a2cb26c683b34d41783eaced74216092e1) Thanks [@threepointone](https://github.com/threepointone)! - unstable\_ scheduling prompt helper shouldn't take input text

## 0.0.26

### Patch Changes

- [`06c4386`](https://github.com/cloudflare/agents/commit/06c438620873068499d757fb9fcef11c48c0e558) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#62](https://github.com/cloudflare/agents/pull/62) [`2d680f3`](https://github.com/cloudflare/agents/commit/2d680f3cccc200afdfe456e9432b645247fbce9a) Thanks [@threepointone](https://github.com/threepointone)! - unstable\_ scheduling helpers

- [`48ff237`](https://github.com/cloudflare/agents/commit/48ff2376087c71e6e7316c85c86e7e0559d57222) Thanks [@threepointone](https://github.com/threepointone)! - (for @sam-goodwin, #58) fix: pass headers to /get-messages

## 0.0.25

### Patch Changes

- [#53](https://github.com/cloudflare/agents/pull/53) [`877d551`](https://github.com/cloudflare/agents/commit/877d55169a49a767b703e39e0032a4df6681709f) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - fix onMessage not getting called

## 0.0.24

### Patch Changes

- [#51](https://github.com/cloudflare/agents/pull/51) [`b244068`](https://github.com/cloudflare/agents/commit/b244068c7266f048493b3796393cfa74bbbd9ec1) Thanks [@elithrar](https://github.com/elithrar)! - Fixes a bug with JSON parsing and the React state hooks.

## 0.0.23

### Patch Changes

- [#46](https://github.com/cloudflare/agents/pull/46) [`6efb950`](https://github.com/cloudflare/agents/commit/6efb9502612189f4a6f06435fc908e65af65eb88) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#49](https://github.com/cloudflare/agents/pull/49) [`653ebad`](https://github.com/cloudflare/agents/commit/653ebadcfd49b57595a6ecb010467d3810742b93) Thanks [@threepointone](https://github.com/threepointone)! - add linting, fix a bunch of bugs.

## 0.0.22

### Patch Changes

- [#39](https://github.com/cloudflare/agents/pull/39) [`2afea20`](https://github.com/cloudflare/agents/commit/2afea2023d96204fbe6829c400c7a22baedbad2f) Thanks [@elithrar](https://github.com/elithrar)! - adds JSDoc to public symbols.

## 0.0.21

### Patch Changes

- [#37](https://github.com/cloudflare/agents/pull/37) [`ff0679f`](https://github.com/cloudflare/agents/commit/ff0679f638d377c8629a1fd2762c58045ec397b5) Thanks [@threepointone](https://github.com/threepointone)! - `Agent::initialState`

  You can now set an initial state for an agent

  ```ts
  type State = {
    counter: number;
    text: string;
    color: string;
  };

  class MyAgent extends Agent<Env, State> {
    initialState = {
      counter: 0,
      text: "",
      color: "#3B82F6"
    };

    doSomething() {
      console.log(this.state); // {counter: 0, text: "", color: "#3B82F6"}, if you haven't set the state yet
    }
  }
  ```

  As before, this gets synced to useAgent, so you can do:

  ```ts
  const [state, setState] = useState<State>();
  const agent = useAgent<State>({
    agent: "my-agent",
    onStateUpdate: (state) => {
      setState(state);
    }
  });
  ```

## 0.0.20

### Patch Changes

- [#32](https://github.com/cloudflare/agents/pull/32) [`3d4e0f9`](https://github.com/cloudflare/agents/commit/3d4e0f9db69303dd2f93de37b4f54fefacb18a33) Thanks [@Cherry](https://github.com/Cherry)! - fix: add repo/bug tracker links to packages

## 0.0.19

### Patch Changes

- [`9938444`](https://github.com/cloudflare/agents/commit/9938444b0d8d1b4910fc50647ed223a22af564a4) Thanks [@threepointone](https://github.com/threepointone)! - scheduling: do a typecheck/throw error if not a valid method on this

## 0.0.18

### Patch Changes

- [`7149fd2`](https://github.com/cloudflare/agents/commit/7149fd27371cd13ae9814bb52f777c6ffc99af62) Thanks [@threepointone](https://github.com/threepointone)! - don't log when state updates on the server

## 0.0.17

### Patch Changes

- [`54962fe`](https://github.com/cloudflare/agents/commit/54962fe37c09be752fb8d713827337986ad6343a) Thanks [@threepointone](https://github.com/threepointone)! - trigger a release

## 0.0.16

### Patch Changes

- [`d798d99`](https://github.com/cloudflare/agents/commit/d798d9959030337dce50602ab3fbd23586379e69) Thanks [@threepointone](https://github.com/threepointone)! - don't bork if connection disconnects

- [`fd17e02`](https://github.com/cloudflare/agents/commit/fd17e021a2aacf8c55b2d2ad181589d5bce79893) Thanks [@threepointone](https://github.com/threepointone)! - respond to server saved messages

- [`90fe787`](https://github.com/cloudflare/agents/commit/90fe7878ff0be64a41023070cc77742e49ec542e) Thanks [@threepointone](https://github.com/threepointone)! - fix scheduler implementation/types

## 0.0.15

### Patch Changes

- [`9075920`](https://github.com/cloudflare/agents/commit/9075920b732160ca7456ae394812a30f32c99f70) Thanks [@threepointone](https://github.com/threepointone)! - change onChatMessage signature

## 0.0.14

### Patch Changes

- [`2610509`](https://github.com/cloudflare/agents/commit/26105091622cef2c2f8aae60d4e673587d142739) Thanks [@threepointone](https://github.com/threepointone)! - Hono Agents

- [`7a3a1a0`](https://github.com/cloudflare/agents/commit/7a3a1a049adfe3d125696ce65881d04eb0ebe8df) Thanks [@threepointone](https://github.com/threepointone)! - AgentContext

## 0.0.13

### Patch Changes

- [`066c378`](https://github.com/cloudflare/agents/commit/066c378f4bcfaf2aa231e4e898bf2e22dc81f9f1) Thanks [@threepointone](https://github.com/threepointone)! - setState() doesn't take source anymore

## 0.0.12

### Patch Changes

- [`2864acf`](https://github.com/cloudflare/agents/commit/2864acfeab983efa3316c44f339cddb5bc86cd14) Thanks [@threepointone](https://github.com/threepointone)! - chat agent can now saveMessages explicitly

## 0.0.11

### Patch Changes

- [`7035ef5`](https://github.com/cloudflare/agents/commit/7035ef5327b650a11f721c08b57373a294354e9a) Thanks [@threepointone](https://github.com/threepointone)! - trigger a release

## 0.0.10

### Patch Changes

- [#15](https://github.com/cloudflare/agents/pull/15) [`ecd9324`](https://github.com/cloudflare/agents/commit/ecd9324d8470c521dd3566446d7afae1fa0c1b9f) Thanks [@elithrar](https://github.com/elithrar)! - env type fixes

## 0.0.9

### Patch Changes

- [`8335b4b`](https://github.com/cloudflare/agents/commit/8335b4bdfc17d4cc47ca5b03d0dad7f9c64ce6a1) Thanks [@threepointone](https://github.com/threepointone)! - fix some types

## 0.0.8

### Patch Changes

- [`619dac5`](https://github.com/cloudflare/agents/commit/619dac55e11543609f2a0869b6a3f05a78fa83fd) Thanks [@threepointone](https://github.com/threepointone)! - new useChat, with multiplayer, syncing, persistence; updated HITL guide with useChat

## 0.0.7

### Patch Changes

- [`0680a02`](https://github.com/cloudflare/agents/commit/0680a0245c41959588895c0d2bd39c98ca189a38) Thanks [@threepointone](https://github.com/threepointone)! - remove email mentions from readme

## 0.0.6

### Patch Changes

- [`acbd0f6`](https://github.com/cloudflare/agents/commit/acbd0f6e1375a42ba1ad577b68f6a8264f6e9827) Thanks [@threepointone](https://github.com/threepointone)! - .state/.setState/.onStateUpdate

## 0.0.5

### Patch Changes

- [`7dab6bc`](https://github.com/cloudflare/agents/commit/7dab6bcb4429cfa02dfdb62bbce59fd29e94308f) Thanks [@threepointone](https://github.com/threepointone)! - more on agentFetch

## 0.0.4

### Patch Changes

- [`411c149`](https://github.com/cloudflare/agents/commit/411c1490c79373d8e7959fd90cfcdc4a0d87290f) Thanks [@threepointone](https://github.com/threepointone)! - actually fix client fetch

## 0.0.3

### Patch Changes

- [`40bfbef`](https://github.com/cloudflare/agents/commit/40bfbefb3d7a0b15ae83e91d76bba8c8bb62be92) Thanks [@threepointone](https://github.com/threepointone)! - fix client.fetch

## 0.0.2

### Patch Changes

- [`3f1ad74`](https://github.com/cloudflare/agents/commit/3f1ad7466bb74574131cd4ffdf7ce4d116f03d70) Thanks [@threepointone](https://github.com/threepointone)! - export some types, use a default agent name

## 0.0.1

### Patch Changes

- [`eaba262`](https://github.com/cloudflare/agents/commit/eaba262167e8b10d55fc88e4bcdb26ba17879261) Thanks [@threepointone](https://github.com/threepointone)! - do a release
