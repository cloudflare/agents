/**
 * Context Processors - The "compiler pipeline" for building working context
 *
 * Based on Google's ADK whitepaper: Processors transform Session state into
 * Working Context through ordered passes. Each processor is a named, testable
 * transformation.
 *
 * Key concepts:
 * - Request processors: Transform Session → WorkingContext before LLM call
 * - Response processors: Process LLM response and update Session after call
 * - Pipeline: Ordered list of processors executed in sequence
 */

import {
  type Event,
  EventAction,
  type UserMessageEvent,
  type AgentMessageEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type CompactionEvent,
  type SystemInstructionEvent,
  generateEventId
} from "./events";
import { Session, type ConversationTurn } from "./session";
import {
  WorkingContext,
  type Content,
  type ContextWindowConfig,
  type AgentIdentity
} from "./working-context";

// ============================================================================
// PROCESSOR TYPES
// ============================================================================

/**
 * Request processor - transforms session into working context
 */
export type RequestProcessor<TConfig = unknown> = (
  session: Session,
  context: WorkingContext,
  config?: TConfig
) => WorkingContext | Promise<WorkingContext>;

/**
 * Response processor - processes LLM response and updates session
 */
export type ResponseProcessor<TConfig = unknown> = (
  session: Session,
  response: unknown,
  context: WorkingContext,
  config?: TConfig
) => Session | Promise<Session>;

/**
 * Processor entry in the pipeline
 */
export interface ProcessorEntry<TProcessor, TConfig = unknown> {
  name: string;
  processor: TProcessor;
  config?: TConfig;
  enabled?: boolean;
}

/**
 * Processor pipeline configuration
 */
export interface ProcessorPipelineConfig {
  requestProcessors: ProcessorEntry<RequestProcessor>[];
  responseProcessors: ProcessorEntry<ResponseProcessor>[];
}

// ============================================================================
// PROCESSOR PIPELINE CLASS
// ============================================================================

/**
 * ProcessorPipeline - Manages the ordered execution of processors
 *
 * This is the "compiler" that transforms Session state into WorkingContext
 * and processes responses back into Session updates.
 */
export class ProcessorPipeline {
  private requestProcessors: ProcessorEntry<RequestProcessor>[] = [];
  private responseProcessors: ProcessorEntry<ResponseProcessor>[] = [];

  constructor(config?: ProcessorPipelineConfig) {
    if (config) {
      this.requestProcessors = config.requestProcessors;
      this.responseProcessors = config.responseProcessors;
    }
  }

  /**
   * Add a request processor to the pipeline
   */
  addRequestProcessor<TConfig = unknown>(
    name: string,
    processor: RequestProcessor<TConfig>,
    config?: TConfig
  ): this {
    this.requestProcessors.push({
      name,
      processor: processor as RequestProcessor,
      config
    });
    return this;
  }

  /**
   * Add a response processor to the pipeline
   */
  addResponseProcessor<TConfig = unknown>(
    name: string,
    processor: ResponseProcessor<TConfig>,
    config?: TConfig
  ): this {
    this.responseProcessors.push({
      name,
      processor: processor as ResponseProcessor,
      config
    });
    return this;
  }

  /**
   * Insert a request processor at a specific position
   */
  insertRequestProcessor<TConfig = unknown>(
    index: number,
    name: string,
    processor: RequestProcessor<TConfig>,
    config?: TConfig
  ): this {
    this.requestProcessors.splice(index, 0, {
      name,
      processor: processor as RequestProcessor,
      config
    });
    return this;
  }

  /**
   * Remove a request processor by name
   */
  removeRequestProcessor(name: string): this {
    this.requestProcessors = this.requestProcessors.filter(
      (p) => p.name !== name
    );
    return this;
  }

  /**
   * Execute the request processor pipeline
   * Transforms Session into WorkingContext
   */
  async executeRequestPipeline(session: Session): Promise<WorkingContext> {
    let context = new WorkingContext(session.metadata.sessionId);

    for (const { name, processor, config, enabled } of this.requestProcessors) {
      if (enabled === false) continue;

      const result = processor(session, context, config);
      context = result instanceof Promise ? await result : result;
    }

    return context;
  }

