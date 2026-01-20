/**
 * Working Context - The ephemeral, computed view sent to the LLM
 *
 * This is the "compiled view" over the Session state.
 * It's rebuilt for each invocation and is model-agnostic.
 */

// ============================================================================
// WORKING CONTEXT TYPES
// ============================================================================

/**
 * Content roles for LLM messages
 */
export type ContentRole = "system" | "user" | "assistant" | "tool";

/**
 * Content object - the formatted message for LLM
 */
export interface Content {
  role: ContentRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Agent identity
 */
export interface AgentIdentity {
  name: string;
  role: string;
  capabilities: string[];
}

/**
 * Artifact reference
 */
export interface ArtifactReference {
  id: string;
  name: string;
  type: string;
  summary: string;
}

/**
 * Working context metadata
 */
export interface WorkingContextMetadata {
  sessionId: string;
  totalEvents: number;
  compactedEvents: number;
  windowSize: number;
  createdAt: number;
}

/**
 * Context window configuration
 */
export interface ContextWindowConfig {
  maxTokens: number;
  reservedForResponse: number;
  reservedForTools: number;
  availableForHistory: number;
}

/**
 * Workers AI input for responses format
 */
export interface WorkersAIInput {
  type?: string;
  call_id?: string;
  output?: string;
  role?: string;
  content?: string;
  name?: string;
}

/**
 * Workers AI message for chat_completions format
 */
export interface WorkersAIMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
}

/**
 * Workers AI format return type
 */
export type WorkersAIFormat =
  | {
      instructions: string;
      input: WorkersAIInput[];
      reasoning: {
        effort: string;
        summary: string;
      };
    }
  | {
      messages: WorkersAIMessage[];
    };

// ============================================================================
// WORKING CONTEXT CLASS
// ============================================================================

/**
 * WorkingContext - The ephemeral, computed view sent to the LLM
 *
 * A WorkingContext is built for each LLM invocation from the Session state.
 * It provides a builder pattern for constructing the context and methods for
 * converting to model-specific formats.
 */
export class WorkingContext {
  readonly systemInstructions: string[] = [];
  agentIdentity?: AgentIdentity;
  readonly contents: Content[] = [];
  readonly memoryResults: string[] = [];
  readonly artifactReferences: ArtifactReference[] = [];
  readonly metadata: WorkingContextMetadata;

  constructor(sessionId: string) {
    this.metadata = {
      sessionId,
      totalEvents: 0,
      compactedEvents: 0,
      windowSize: 0,
      createdAt: Date.now()
    };
  }

  /**
   * Add a system instruction
   */
  addSystemInstruction(instruction: string): this {
    this.systemInstructions.push(instruction);
    return this;
  }

  /**
   * Set agent identity
   */
  setAgentIdentity(identity: AgentIdentity): this {
    this.agentIdentity = identity;
    return this;
  }

  /**
   * Add a single content
   */
  addContent(content: Content): this {
    this.contents.push(content);
    return this;
  }

  /**
   * Add multiple contents
   */
  addContents(contents: Content[]): this {
    this.contents.push(...contents);
    return this;
  }

  /**
   * Add memory results
   */
  addMemoryResults(results: string[]): this {
    this.memoryResults.push(...results);
    return this;
  }

  /**
   * Add an artifact reference
   */
  addArtifactReference(reference: ArtifactReference): this {
    this.artifactReferences.push(reference);
    return this;
  }

  /**
   * Get the total estimated token count for the working context
   * (Rough estimation: 1 token ≈ 4 characters)
   */
  estimateTokenCount(): number {
    let totalChars = 0;

    totalChars += this.systemInstructions.join("\n").length;

    if (this.agentIdentity) {
      totalChars += JSON.stringify(this.agentIdentity).length;
    }

    for (const content of this.contents) {
      totalChars += content.content.length;
    }

    if (this.memoryResults.length > 0) {
      totalChars += this.memoryResults.join("\n").length;
    }

    if (this.artifactReferences.length > 0) {
      totalChars += JSON.stringify(this.artifactReferences).length;
    }

    return Math.ceil(totalChars / 4);
  }

