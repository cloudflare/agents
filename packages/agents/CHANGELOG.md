# @cloudflare/agents

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