  /**
   * Execute the response processor pipeline
   * Processes LLM response and updates Session
   */
  async executeResponsePipeline(
    session: Session,
    response: unknown,
    context: WorkingContext
  ): Promise<Session> {
    let updatedSession = session;

    for (const {
      name,
      processor,
      config,
      enabled
    } of this.responseProcessors) {
      if (enabled === false) continue;

      const result = processor(updatedSession, response, context, config);
      updatedSession = result instanceof Promise ? await result : result;
    }

    return updatedSession;
  }

  /**
   * Get the current pipeline configuration
   */
  getConfig(): ProcessorPipelineConfig {
    return {
      requestProcessors: [...this.requestProcessors],
      responseProcessors: [...this.responseProcessors]
    };
  }
}

// ============================================================================
// BUILT-IN REQUEST PROCESSORS
// ============================================================================

/**
 * Basic processor - initializes the working context with session metadata
 */
export const basicRequestProcessor: RequestProcessor = (
  session: Session,
  context: WorkingContext
): WorkingContext => {
  context.metadata.sessionId = session.metadata.sessionId;
  context.metadata.totalEvents = session.events.length;
  return context;
};

/**
 * Instructions processor config
 */
export interface InstructionsProcessorConfig {
  instructions?: string[];
}

/**
 * Instructions processor - adds system instructions to context
 */
export const instructionsRequestProcessor: RequestProcessor<
  InstructionsProcessorConfig
> = (
  session: Session,
  context: WorkingContext,
  config?: InstructionsProcessorConfig
): WorkingContext => {
  if (config?.instructions) {
    for (const instruction of config.instructions) {
      context.addSystemInstruction(instruction);
    }
  }

  // Add static instructions from session events
  const staticInstructions = session.events.filter(
    (e) =>
      e.action === EventAction.SYSTEM_INSTRUCTION &&
      (e as SystemInstructionEvent).isStatic
  ) as SystemInstructionEvent[];

  for (const instr of staticInstructions) {
    context.addSystemInstruction(instr.instruction);
  }

  return context;
};

/**
 * Identity processor - adds agent identity to context
 */
export const identityRequestProcessor: RequestProcessor<AgentIdentity> = (
  session: Session,
  context: WorkingContext,
  config?: AgentIdentity
): WorkingContext => {
  if (config) {
    context.setAgentIdentity(config);
  }
  return context;
};

/**
 * Contents processor config
 */
export interface ContentsProcessorConfig {
  windowSize?: number;
  includeToolCalls?: boolean;
  filterActions?: EventAction[];
}

/**
 * Contents processor - transforms session events into content objects
 * This is the core processor that bridges Session and WorkingContext
 */
export const contentsRequestProcessor: RequestProcessor<
  ContentsProcessorConfig
