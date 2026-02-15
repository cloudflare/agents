import { useEffect, useRef, useState } from "react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import TextareaAutosize from "react-textarea-autosize";
import { GearIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import Footer from "./components/Footer";
import Header from "./components/Header";
import { SparkleIcon, WorkersAILogo } from "./components/Icons";
import { McpServers } from "./components/McpServers";
import UnifiedModelSelector from "./components/UnifiedModelSelector";
import ViewCodeModal from "./components/ViewCodeModal";
import { ToolCallCard } from "./components/ToolCallCard";
import { ReasoningCard } from "./components/ReasoningCard";
import { isToolUIPart, type UIMessage } from "ai";
import { useAgent } from "agents/react";
import type { MCPServersState } from "agents";
import { nanoid } from "nanoid";
import type { Playground, PlaygroundState } from "./server";
import type { Model } from "./models";
import type { McpServersComponentState } from "./components/McpServers";
import { Streamdown } from "streamdown";

const STORAGE_KEY = "playground_session_id";
const MAX_MCP_LOGS = 200;

const DEFAULT_PARAMS = {
  model: "@cf/zai-org/glm-4.7-flash",
  temperature: 0,
  stream: true,
  system:
    "You are a helpful assistant that can do various tasks using MCP tools."
};

const DEFAULT_EXTERNAL_MODELS: Record<string, string> = {
  openai: "openai/gpt-5.2",
  anthropic: "anthropic/claude-sonnet-4-5-20250929",
  google: "google-ai-studio/gemini-3-pro-preview",
  xai: "xai/grok-4-1-fast-reasoning"
};

const DEFAULT_MCP_STATUS: McpServersComponentState = {
  servers: [],
  tools: [],
  prompts: [],
  resources: []
};

function getOrCreateSessionId(): string {
  let sessionId = localStorage.getItem(STORAGE_KEY);
  if (!sessionId) {
    sessionId = nanoid();
    localStorage.setItem(STORAGE_KEY, sessionId);
  }
  return sessionId;
}

const App = () => {
  const [codeVisible, setCodeVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [params, setParams] = useState<PlaygroundState>({
    ...DEFAULT_PARAMS,
    useExternalProvider: false,
    externalProvider: "openai",
    authMethod: "provider-key"
  });

  const [mcp, setMcp] = useState<McpServersComponentState>(DEFAULT_MCP_STATUS);

  const [mcpLogs, setMcpLogs] = useState<
    Array<{ timestamp: number; status: string; serverUrl?: string }>
  >([]);

  const [sessionId, setSessionId] = useState<string>(() =>
    getOrCreateSessionId()
  );

  const agent = useAgent<Playground, PlaygroundState>({
    agent: "playground",
    name: `Cloudflare-AI-Playground-${sessionId}`,
    onError(event) {
      console.error("[App] onError callback triggered with event:", event);
    },
    onStateUpdate(state: PlaygroundState) {
      setParams(state);
    },
    onMcpUpdate(mcpState: MCPServersState) {
      const servers = Object.entries(mcpState.servers || {}).map(
        ([id, server]) => ({
          id,
          name: server.name,
          url: server.server_url,
          state: server.state,
          error: server.error
        })
      );

      setMcp({
        servers,
        tools: mcpState.tools || [],
        prompts: mcpState.prompts || [],
        resources: mcpState.resources || []
      });

      for (const server of servers) {
        if (server.state) {
          setMcpLogs((prev) => {
            const next = [
              ...prev,
              {
                timestamp: Date.now(),
                status: server.state,
                serverUrl: server.url
              }
            ];
            return next.length > MAX_MCP_LOGS
              ? next.slice(-MAX_MCP_LOGS)
              : next;
          });
        }
      }
    }
  });

  // ── State update helper ──
  // Builds the full state from current params, then applies overrides.
  const updateState = (updates: Partial<PlaygroundState>) => {
    agent.setState({
      model: params.useExternalProvider
        ? params.externalModel || params.model
        : params.model,
      temperature: params.temperature,
      stream: params.stream,
      system: params.system,
      useExternalProvider: params.useExternalProvider,
      externalProvider: params.externalProvider,
      externalModel: params.externalModel,
      authMethod: params.authMethod,
      providerApiKey: params.providerApiKey,
      gatewayAccountId: params.gatewayAccountId,
      gatewayId: params.gatewayId,
      gatewayApiKey: params.gatewayApiKey,
      ...updates
    });
  };

  const [agentInput, setAgentInput] = useState("");

  useEffect(() => {
    const getModels = async () => {
      try {
        const models = await agent.stub.getModels();
        setModels(models as Model[]);
      } finally {
        setIsLoadingModels(false);
      }
    };
    getModels();
  }, [agent.stub]);

  const handleAgentSubmit = async (
    e: React.FormEvent | React.KeyboardEvent | React.MouseEvent,
    extraData: Record<string, unknown> = {}
  ) => {
    e.preventDefault();
    if (!agentInput.trim()) return;

    const message = agentInput;
    setAgentInput("");

    await sendMessage(
      { role: "user", parts: [{ type: "text", text: message }] },
      { body: extraData }
    );
  };

  const { messages, clearHistory, status, sendMessage, stop } = useAgentChat<
    PlaygroundState,
    UIMessage<{ createdAt: string }>
  >({
    agent,
    experimental_throttle: 50
  });

  const loading = status === "submitted";
  const streaming = status === "streaming";

  const handleReset = () => {
    const newSessionId = nanoid();
    localStorage.setItem(STORAGE_KEY, newSessionId);
    clearHistory();
    setSessionId(newSessionId);
    setMcp(DEFAULT_MCP_STATUS);
    setMcpLogs([]);
  };

  const messageElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messageElement.current && messages.length > 0) {
      messageElement.current.scrollTop = messageElement.current.scrollHeight;
    }
  }, [messages]);

  const activeModelName = params.useExternalProvider
    ? params.externalModel || params.model
    : (params.model ?? DEFAULT_PARAMS.model);
  const activeModel = params.useExternalProvider
    ? undefined
    : models.find((model) => model.name === activeModelName);

  return (
    <main className="w-full h-full bg-kumo-elevated md:px-6">
      <ViewCodeModal
        params={params}
        messages={messages}
        visible={codeVisible}
        handleHide={(e) => {
          e.stopPropagation();
          setCodeVisible(false);
        }}
      />

      <div className="h-full max-w-[1400px] mx-auto items-start md:pb-[168px]">
        <Header onSetCodeVisible={setCodeVisible} />

        <div className="flex h-full md:pb-8 items-start md:flex-row flex-col">
          {/* ── Left sidebar ── */}
          <div className="md:w-1/3 w-full h-full md:overflow-auto bg-kumo-base md:rounded-md shadow-md md:block z-10">
            <div className="bg-ai h-[3px]" />
            <section className="rounded-lg bg-kumo-base p-4">
              <div className="flex items-center">
                <span className="text-lg font-semibold text-kumo-default">
                  Workers AI LLM Playground
                </span>
                <div className="ml-3 mt-1">
                  <WorkersAILogo />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  onClick={handleReset}
                >
                  Reset
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-2 md:hidden"
                  onClick={() => setSettingsVisible(!settingsVisible)}
                  icon={<GearIcon size={18} />}
                  title="Settings"
                />
              </div>

              <p className="text-kumo-inactive text-sm mt-1 mb-4">
                Explore different Text Generation models by drafting messages
                and fine-tuning your responses.
              </p>

              <div className="md:mb-4">
                <UnifiedModelSelector
                  workersAiModels={models}
                  activeWorkersAiModel={activeModel}
                  isLoadingWorkersAi={isLoadingModels}
                  useExternalProvider={params.useExternalProvider || false}
                  externalProvider={params.externalProvider || "openai"}
                  externalModel={params.externalModel}
                  authMethod={params.authMethod || "provider-key"}
                  providerApiKey={params.providerApiKey}
                  gatewayAccountId={params.gatewayAccountId}
                  gatewayId={params.gatewayId}
                  gatewayApiKey={params.gatewayApiKey}
                  onModeChange={(useExternal) => {
                    const selectedModel = useExternal
                      ? DEFAULT_EXTERNAL_MODELS[
                          params.externalProvider || "openai"
                        ] || params.model
                      : params.model || DEFAULT_PARAMS.model;
                    updateState({
                      model: selectedModel,
                      useExternalProvider: useExternal,
                      externalModel: useExternal ? selectedModel : undefined
                    });
                  }}
                  onWorkersAiModelSelect={(model) => {
                    updateState({
                      model: model ? model.name : DEFAULT_PARAMS.model,
                      useExternalProvider: false,
                      externalModel: undefined
                    });
                  }}
                  onExternalProviderChange={(provider) => {
                    const selectedModel =
                      DEFAULT_EXTERNAL_MODELS[provider] || params.model;
                    updateState({
                      model: selectedModel,
                      useExternalProvider: true,
                      externalProvider: provider,
                      externalModel: selectedModel
                    });
                  }}
                  onExternalModelSelect={(modelId) => {
                    updateState({
                      model: modelId,
                      useExternalProvider: true,
                      externalModel: modelId
                    });
                  }}
                  onAuthMethodChange={(method) => {
                    updateState({
                      useExternalProvider: true,
                      authMethod: method
                    });
                  }}
                  onProviderApiKeyChange={(key) => {
                    updateState({
                      useExternalProvider: true,
                      authMethod: "provider-key",
                      providerApiKey: key
                    });
                  }}
                  onGatewayAccountIdChange={(accountId) => {
                    updateState({
                      useExternalProvider: true,
                      authMethod: "gateway",
                      gatewayAccountId: accountId
                    });
                  }}
                  onGatewayIdChange={(gwId) => {
                    updateState({
                      useExternalProvider: true,
                      authMethod: "gateway",
                      gatewayId: gwId
                    });
                  }}
                  onGatewayApiKeyChange={(apiKey) => {
                    updateState({
                      useExternalProvider: true,
                      authMethod: "gateway",
                      gatewayApiKey: apiKey
                    });
                  }}
                />
              </div>

              <div
                className={`mt-4 md:block ${settingsVisible ? "block" : "hidden"}`}
              >
                <label
                  htmlFor="system-message"
                  className="font-semibold text-sm block mb-1 text-kumo-default"
                >
                  System Message
                </label>
                <TextareaAutosize
                  id="system-message"
                  className="w-full p-2 border border-kumo-line rounded-md resize-none bg-kumo-base text-kumo-default hover:bg-kumo-tint focus:outline-none focus:ring-1 focus:ring-kumo-ring"
                  minRows={4}
                  value={params.system}
                  onChange={(e) => updateState({ system: e.target.value })}
                />
              </div>

              <div
                className={`mt-4 md:block ${settingsVisible ? "block" : "hidden"}`}
              >
                <label
                  htmlFor="temperature"
                  className="font-semibold text-sm block mb-1 text-kumo-default"
                >
                  Temperature
                </label>
                <div className="flex items-center p-2 border border-kumo-line rounded-md">
                  <input
                    id="temperature"
                    className="w-full appearance-none cursor-pointer bg-ai rounded-full h-2 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_#901475]"
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={params.temperature}
                    onChange={(e) =>
                      updateState({
                        temperature: Number.parseFloat(e.target.value)
                      })
                    }
                  />
                  <span className="ml-3 text-md text-kumo-default w-12 text-right">
                    {params.temperature.toFixed(1)}
                  </span>
                </div>
              </div>
            </section>

            <div className="bg-ai h-px mx-2 mt-2 opacity-25" />
            <McpServers agent={agent} mcpState={mcp} mcpLogs={mcpLogs} />
          </div>

          {/* ── Chat panel ── */}
          <div
            ref={messageElement}
            className="md:w-2/3 w-full h-full md:ml-6 md:rounded-lg md:shadow-md bg-kumo-base relative overflow-auto flex flex-col"
          >
            <div className="bg-ai h-[3px] hidden md:block" />
            <ul className="pb-6 px-6 pt-6">
              {messages.map((message) => {
                const renderedParts = message.parts
                  .map((part, i) => {
                    if (part.type === "text") {
                      if (!part.text || part.text.trim() === "") return null;

                      return (
                        <li
                          key={i}
                          className="mb-3 flex items-start border-b border-b-kumo-line w-full py-2"
                        >
                          <div className="mr-3 w-[80px]">
                            <button
                              type="button"
                              className={`px-3 py-2 bg-orange-500/15 hover:bg-orange-500/25 text-kumo-default rounded-lg text-sm capitalize cursor-pointer ${
                                (streaming || loading) && "pointer-events-none"
                              }`}
                            >
                              {message.role}
                            </button>
                          </div>
                          <div className="relative grow">
                            <Streamdown
                              className={`sd-theme rounded-md p-3 w-full resize-none mt-[-6px] hover:bg-kumo-tint ${
                                (streaming || loading) && "pointer-events-none"
                              }`}
                              controls={false}
                              isAnimating={
                                streaming &&
                                message === messages[messages.length - 1]
                              }
                            >
                              {part.text}
                            </Streamdown>
                          </div>
                        </li>
                      );
                    }

                    if (part.type === "reasoning") {
                      if (!part.text || part.text.trim() === "") return null;
                      return (
                        <li key={i} className="mb-3 w-full">
                          <ReasoningCard part={part} />
                        </li>
                      );
                    }

                    if (isToolUIPart(part)) {
                      return (
                        <li key={i} className="mb-3 w-full">
                          <ToolCallCard part={part} />
                        </li>
                      );
                    }

                    if (
                      part.type === "file" &&
                      part.mediaType.startsWith("image/")
                    ) {
                      return (
                        <li key={i} className="mb-3 w-full">
                          <img
                            className="max-w-md mx-auto rounded-lg"
                            src={part.url}
                            alt="Tool call response"
                          />
                        </li>
                      );
                    }

                    return null;
                  })
                  .filter(Boolean);

                if (renderedParts.length === 0) return null;
                return <div key={message.id}>{renderedParts}</div>;
              })}

              {(loading || streaming) &&
              (messages[messages.length - 1].role !== "assistant" ||
                messages[messages.length - 1].parts.length === 0) ? (
                <li className="mb-3 flex items-start border-b border-b-kumo-line w-full py-2">
                  <div className="mr-3 w-[80px]">
                    <button
                      type="button"
                      className="px-3 py-2 bg-orange-500/15 hover:bg-orange-500/25 text-kumo-default rounded-lg text-sm capitalize cursor-pointer pointer-events-none"
                    >
                      Assistant
                    </button>
                  </div>
                  <div className="relative grow flex items-end min-h-[36px]">
                    <div className="rounded-md p-3 w-full hover:bg-kumo-tint pointer-events-none flex items-end gap-1 pb-2">
                      <div
                        className="size-1 rounded-full bg-kumo-inactive animate-bounce"
                        style={{ animationDelay: "0s" }}
                      />
                      <div
                        className="size-1 rounded-full bg-kumo-inactive animate-bounce"
                        style={{ animationDelay: "0.1s" }}
                      />
                      <div
                        className="size-1 rounded-full bg-kumo-inactive animate-bounce"
                        style={{ animationDelay: "0.2s" }}
                      />
                    </div>
                  </div>
                </li>
              ) : null}
            </ul>

            {/* ── Input bar ── */}
            <div className="sticky mt-auto bottom-0 left-0 right-0 bg-kumo-base flex items-center p-5 border-t border-t-kumo-line gap-4">
              <div className="flex-1">
                <TextareaAutosize
                  className="rounded-md p-3 w-full resize-none border border-kumo-line bg-kumo-base text-kumo-default hover:border-kumo-ring focus:outline-none focus:ring-2 focus:ring-kumo-ring focus:border-transparent disabled:bg-kumo-control disabled:cursor-not-allowed"
                  placeholder="Enter a message..."
                  value={agentInput}
                  disabled={loading || streaming}
                  onChange={(e) => setAgentInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleAgentSubmit(e);
                    }
                  }}
                />
              </div>
              <Button
                variant="secondary"
                onClick={() => clearHistory()}
                disabled={streaming || loading}
              >
                Clear
              </Button>
              {loading || streaming ? (
                <Button variant="destructive" onClick={stop}>
                  Stop
                </Button>
              ) : (
                <button
                  type="button"
                  disabled={!agentInput.trim()}
                  onClick={(e) => handleAgentSubmit(e)}
                  className={`bg-ai-loop bg-size-[200%_100%] hover:animate-gradient-background ${
                    !agentInput.trim() ? "opacity-50 cursor-not-allowed" : ""
                  } text-white rounded-md shadow-md py-2 px-6 flex items-center`}
                >
                  Run
                  <div className="ml-2 mt-[2px]">
                    <SparkleIcon />
                  </div>
                </button>
              )}
            </div>
          </div>
        </div>

        <Footer />
      </div>
    </main>
  );
};

export default App;