  /**
   * Check if context fits within token limit
   */
  fitsWithinLimit(config: ContextWindowConfig): boolean {
    const estimatedTokens = this.estimateTokenCount();
    return estimatedTokens <= config.availableForHistory;
  }

  /**
   * Truncate context to fit within token limit
   * Keeps system instructions and recent messages
   */
  truncateToFit(config: ContextWindowConfig): this {
    const currentTokens = this.estimateTokenCount();

    if (currentTokens <= config.availableForHistory) {
      return this;
    }

    const systemTokens =
      this.systemInstructions.join("\n").length / 4 +
      (this.agentIdentity ? JSON.stringify(this.agentIdentity).length / 4 : 0);
    const availableForContents = config.availableForHistory - systemTokens;

    let currentContentTokens = 0;
    const contentsToKeep: Content[] = [];

    for (let i = this.contents.length - 1; i >= 0; i--) {
      const content = this.contents[i];
      const contentTokens = Math.ceil(content.content.length / 4);

      if (currentContentTokens + contentTokens <= availableForContents) {
        contentsToKeep.unshift(content);
        currentContentTokens += contentTokens;
      } else {
        break;
      }
    }

    this.contents.length = 0;
    this.contents.push(...contentsToKeep);
    this.metadata.windowSize = contentsToKeep.length;

    return this;
  }

  /**
   * Convert working context to a format suitable for LLM API
   * This is where model-specific formatting happens
   */
  toModelFormat(
    modelType: "workers-ai" = "workers-ai",
    options?: {
      format?: "responses" | "chat_completions" | "native";
      model?: string;
    }
  ): WorkersAIFormat {
    switch (modelType) {
      case "workers-ai":
        return this._toWorkersAIFormat(
          options?.format || "chat_completions",
          options?.model
        );
      default:
        throw new Error(`Unsupported model type: ${modelType}`);
    }
  }

  /**
   * Convert to Workers AI format
   * Workers AI supports three response formats with different input/output structures
   */
  private _toWorkersAIFormat(
    format: "responses" | "chat_completions" | "native",
    model?: string
  ): WorkersAIFormat {
    const MODELS_USING_ASSISTANT_ROLE = new Set([
      "@cf/mistralai/mistral-small-3.1-24b-instruct"
    ]);

    const usesAssistantRole = model
      ? MODELS_USING_ASSISTANT_ROLE.has(model)
      : false;

    let systemContent = this.systemInstructions.join("\n\n");

    if (this.agentIdentity) {
      systemContent += `\n\nAgent Identity:\nName: ${this.agentIdentity.name}\nRole: ${this.agentIdentity.role}\nCapabilities: ${this.agentIdentity.capabilities.join(", ")}`;
    }

    if (this.memoryResults.length > 0) {
      systemContent += `\n\nRelevant Memory:\n${this.memoryResults.join("\n\n")}`;
    }

    if (this.artifactReferences.length > 0) {
      systemContent += `\n\nAvailable Artifacts:\n${this.artifactReferences.map((a) => `- ${a.name} (${a.type}): ${a.summary}`).join("\n")}`;
    }

    if (format === "responses") {
      const input: WorkersAIInput[] = [];

      for (const content of this.contents) {
        if (content.role === "tool") {
          input.push({
            type: "function_call_output",
            call_id: content.tool_call_id,
            output: content.content
          });
        } else {
          input.push({
            role: content.role,
            content: content.content,
            ...(content.name && { name: content.name })
          });
        }
      }

      return {
        instructions: systemContent,
        input,
        reasoning: {
          effort: "medium",
          summary: "concise"
        }
      };
    } else {
      const messages: WorkersAIMessage[] = [];

      messages.push({
        role: "system",
        content: systemContent
      });

      for (const content of this.contents) {
        if (content.role === "tool") {
          if (usesAssistantRole) {
            messages.push({
              role: "assistant",
              content: content.content
            });
          } else {
            messages.push({
              role: "tool",
              ...(content.tool_call_id && {
                tool_call_id: content.tool_call_id
              }),
              content: content.content
            });
          }
        } else {
          messages.push({
            role: content.role,
            content: content.content,
            ...(content.name && { name: content.name }),
            ...(content.tool_call_id && { tool_call_id: content.tool_call_id })
          });
        }
      }

      return { messages };
    }
  }
}