> = (
  session: Session,
  context: WorkingContext,
  config?: ContentsProcessorConfig
): WorkingContext => {
  const windowSize = config?.windowSize;
  const includeToolCalls = config?.includeToolCalls ?? true;
  const filterActions = config?.filterActions || [];

  // Get events to process
  let eventsToProcess = session.events;

  // Apply window size if specified
  if (windowSize && windowSize > 0) {
    eventsToProcess = eventsToProcess.slice(-windowSize);
  }

  // Filter out specified actions
  if (filterActions.length > 0) {
    eventsToProcess = eventsToProcess.filter(
      (e) => !filterActions.includes(e.action)
    );
  }

  // Transform events to contents
  for (const event of eventsToProcess) {
    switch (event.action) {
      case EventAction.USER_MESSAGE: {
        const userEvent = event as UserMessageEvent;
        context.addContent({
          role: "user",
          content: userEvent.content,
          metadata: {
            eventId: event.id,
            timestamp: event.timestamp
          }
        });
        break;
      }

      case EventAction.AGENT_MESSAGE: {
        const agentEvent = event as AgentMessageEvent;
        context.addContent({
          role: "assistant",
          content: agentEvent.content,
          metadata: {
            eventId: event.id,
            timestamp: event.timestamp,
            modelUsed: agentEvent.modelUsed,
            gatewayLogId: agentEvent.gatewayLogId
          }
        });
        break;
      }

      case EventAction.TOOL_CALL: {
        if (includeToolCalls) {
          const toolCallEvent = event as ToolCallEvent;
          context.addContent({
            role: "assistant",
            content: `Tool call: ${toolCallEvent.toolName} with arguments: ${JSON.stringify(toolCallEvent.arguments)}`,
            metadata: {
              eventId: event.id,
              timestamp: event.timestamp,
              toolCallId: toolCallEvent.toolCallId,
              toolName: toolCallEvent.toolName
            }
          });
        }
        break;
      }

      case EventAction.TOOL_RESULT: {
        if (includeToolCalls) {
          const toolResultEvent = event as ToolResultEvent;
          const resultContent =
            typeof toolResultEvent.result === "string"
              ? toolResultEvent.result
              : JSON.stringify(toolResultEvent.result);

          context.addContent({
            role: "tool",
            content: resultContent,
            name: toolResultEvent.toolName,
            tool_call_id: toolResultEvent.toolCallId,
            metadata: {
              eventId: event.id,
              timestamp: event.timestamp,
              isSuccess: toolResultEvent.isSuccess
            }
          });
        }
        break;
      }

      case EventAction.COMPACTION: {
        const compactionEvent = event as CompactionEvent;
        context.addContent({
          role: "system",
          content: `[Conversation Summary]: ${compactionEvent.summary}`,
          metadata: {
            eventId: event.id,
            timestamp: event.timestamp,
            compactedEventIds: compactionEvent.compactedEventIds
          }
        });
        break;
      }
    }
  }

  context.metadata.windowSize = context.contents.length;
  return context;
};

/**
 * Sliding window processor config
 */
export interface SlidingWindowProcessorConfig {
  turns?: number;
}

/**
 * Sliding window processor - keeps only recent conversation turns
 */
export const slidingWindowRequestProcessor: RequestProcessor<
  SlidingWindowProcessorConfig
> = (
  session: Session,
  context: WorkingContext,
  config?: SlidingWindowProcessorConfig
): WorkingContext => {
  const turns = config?.turns || 3;

  // Get user messages
  const userMessages = session.events.filter(
    (e) => e.action === EventAction.USER_MESSAGE
  );

  // Get the last N user messages
  const recentUserMessages = userMessages.slice(-turns);

  if (recentUserMessages.length === 0) {
    return context;
  }

  // Get the timestamp of the oldest user message in the window
  const windowStartTime = recentUserMessages[0].timestamp;

  // Filter events to only include those after the window start
  // But always include compaction events
  const filteredEvents = session.events.filter(
    (e) =>
      e.timestamp >= windowStartTime || e.action === EventAction.COMPACTION
  );

  // Create a temporary session with filtered events
  const tempSession = {
    ...session,
    events: filteredEvents
  } as Session;

  // Use contents processor on the filtered session
  return contentsRequestProcessor(tempSession, context, {
    includeToolCalls: true
  });
};

/**
 * Compaction filter processor config
 */
export interface CompactionFilterProcessorConfig {
  keepCompactionSummaries?: boolean;
}

/**
 * Compaction filter processor - removes compacted events from view
 * Works with CompactionEvent to filter out events that have been summarized
 */
export const compactionFilterRequestProcessor: RequestProcessor<
  CompactionFilterProcessorConfig
> = (
  session: Session,
  context: WorkingContext,
  config?: CompactionFilterProcessorConfig
): WorkingContext => {
  const keepSummaries = config?.keepCompactionSummaries ?? true;

  // Get all compaction events
  const compactionEvents = session.events.filter(
    (e) => e.action === EventAction.COMPACTION
  ) as CompactionEvent[];

  // Get all compacted event IDs
  const compactedEventIds = new Set<string>();
  for (const compaction of compactionEvents) {
    for (const id of compaction.compactedEventIds) {
      compactedEventIds.add(id);
    }
  }

  // Filter out compacted events
  const filteredEvents = session.events.filter(
    (e) =>
      !compactedEventIds.has(e.id) ||
      (keepSummaries && e.action === EventAction.COMPACTION)
  );

  // Create temporary session with filtered events
  const tempSession = {
    ...session,
    events: filteredEvents
  } as Session;

  context.metadata.compactedEvents = compactedEventIds.size;

  return contentsRequestProcessor(tempSession, context);
};

