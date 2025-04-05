# @cloudflare/agents

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
      color: "#3B82F6",
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
    },
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
