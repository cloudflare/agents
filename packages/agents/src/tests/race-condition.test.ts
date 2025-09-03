import { Agent, type AgentNamespace, unstable_callable as callable } from "../";
import type { Connection, WSMessage } from "../";

// Mock agent for testing
class TestAgent extends Agent {
  public connectCallbacks: Array<() => void> = [];
  public onConnectCompleted = false;
  public receivedMessages: Array<{ connectionId: string; message: WSMessage }> = [];

  override async onConnect(connection: Connection) {
    // Simulate some async work that could cause the race condition
    await new Promise(resolve => setTimeout(resolve, 10));
    
    this.onConnectCompleted = true;
    this.connectCallbacks.forEach(cb => cb());
  }

  override async onMessage(connection: Connection, message: WSMessage) {
    this.receivedMessages.push({
      connectionId: connection.id,
      message
    });
    
    // Call parent to handle normal message processing
    await super.onMessage(connection, message);
  }

  @callable()
  async testMethod(value: string) {
    return `received: ${value}`;
  }
}

// Mock connection for testing
function createMockConnection(id: string = 'test-connection'): Connection {
  const sentMessages: string[] = [];
  
  return {
    id,
    send: (message: string) => {
      sentMessages.push(message);
    },
    close: () => {},
    // @ts-ignore - simplified mock
    addEventListener: () => {},
    // Add sentMessages for testing
    _sentMessages: sentMessages
  } as any;
}

// Mock connection context
function createMockConnectionContext(): any {
  return {
    request: new Request('http://localhost/test')
  };
}

// Mock agent context (DurableObjectState)
function createMockAgentContext(): any {
  return {
    storage: {
      sql: {
        exec: () => ({ toArray: () => [] })
      },
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      deleteAll: async () => {}
    },
    blockConcurrencyWhile: async (fn: () => Promise<any>) => await fn(),
    abort: () => {}
  };
}

