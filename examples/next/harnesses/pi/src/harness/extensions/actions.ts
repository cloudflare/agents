import {
  BACKGROUND_CONTEXT,
  type AgentLane,
  type AgentMessage,
  type Context
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  ImageContent,
  Model,
  TextContent
} from "@earendil-works/pi-ai";
import type {
  ExtensionActions,
  ToolInfo
} from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { SlashCommandInfo } from "../../../vendor/pi-coding-agent-src/core/slash-commands.ts";
import type { ExtensionLaneStates, PiExtensionErrorReporter } from "./state";

/** What the 14 actions need from the host to reach the durable lane. */
export type ExtensionActionDeps = {
  readonly states: ExtensionLaneStates;
  /** Resolve one lane of the attached harness. */
  readonly lane: (name: string) => Promise<AgentLane>;
  /** Rename the session. */
  readonly setSessionName: (name: string) => Promise<void>;
  /** Label one transcript entry. */
  readonly setLabel: (
    entryId: string,
    label: string | undefined
  ) => Promise<void>;
  /** Re-resolve the process-local tool registry after a registration change. */
  readonly refreshTools: () => void;
  /** Every tool currently offered to the model, extension tools included. */
  readonly allTools: () => readonly ToolInfo[];
  /** Slash commands the session currently offers. */
  readonly commands: () => readonly SlashCommandInfo[];
  readonly report: PiExtensionErrorReporter;
};

function userMessage(
  content: string | (TextContent | ImageContent)[]
): AgentMessage {
  return {
    role: "user",
    content: typeof content === "string" ? content : content,
    timestamp: Date.now()
  };
}

/**
 * Pi's 14 `pi.*` action methods over one durable lane.
 *
 * The API is synchronous and the lane is not, so reads come from the cached
 * lane read model the runtime refreshes before every handler, and writes are
 * appended to that lane's serialized chain. An extension therefore sees its
 * own writes land in issue order, and a rejected write becomes a
 * `handler_error` on the lane rather than an unhandled rejection inside the
 * Durable Object.
 */
export function createExtensionActions(
  deps: ExtensionActionDeps
): ExtensionActions {
  const { states, report } = deps;
  const write = (
    source: string,
    work: (lane: AgentLane, context: Context) => Promise<void>
  ): void => {
    states.current.enqueue(source, deps.lane, report, work);
  };

  return {
    sendMessage: (message, options) => {
      const custom: AgentMessage = {
        role: "custom",
        customType: message.customType,
        content: message.content,
        display: message.display,
        ...(message.details === undefined ? {} : { details: message.details }),
        timestamp: Date.now()
      };
      write("sendMessage", async (lane, context) => {
        switch (options?.deliverAs) {
          case "steer":
            await lane.steer(custom, undefined, context);
            return;
          case "followUp":
            await lane.followUp(custom, undefined, context);
            return;
          case "nextTurn":
            await lane.nextRun(custom, undefined, context);
            return;
          default:
            // `triggerTurn` asks for the same message to start a run, not
            // for a second one: `nextRun` appends it and drives it, so
            // appending it here as well would leave the transcript holding
            // the message twice.
            if (options?.triggerTurn) {
              await lane.nextRun(custom, undefined, context);
              return;
            }
            await lane.appendMessage(custom, context);
        }
      });
    },

    sendUserMessage: (content, options) => {
      const message = userMessage(content);
      write("sendUserMessage", async (lane, context) => {
        switch (options?.deliverAs) {
          case "steer":
            await lane.steer(message, undefined, context);
            return;
          case "followUp":
            await lane.followUp(message, undefined, context);
            return;
          default:
            await lane.nextRun(message, undefined, context);
        }
      });
    },

    appendEntry: (customType, data) => {
      write("appendEntry", async (lane, context) => {
        await lane.appendCustomEntry(
          customType,
          // SAFETY: extension entry payloads are the JSON pi persists.
          data === undefined ? undefined : (data as never),
          context
        );
      });
    },

    setSessionName: (name) => {
      states.current.sessionName = name;
      write("setSessionName", async () => {
        await deps.setSessionName(name);
      });
    },

    getSessionName: () => states.current.sessionName,

    setLabel: (entryId, label) => {
      write("setLabel", async () => {
        await deps.setLabel(entryId, label);
      });
    },

    getActiveTools: () => [...states.current.activeTools],

    getAllTools: () => [...deps.allTools()],

    setActiveTools: (toolNames) => {
      states.current.activeTools = [...toolNames];
      write("setActiveTools", async (lane, context) => {
        await lane.setActiveTools([...toolNames], context);
      });
    },

    refreshTools: () => {
      deps.refreshTools();
    },

    getCommands: () => [...deps.commands()],

    setModel: async (model: Model<Api>) => {
      const state = states.current;
      try {
        const lane = await deps.lane(state.lane);
        // Earlier extension writes on this lane go first.
        await state.drain();
        await lane.setModel(
          { provider: model.provider, modelId: model.id },
          BACKGROUND_CONTEXT
        );
        state.model = model;
        return true;
      } catch (error) {
        report({
          lane: state.lane,
          kind: "extension",
          source: "setModel",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack !== undefined
            ? { stack: error.stack }
            : {})
        });
        return false;
      }
    },

    getThinkingLevel: () => states.current.thinkingLevel,

    setThinkingLevel: (level) => {
      states.current.thinkingLevel = level;
      write("setThinkingLevel", async (lane, context) => {
        await lane.setThinkingLevel(level, context);
      });
    }
  };
}
