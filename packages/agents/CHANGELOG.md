# @cloudflare/agents

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