describe('Race Condition Fix', () => {
  let agent: TestAgent;
  let mockConnection: Connection;
  let mockContext: any;

  beforeEach(() => {
    mockConnection = createMockConnection();
    mockContext = createMockAgentContext();
    agent = new TestAgent(mockContext, {});
  });

  describe('Message Queuing During Connection Setup', () => {
    test('should queue messages sent during onConnect', async () => {
      // Set up a promise to wait for onConnect completion
      let connectResolve: () => void;
      const connectPromise = new Promise<void>(resolve => {
        connectResolve = resolve;
      });
      
      agent.connectCallbacks.push(() => connectResolve());

      // Start connection process
      const connectPromise2 = agent.onConnect(mockConnection, createMockConnectionContext());

      // Send messages while onConnect is still running
      const testMessage1 = JSON.stringify({
        type: "rpc",
        id: "test1",
        method: "testMethod",
        args: ["message1"]
      });
      
      const testMessage2 = JSON.stringify({
        type: "rpc", 
        id: "test2",
        method: "testMethod",
        args: ["message2"]
      });

      // Send messages immediately (should be queued)
      const messagePromise1 = agent.onMessage(mockConnection, testMessage1);
      const messagePromise2 = agent.onMessage(mockConnection, testMessage2);

      // Verify onConnect hasn't completed yet
      expect(agent.onConnectCompleted).toBe(false);
      
      // Verify messages are queued (not processed yet)
      expect(agent.receivedMessages).toHaveLength(0);

      // Wait for onConnect to complete
      await connectPromise;
      await connectPromise2;

      // Wait a bit for queued messages to be processed
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify onConnect completed
      expect(agent.onConnectCompleted).toBe(true);
      
      // Verify both messages were eventually processed in order
      expect(agent.receivedMessages).toHaveLength(2);
      expect(agent.receivedMessages[0].message).toBe(testMessage1);
      expect(agent.receivedMessages[1].message).toBe(testMessage2);
    });

    test('should process messages normally after connection is ready', async () => {
      // Complete the connection process first
      await agent.onConnect(mockConnection, createMockConnectionContext());
      
      // Now send a message - should be processed immediately
      const testMessage = JSON.stringify({
        type: "rpc",
        id: "test1", 
        method: "testMethod",
        args: ["immediate"]
      });

      await agent.onMessage(mockConnection, testMessage);

      // Should be processed immediately
      expect(agent.receivedMessages).toHaveLength(1);
      expect(agent.receivedMessages[0].message).toBe(testMessage);
    });
  });

  describe('Connection State Management', () => {
    test('should track connection states correctly', async () => {
      // Initially no connection state
      expect(agent['_connectionStates'].has(mockConnection.id)).toBe(false);
      
      // Start connection
      const connectPromise = agent.onConnect(mockConnection, createMockConnectionContext());
      
      // Should be in connecting state
      expect(agent['_connectionStates'].get(mockConnection.id)).toBe('connecting');
      
      // Complete connection
      await connectPromise;
      
      // Should be in ready state
      expect(agent['_connectionStates'].get(mockConnection.id)).toBe('ready');
    });

    test('should clean up connection state on error', async () => {
      // Set up connection state
      agent['_connectionStates'].set(mockConnection.id, 'connecting');
      agent['_messageQueues'].set(mockConnection.id, []);

      // Call onError with connection error
      try {
        agent.onError(mockConnection, new Error('test error'));
      } catch (e) {
        // Expected to throw
      }

      // Should have cleaned up connection state
      expect(agent['_connectionStates'].has(mockConnection.id)).toBe(false);
      expect(agent['_messageQueues'].has(mockConnection.id)).toBe(false);
    });

    test('should clean up all connections on destroy', async () => {
      // Set up multiple connections
      const connection1 = createMockConnection('conn1');
      const connection2 = createMockConnection('conn2');
      
      agent['_connectionStates'].set(connection1.id, 'ready');
      agent['_connectionStates'].set(connection2.id, 'connecting');
      agent['_messageQueues'].set(connection1.id, []);
      agent['_messageQueues'].set(connection2.id, []);

      // Destroy agent
      await agent.destroy();

      // All connection state should be cleaned up
      expect(agent['_connectionStates'].size).toBe(0);
      expect(agent['_messageQueues'].size).toBe(0);
    });
  });

  describe('Message Processing Order', () => {
    test('should maintain message order when processing queue', async () => {
      const messages: string[] = [];
      
      // Override onMessage to track processing order
      const originalOnMessage = agent.onMessage.bind(agent);
      agent.onMessage = async (connection: Connection, message: WSMessage) => {
        if (typeof message === 'string') {
          const parsed = JSON.parse(message);
          if (parsed.type === 'rpc') {
            messages.push(parsed.args[0]);
          }
        }
        return originalOnMessage(connection, message);
      };

      // Start connection but don't await
      const connectPromise = agent.onConnect(mockConnection, createMockConnectionContext());

      // Send multiple messages rapidly
      const messagePromises = [];
      for (let i = 0; i < 5; i++) {
        const message = JSON.stringify({
          type: "rpc",
          id: `test${i}`,
          method: "testMethod", 
          args: [`message${i}`]
        });
        messagePromises.push(agent.onMessage(mockConnection, message));
      }

      // Wait for everything to complete
      await connectPromise;
      await Promise.all(messagePromises);
      
      // Give time for queue processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Messages should be processed in order
      expect(messages).toEqual(['message0', 'message1', 'message2', 'message3', 'message4']);
    });
  });

  describe('Multiple Concurrent Connections', () => {
    test('should handle multiple connections independently', async () => {
      const connection1 = createMockConnection('conn1');
      const connection2 = createMockConnection('conn2');

      // Start both connections
      const connect1Promise = agent.onConnect(connection1, createMockConnectionContext());
      const connect2Promise = agent.onConnect(connection2, createMockConnectionContext());

      // Send messages to both connections
      const msg1Promise = agent.onMessage(connection1, JSON.stringify({
        type: "rpc", id: "test1", method: "testMethod", args: ["conn1-msg"]
      }));
      
      const msg2Promise = agent.onMessage(connection2, JSON.stringify({
        type: "rpc", id: "test2", method: "testMethod", args: ["conn2-msg"]  
      }));

      // Wait for everything to complete
      await Promise.all([connect1Promise, connect2Promise, msg1Promise, msg2Promise]);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Both connections should be ready
      expect(agent['_connectionStates'].get(connection1.id)).toBe('ready');
      expect(agent['_connectionStates'].get(connection2.id)).toBe('ready');
      
      // Both messages should have been processed
      expect(agent.receivedMessages).toHaveLength(2);
      
      const conn1Messages = agent.receivedMessages.filter(m => m.connectionId === connection1.id);
      const conn2Messages = agent.receivedMessages.filter(m => m.connectionId === connection2.id);
      
      expect(conn1Messages).toHaveLength(1);
      expect(conn2Messages).toHaveLength(1);
    });
  });
});