/**
 * Context cache processor config
 */
export interface ContextCacheProcessorConfig {
  enableCaching?: boolean;
}

/**
 * Context cache processor - marks stable prefixes for caching
 */
export const contextCacheRequestProcessor: RequestProcessor<
  ContextCacheProcessorConfig
> = (
  session: Session,
  context: WorkingContext,
  config?: ContextCacheProcessorConfig
): WorkingContext => {
  if (config?.enableCaching) {
    // Mark system instructions as cacheable
    (context.metadata as Record<string, unknown>).cacheEnabled = true;
    (context.metadata as Record<string, unknown>).cacheablePrefix =
      context.systemInstructions.length;
  }
  return context;
};

/**
 * Token limit processor - ensures context fits within token limits
 */
export const tokenLimitRequestProcessor: RequestProcessor<
  ContextWindowConfig
> = (
  session: Session,
  context: WorkingContext,
  config?: ContextWindowConfig
): WorkingContext => {
  if (config) {
    return context.truncateToFit(config);
  }
  return context;
};

// ============================================================================
// BUILT-IN RESPONSE PROCESSORS
// ============================================================================

/**
 * Statistics response processor - updates session statistics
 */
export const statisticsResponseProcessor: ResponseProcessor = (
  session: Session,
  response: unknown,
  context: WorkingContext
): Session => {
  const resp = response as { metadata?: { responseTimeMs?: number } };
  if (resp.metadata?.responseTimeMs) {
    const currentAvg = session.statistics.averageResponseTimeMs;
    const totalResponses = session.statistics.totalAgentMessages;
    const newAvg =
      (currentAvg * totalResponses + resp.metadata.responseTimeMs) /
      (totalResponses + 1);
    session.statistics.averageResponseTimeMs = newAvg;
  }

  return session;
};

// ============================================================================
// DEFAULT PIPELINE FACTORY
// ============================================================================

/**
 * Default pipeline configuration options
 */
export interface DefaultPipelineOptions {
  systemInstructions?: string[];
  agentIdentity?: AgentIdentity;
  windowSize?: number;
  contextWindowConfig?: ContextWindowConfig;
  enableCaching?: boolean;
  useCompactionFilter?: boolean;
  useSlidingWindow?: boolean;
}

/**
 * Create a default processor pipeline with common processors
 */
export function createDefaultPipeline(
  options: DefaultPipelineOptions = {}
): ProcessorPipeline {
  const pipeline = new ProcessorPipeline();

  // Request processors in order
  pipeline.addRequestProcessor("basic", basicRequestProcessor);

  pipeline.addRequestProcessor("instructions", instructionsRequestProcessor, {
    instructions: options.systemInstructions || []
  });

  if (options.agentIdentity) {
    pipeline.addRequestProcessor(
      "identity",
      identityRequestProcessor,
      options.agentIdentity
    );
  }

  // Use either compaction filter or sliding window, not both
  if (options.useCompactionFilter !== false) {
    pipeline.addRequestProcessor(
      "compaction-filter",
      compactionFilterRequestProcessor,
      { keepCompactionSummaries: true }
    );
  } else if (options.useSlidingWindow) {
    pipeline.addRequestProcessor(
      "sliding-window",
      slidingWindowRequestProcessor,
      { turns: options.windowSize || 3 }
    );
  } else {
    // Default: just use contents processor
    pipeline.addRequestProcessor("contents", contentsRequestProcessor, {
      includeToolCalls: true
    });
  }

  if (options.enableCaching) {
    pipeline.addRequestProcessor("context-cache", contextCacheRequestProcessor, {
      enableCaching: true
    });
  }

  if (options.contextWindowConfig) {
    pipeline.addRequestProcessor(
      "token-limit",
      tokenLimitRequestProcessor,
      options.contextWindowConfig
    );
  }

  // Response processors
  pipeline.addResponseProcessor("statistics", statisticsResponseProcessor);

  return pipeline;
}
