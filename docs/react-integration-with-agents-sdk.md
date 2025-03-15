# React Integration with Agents SDK

The `agents-sdk` provides React hooks to simplify the integration of AI agents into your React applications. This guide covers the usage of `useAgent` and `useAgentChat` hooks, demonstrating how to connect to agents, manage state, and build chat interfaces.

## `useAgent` Hook

The `useAgent` hook establishes a connection to an AI agent and provides methods for interacting with it. It manages the agent's state and allows you to call methods on the agent.

### Usage

```tsx
import { useAgent } from "agents-sdk/react";
import { useState } from "react";

function MyComponent() {
  const [counter, setCounter] = useState(0);
  const agent = useAgent({
    agent: "my-agent",
    name: "instance-1",
    onStateUpdate: (newState) => {
      setCounter(newState.counter);
    },
  });

  const increment = () => {
    agent.setState({ counter: counter + 1 });
  };

  return (
    <div>
      <p>Counter: {counter}</p>
      <button onClick={increment}>Increment</button>
    </div>
  );
}
```

### Parameters

- `options`: An object containing the following properties:
  - `agent`: (string) The name of the agent to connect to.
  - `name`: (string, optional) The name of the specific agent instance. Defaults to "default".
  - `onStateUpdate`: (function, optional) A callback function that is called when the agent's state is updated. It receives the new state and the source of the update ("server" or "client").
  - Other `PartySocketOptions` can be passed to configure the underlying WebSocket connection.

### Return Value

The `useAgent` hook returns a `PartySocket` object with the following additional properties:

- `agent`: (string) The name of the agent.
- `name`: (string) The name of the agent instance.
- `setState`: (function) A function to update the agent's state. It takes the new state as an argument.
- `call`: (function) A function to call a method on the agent. It takes the method name and arguments as arguments. See [core-agent-functionality.md] for more information on calling agent methods.

### State Management

The `useAgent` hook automatically synchronizes the agent's state between the server and the client. When the state is updated on the server, the `onStateUpdate` callback is called on the client. You can also update the state on the client by calling the `setState` method.

## `useAgentChat` Hook

The `useAgentChat` hook simplifies the creation of chat interfaces with AI agents. It provides methods for sending and receiving messages, managing chat history, and clearing the chat.

### Usage

```tsx
import { useAgent } from "agents-sdk/react";
import { useAgentChat } from "agents-sdk/ai-react";

function ChatInterface() {
  const agent = useAgent({ agent: "dialogue-agent" });
  const { messages, input, handleInputChange, handleSubmit, clearHistory } =
    useAgentChat({
      agent,
      maxSteps: 5,
    });

  return (
    <div className="chat-interface">
      <div className="message-flow">
        {messages.map((message) => (
          <div key={message.id} className="message">
            <div className="role">{message.role}</div>
            <div className="content">{message.content}</div>
          </div>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="input-area">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Type your message..."
          className="message-input"
        />
      </form>
      <button onClick={clearHistory} className="clear-button">
        Clear Chat
      </button>
    </div>
  );
}
```

### Parameters

- `options`: An object containing the following properties:
  - `agent`: (object) The agent connection obtained from the `useAgent` hook.
  - `initialMessages`: (array, optional) An array of initial chat messages. Defaults to [].
  - `maxSteps`: (number, optional) The maximum number of steps in the chat. Defaults to 10.
  - Other options from `@ai-sdk/react`'s `useChat` hook.

### Return Value

The `useAgentChat` hook returns an object with the following properties:

- `messages`: (array) An array of chat messages.
- `input`: (string) The current input value.
- `handleInputChange`: (function) A function to handle changes to the input value.
- `handleSubmit`: (function) A function to handle the submission of a new message.
- `clearHistory`: (function) A function to clear the chat history.
- `setMessages`: (function) A function to set the chat messages and synchronize with the Agent.

### Chat Interaction

The `useAgentChat` hook simplifies the process of building chat interfaces by providing methods for managing messages, input, and chat history. The `handleSubmit` function automatically sends the message to the agent, and the `messages` array is updated when new messages are received.

## Examples

### Simple State Management

```tsx
import { useAgent } from "agents-sdk/react";
import { useState } from "react";

function Counter() {
  const [count, setCount] = useState(0);
  const agent = useAgent({
    agent: "counter-agent",
    onStateUpdate: (newState) => {
      setCount(newState.count || 0);
    },
  });

  const increment = () => {
    agent.setState({ count: count + 1 });
  };

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={increment}>Increment</button>
    </div>
  );
}
```

### Building a Chat Interface

```tsx
import { useAgent } from "agents-sdk/react";
import { useAgentChat } from "agents-sdk/ai-react";

function Chat() {
  const agent = useAgent({ agent: "chat-agent" });
  const { messages, input, handleInputChange, handleSubmit, clearHistory } =
    useAgentChat({
      agent,
    });

  return (
    <div>
      <div>
        {messages.map((message) => (
          <div key={message.id}>
            {message.role}: {message.content}
          </div>
        ))}
      </div>
      <input type="text" value={input} onChange={handleInputChange} />
      <button onClick={handleSubmit}>Send</button>
      <button onClick={clearHistory}>Clear</button>
    </div>
  );
}
```

## Conclusion

The `agents-sdk/react` and `agents-sdk/ai-react` modules provide powerful tools for integrating AI agents into your React applications. By using the `useAgent` and `useAgentChat` hooks, you can easily connect to agents, manage state, and build chat interfaces.
