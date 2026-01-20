/**
 * Session Management System
 * Based on Google's ADK whitepaper principles for context-aware multi-agent frameworks
 * https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/
 *
 * Key principles:
 * 1. Sessions are the source of truth - structured, durable state
 * 2. Events are strongly-typed, model-agnostic records
 * 3. Working context is a computed view derived from sessions
 */

import {
  type Event,
  EventAction,
  type UserMessageEvent,
  type AgentMessageEvent,
  type ToolCallEvent,
  type ToolResultEvent
} from "./events";

// ============================================================================
// SESSION TYPES
// ============================================================================

/**
 * Session metadata
 */
export interface SessionMetadata {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  agentId: string;
}

/**
 * Session statistics
 */
export interface SessionStatistics {
  totalEvents: number;
  totalUserMessages: number;
  totalAgentMessages: number;
  totalToolCalls: number;
  totalErrors: number;
  totalCompactions: number;
  averageResponseTimeMs: number;
  totalTokensUsed: number;
}

/**
 * Compaction configuration
 */
export interface CompactionConfig {
  enabled: boolean;
  triggerThreshold: number;
  windowSize: number;
  overlapSize: number;
  strategy: "sliding_window" | "semantic" | "time_based";
}

/**
 * Conversation turn structure
 */
export interface ConversationTurn {
  user: UserMessageEvent;
  agent?: AgentMessageEvent;
  tools?: Array<ToolCallEvent | ToolResultEvent>;
}

// ============================================================================
// SESSION CLASS
// ============================================================================

/**
 * Session - The definitive state of a conversation
 *
 * A Session is the durable, structured log of an agent's interaction with a user.
 * It maintains the ground truth of the conversation and provides methods for
 * querying and manipulating the event stream.
 */
export class Session {
  readonly metadata: SessionMetadata;
  readonly events: Event[];
  readonly statistics: SessionStatistics;
  readonly compactionConfig: CompactionConfig;

  constructor(agentId: string) {
    const now = Date.now();

    this.metadata = {
      sessionId: `session_${now}_${Math.random().toString(36).substr(2, 9)}`,
      createdAt: now,
      updatedAt: now,
      agentId
    };

    this.events = [];

    this.statistics = {
      totalEvents: 0,
      totalUserMessages: 0,
      totalAgentMessages: 0,
      totalToolCalls: 0,
      totalErrors: 0,
      totalCompactions: 0,
      averageResponseTimeMs: 0,
      totalTokensUsed: 0
    };

    this.compactionConfig = {
      enabled: true,
      triggerThreshold: 50,
      windowSize: 10,
      overlapSize: 2,
      strategy: "sliding_window"
    };
  }

  /**
   * Add an event to the session
   */
  addEvent(event: Event): this {
    this.events.push(event);
    this.metadata.updatedAt = Date.now();
    this.statistics.totalEvents++;

    switch (event.action) {
      case EventAction.USER_MESSAGE:
        this.statistics.totalUserMessages++;
        break;
      case EventAction.AGENT_MESSAGE:
        this.statistics.totalAgentMessages++;
        if ((event as AgentMessageEvent).tokensUsed) {
          this.statistics.totalTokensUsed += (
            event as AgentMessageEvent
          ).tokensUsed!;
        }
        break;
      case EventAction.TOOL_CALL:
        this.statistics.totalToolCalls++;
        break;
      case EventAction.ERROR:
        this.statistics.totalErrors++;
        break;
      case EventAction.COMPACTION:
        this.statistics.totalCompactions++;
        break;
    }

    return this;
  }

  /**
   * Check if session needs compaction
   */
  needsCompaction(): boolean {
    if (!this.compactionConfig.enabled) {
      return false;
    }

    const uncompactedEvents = this.events.filter(
      (e) => e.action !== EventAction.COMPACTION
    );

    return uncompactedEvents.length >= this.compactionConfig.triggerThreshold;
  }

  /**
   * Get events within a time range
   */
  getEventsByTimeRange(startTime: number, endTime: number): Event[] {
    return this.events.filter(
      (e) => e.timestamp >= startTime && e.timestamp <= endTime
    );
  }

  /**
   * Get events by action type
   */
  getEventsByAction(action: EventAction): Event[] {
    return this.events.filter((e) => e.action === action);
  }

  /**
   * Get the last N events
   */
  getLastNEvents(n: number): Event[] {
    return this.events.slice(-n);
  }

  /**
   * Get conversation turns (user-agent pairs)
   */
  getConversationTurns(): ConversationTurn[] {
    const turns: ConversationTurn[] = [];
    let currentTurn: ConversationTurn | null = null;

    for (const event of this.events) {
      if (event.action === EventAction.USER_MESSAGE) {
        if (currentTurn) {
          turns.push(currentTurn);
        }
        currentTurn = { user: event as UserMessageEvent, tools: [] };
      } else if (currentTurn) {
        if (event.action === EventAction.AGENT_MESSAGE) {
          currentTurn.agent = event as AgentMessageEvent;
        } else if (
          event.action === EventAction.TOOL_CALL ||
          event.action === EventAction.TOOL_RESULT
        ) {
          currentTurn.tools!.push(event as ToolCallEvent | ToolResultEvent);
        }
      }
    }

    if (currentTurn) {
      turns.push(currentTurn);
    }

    return turns;
  }

  /**
   * Update compaction configuration
   */
  updateCompactionConfig(updates: Partial<CompactionConfig>): this {
    Object.assign(this.compactionConfig, updates);
    return this;
  }

  /**
   * Serialize session for storage
   */
  serialize(): string {
    return JSON.stringify({
      metadata: this.metadata,
      events: this.events,
      statistics: this.statistics,
      compactionConfig: this.compactionConfig
    });
  }

  /**
   * Deserialize session from storage
   */
  static deserialize(data: string): Session {
    const parsed = JSON.parse(data);
    const session = new Session(parsed.metadata.agentId);

    Object.assign(session.metadata, parsed.metadata);
    Object.assign(session.statistics, parsed.statistics);
    Object.assign(session.compactionConfig, parsed.compactionConfig);
    session.events.push(...parsed.events);

    return session;
  }

  /**
   * Create a session from a plain object (for backwards compatibility)
   */
  static fromObject(obj: {
    metadata: SessionMetadata;
    events: Event[];
    statistics: SessionStatistics;
    compactionConfig: CompactionConfig;
  }): Session {
    const session = new Session(obj.metadata.agentId);

    Object.assign(session.metadata, obj.metadata);
    Object.assign(session.statistics, obj.statistics);
    Object.assign(session.compactionConfig, obj.compactionConfig);
    session.events.push(...obj.events);

    return session;
  }

  /**
   * Convert session to a plain object
   */
  toObject(): {
    metadata: SessionMetadata;
    events: Event[];
    statistics: SessionStatistics;
    compactionConfig: CompactionConfig;
  } {
    return {
      metadata: this.metadata,
      events: this.events,
      statistics: this.statistics,
      compactionConfig: this.compactionConfig
    };
  }
}
