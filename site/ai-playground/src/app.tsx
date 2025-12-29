import { useEffect, useRef, useState } from "react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import TextareaAutosize from "react-textarea-autosize";
import Footer from "./components/Footer";
import Header from "./components/Header";
import { SparkleIcon } from "./components/Icons";
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
const DEFAULT_PARAMS = {
  model: "@cf/qwen/qwen3-30b-a3b-fp8",
  temperature: 0,
  stream: true,
  system:
    "You are a helpful assistant that can do various tasks using MCP tools."
};
const DEFAULT_MCP_STATUS: McpServersComponentState = {
  servers: [],
  tools: [],
  prompts: [],
  resources: []
};

/**
 * Get or create a session ID for this user.
 * The session ID is stored in localStorage and persists across browser sessions.
 */
function getOrCreateSessionId(): string {
  let sessionId = localStorage.getItem(STORAGE_KEY);

  if (!sessionId) {
    sessionId = nanoid();
    localStorage.setItem(STORAGE_KEY, sessionId);
  }

  return sessionId;
}

/**
 * Generate a new session ID and store it in localStorage.
 */
function generateNewSessionId(): string {
  const newSessionId = nanoid();
  localStorage.setItem(STORAGE_KEY, newSessionId);
  return newSessionId;
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
      setParams((prev) => ({
        ...prev,
        model: state.model,
        temperature: state.temperature,
        stream: state.stream,
        system: state.system,
        useExternalProvider: state.useExternalProvider,
        externalProvider: state.externalProvider,
        externalModel: state.externalModel,
        authMethod: state.authMethod,
        providerApiKey: state.providerApiKey,
        gatewayAccountId: state.gatewayAccountId,
        gatewayId: state.gatewayId,
        gatewayApiKey: state.gatewayApiKey
      }));
    },
    onMcpUpdate(mcpState: MCPServersState) {
      // The SDK returns: { servers: { [id]: { state, name, ... } }, tools, prompts, resources }
      // Transform servers object to array for the McpServers component
      const servers = Object.entries(mcpState.servers || {}).map(
        ([id, server]) => ({
          id,
          name: server.name,
          url: server.server_url,
          state: server.state
        })
      );

      const transformedState: McpServersComponentState = {
        servers,
        tools: mcpState.tools || [],
        prompts: mcpState.prompts || [],
        resources: mcpState.resources || []
      };

      setMcp(transformedState);

      // Log state changes for any server
      for (const server of servers) {
        if (server.state) {
          setMcpLogs((prev) => [
            ...prev,
            {
              timestamp: Date.now(),
              status: server.state,
              serverUrl: server.url
            }
          ]);
        }
      }
    }
  });

  const [agentInput, setAgentInput] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: Only run once on mount
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
  }, []);

  const handleAgentInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setAgentInput(e.target.value);
  };

  const handleAgentSubmit = async (
    e: React.FormEvent | React.KeyboardEvent | React.MouseEvent,
    extraData: Record<string, unknown> = {}
  ) => {
    e.preventDefault();
    if (!agentInput.trim()) return;

    const message = agentInput;
    setAgentInput("");

    // Send message to agent
    await sendMessage(
      {
        role: "user",
        parts: [{ type: "text", text: message }]
      },
      {
        body: extraData
      }
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
    // Generate and store new session ID
    const newSessionId = generateNewSessionId();

    // Clear conversation history
    clearHistory();

    // Update session ID state (triggers reconnection with new ID)
    setSessionId(newSessionId);
    setMcp(DEFAULT_MCP_STATUS);
    setMcpLogs([]);
  };

  const messageElement = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messageElement.current && messages.length > 0) {
      messageElement.current.scrollTop = messageElement.current.scrollHeight;
    }
  }, [messages]);

  // Determine active model based on mode
  const activeModelName = params.useExternalProvider
    ? params.externalModel || params.model
    : (params.model ?? DEFAULT_PARAMS.model);
  const activeModel = params.useExternalProvider
    ? undefined
    : models.find((model) => model.name === activeModelName);

  return (
    <main className="w-full h-full bg-gray-50 md:px-6">
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
          <div className="md:w-1/3 w-full h-full md:overflow-auto bg-white md:rounded-md shadow-md md:block z-10">
            <div className="bg-ai h-[3px]" />
            <section className="rounded-lg bg-white p-4">
              <div className="flex align-middle items-center">
                <span className="text-lg font-semibold">
                  Workers AI LLM Playground
                </span>
                <div className="ml-3 mt-1">
                  <svg
                    width="20"
                    height="19"
                    viewBox="0 0 20 19"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <title>Workers AI Logo</title>
                    <path
                      d="M12.5308 1.03827L12.6216 1.59529C13.1993 5.14062 16.1116 7.84036 19.6905 8.14824C16.1135 8.45595 13.2049 11.1586 12.6359 14.7035L12.5308 15.3581L12.4257 14.7035C11.8567 11.1586 8.94812 8.45595 5.37109 8.14824C8.94997 7.84036 11.8623 5.14062 12.44 1.59529L12.5308 1.03827Z"
                      fill="url(#paint0_linear_1012_8647)"
                    />
                    <path
                      d="M2.92921 0.712708L2.96222 0.915259C3.1723 2.20447 4.23133 3.1862 5.53274 3.29815C4.232 3.41005 3.17434 4.39284 2.96742 5.68188L2.92921 5.91992L2.891 5.68188C2.68409 4.39284 1.62642 3.41005 0.325684 3.29815C1.62709 3.1862 2.68612 2.20447 2.89621 0.915259L2.92921 0.712708Z"
                      fill="url(#paint1_linear_1012_8647)"
                    />
                    <path
                      d="M2.92897 12.4291L2.9661 12.6569C3.20245 14.1073 4.39385 15.2118 5.85794 15.3377C4.39461 15.4636 3.20474 16.5692 2.97196 18.0194L2.92897 18.2872L2.88598 18.0194C2.6532 16.5692 1.46333 15.4636 0 15.3377C1.46409 15.2118 2.65549 14.1073 2.89184 12.6569L2.92897 12.4291Z"
                      fill="url(#paint2_linear_1012_8647)"
                    />
                    <defs>
                      <linearGradient
                        id="paint0_linear_1012_8647"
                        x1="5.37109"
                        y1="9.74315"
                        x2="19.7084"
                        y2="5.85333"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#901475" />
                        <stop offset="0.505208" stopColor="#CE2F55" />
                        <stop offset="1" stopColor="#FF6633" />
                      </linearGradient>
                      <linearGradient
                        id="paint1_linear_1012_8647"
                        x1="0.325684"
                        y1="3.87812"
                        x2="5.53925"
                        y2="2.46364"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#901475" />
                        <stop offset="0.505208" stopColor="#CE2F55" />
                        <stop offset="1" stopColor="#FF6633" />
                      </linearGradient>
                      <linearGradient
                        id="paint2_linear_1012_8647"
                        x1="-5.51246e-08"
                        y1="15.9902"
                        x2="5.86526"
                        y2="14.3989"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#901475" />
                        <stop offset="0.505208" stopColor="#CE2F55" />
                        <stop offset="1" stopColor="#FF6633" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
                <button
                  type="button"
                  className="ml-auto rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50 transition-colors"
                  onClick={handleReset}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="ml-2 rounded-md border border-gray-200 px-2 py-1 -mt-1 md:hidden"
                  onClick={() => setSettingsVisible(!settingsVisible)}
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 22 22"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <title>Settings</title>
                    <path
                      d="M11.0001 7.5625C10.3202 7.5625 9.65558 7.76411 9.09029 8.14182C8.52499 8.51954 8.0844 9.05641 7.82422 9.68453C7.56405 10.3126 7.49597 11.0038 7.62861 11.6706C7.76125 12.3374 8.08864 12.9499 8.56938 13.4307C9.05012 13.9114 9.66263 14.2388 10.3294 14.3714C10.9962 14.5041 11.6874 14.436 12.3155 14.1758C12.9437 13.9157 13.4805 13.4751 13.8582 12.9098C14.236 12.3445 14.4376 11.6799 14.4376 11C14.4376 10.0883 14.0754 9.21398 13.4307 8.56932C12.7861 7.92466 11.9117 7.5625 11.0001 7.5625ZM11.0001 13.0625C10.5921 13.0625 10.1934 12.9415 9.8542 12.7149C9.51502 12.4883 9.25066 12.1662 9.09456 11.7893C8.93845 11.4124 8.89761 10.9977 8.97719 10.5976C9.05677 10.1975 9.2532 9.83004 9.54165 9.54159C9.8301 9.25315 10.1976 9.05671 10.5977 8.97713C10.9978 8.89755 11.4125 8.93839 11.7893 9.0945C12.1662 9.2506 12.4883 9.51496 12.715 9.85414C12.9416 10.1933 13.0626 10.5921 13.0626 11C13.0626 11.547 12.8453 12.0716 12.4585 12.4584C12.0717 12.8452 11.5471 13.0625 11.0001 13.0625Z"
                      fill="#797979"
                    />
                    <path
                      d="M17.1532 11L19.7107 8.52844L17.4832 4.67156L14.1351 5.63062L13.2379 2.0625H8.76912L7.90631 5.63062L4.53756 4.67156L2.31006 8.53187L4.88131 11.0172L2.31006 13.5059L4.53756 17.3628L7.90631 16.4003L8.78287 19.9375H13.2516L14.1351 16.4106L17.5244 17.38L19.7554 13.5231L17.1532 11ZM16.8438 15.7472L13.8429 14.8844L12.9216 15.5203L12.1654 18.5625H9.85537L9.09912 15.5375L8.20881 14.8844L5.19068 15.7472L4.03568 13.75L6.28381 11.5775V10.4637L4.03568 8.28781L5.19068 6.28719L8.21225 7.15344L9.10256 6.44187L9.85537 3.4375H12.1654L12.9216 6.45563L13.8085 7.16719L16.8438 6.28719L17.9988 8.28781L15.7472 10.4637L15.7816 11.5741L18.0126 13.75L16.8438 15.7472Z"
                      fill="#797979"
                    />
                  </svg>
                </button>
              </div>

              <p className="text-gray-400 text-sm mt-1 mb-4">
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
                    const defaultModels: Record<string, string> = {
                      openai: "openai/gpt-5.2",
                      anthropic: "anthropic/claude-sonnet-4-5-20250929",
                      google: "google-ai-studio/gemini-3-pro-preview",
                      xai: "xai/grok-4-1-fast-reasoning"
                    };
                    const selectedModel = useExternal
                      ? defaultModels[params.externalProvider || "openai"] ||
                        params.model
                      : params.model || DEFAULT_PARAMS.model;
                    agent.setState({
                      model: selectedModel,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: params.system,
                      useExternalProvider: useExternal,
                      externalProvider: params.externalProvider || "openai",
                      externalModel: useExternal ? selectedModel : undefined,
                      authMethod: params.authMethod || "provider-key",
                      providerApiKey: params.providerApiKey,
                      gatewayAccountId: params.gatewayAccountId,
                      gatewayId: params.gatewayId,
                      gatewayApiKey: params.gatewayApiKey
                    });
                  }}
                  onWorkersAiModelSelect={(model) => {
                    agent.setState({
                      model: model ? model.name : DEFAULT_PARAMS.model,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: params.system,
                      useExternalProvider: false,
                      externalProvider: params.externalProvider,
                      externalModel: undefined,
                      authMethod: params.authMethod,
                      providerApiKey: params.providerApiKey,
                      gatewayAccountId: params.gatewayAccountId,
                      gatewayId: params.gatewayId,
                      gatewayApiKey: params.gatewayApiKey
                    });
                  }}
                  onExternalProviderChange={(provider) => {
                    const defaultModels: Record<string, string> = {
                      openai: "openai/gpt-5.2",
                      anthropic: "anthropic/claude-sonnet-4-5-20250929",
                      google: "google-ai-studio/gemini-3-pro-preview",
                      xai: "xai/grok-4-1-fast-reasoning"
                    };
                    const selectedModel =
                      defaultModels[provider] || params.model;
                    agent.setState({
                      model: selectedModel,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: params.system,
                      useExternalProvider: true,
                      externalProvider: provider,
                      externalModel: selectedModel,
                      authMethod: params.authMethod || "provider-key",
                      providerApiKey: params.providerApiKey,
                      gatewayAccountId: params.gatewayAccountId,
                      gatewayId: params.gatewayId,
                      gatewayApiKey: params.gatewayApiKey
                    });
                  }}
                  onExternalModelSelect={(modelId) => {
                    agent.setState({
                      model: modelId,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: params.system,
                      useExternalProvider: true,
                      externalProvider: params.externalProvider || "openai",
                      externalModel: modelId,
                      authMethod: params.authMethod || "provider-key",
                      providerApiKey: params.providerApiKey,
                      gatewayAccountId: params.gatewayAccountId,
                      gatewayId: params.gatewayId,
                      gatewayApiKey: params.gatewayApiKey
                    });
                  }}
                  onAuthMethodChange={(method) => {
                    agent.setState({
                      model: params.externalModel || params.model,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: params.system,
                      useExternalProvider: true,
                      externalProvider: params.externalProvider || "openai",
                      externalModel: params.externalModel,
                      authMethod: method,
                      providerApiKey: params.providerApiKey,
                      gatewayAccountId: params.gatewayAccountId,
                      gatewayId: params.gatewayId,
                      gatewayApiKey: params.gatewayApiKey
                    });
                  }}
                  onProviderApiKeyChange={(key) => {
                    agent.setState({
                      model: params.externalModel || params.model,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: params.system,
                      useExternalProvider: true,
                      externalProvider: params.externalProvider || "openai",
                      externalModel: params.externalModel,
                      authMethod: "provider-key",
                      providerApiKey: key,
                      gatewayAccountId: params.gatewayAccountId,
                      gatewayId: params.gatewayId,
                      gatewayApiKey: params.gatewayApiKey
                    });
                  }}
                  onGatewayAccountIdChange={(accountId) => {
                    agent.setState({
                      model: params.externalModel || params.model,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: params.system,
                      useExternalProvider: true,
                      externalProvider: params.externalProvider || "openai",
                      externalModel: params.externalModel,
                      authMethod: "gateway",
                      providerApiKey: params.providerApiKey,
                      gatewayAccountId: accountId,
                      gatewayId: params.gatewayId,
                      gatewayApiKey: params.gatewayApiKey
                    });
                  }}
                  onGatewayIdChange={(gatewayId) => {
                    agent.setState({
                      model: params.externalModel || params.model,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: params.system,
                      useExternalProvider: true,
                      externalProvider: params.externalProvider || "openai",
                      externalModel: params.externalModel,
                      authMethod: "gateway",
                      providerApiKey: params.providerApiKey,
                      gatewayAccountId: params.gatewayAccountId,
                      gatewayId: gatewayId,
                      gatewayApiKey: params.gatewayApiKey
                    });
                  }}
                  onGatewayApiKeyChange={(apiKey) => {
                    agent.setState({
                      model: params.externalModel || params.model,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: params.system,
                      useExternalProvider: true,
                      externalProvider: params.externalProvider || "openai",
                      externalModel: params.externalModel,
                      authMethod: "gateway",
                      providerApiKey: params.providerApiKey,
                      gatewayAccountId: params.gatewayAccountId,
                      gatewayId: params.gatewayId,
                      gatewayApiKey: apiKey
                    });
                  }}
                />
              </div>

              <div
                className={`mt-4 md:block ${settingsVisible ? "block" : "hidden"}`}
              >
                {/* biome-ignore lint/a11y/noLabelWithoutControl: eh */}
                <label className="font-semibold text-sm block mb-1">
                  System Message
                </label>
                <TextareaAutosize
                  className="w-full p-2 border border-gray-200 rounded-md resize-none hover:bg-gray-50"
                  minRows={4}
                  value={params.system}
                  onChange={(e) => {
                    const newSystem = e.target.value;
                    agent.setState({
                      model: params.useExternalProvider
                        ? params.externalModel || params.model
                        : params.model,
                      temperature: params.temperature,
                      stream: params.stream,
                      system: newSystem,
                      useExternalProvider: params.useExternalProvider,
                      externalProvider: params.externalProvider,
                      externalModel: params.externalModel,
                      authMethod: params.authMethod,
                      providerApiKey: params.providerApiKey,
                      gatewayAccountId: params.gatewayAccountId,
                      gatewayId: params.gatewayId,
                      gatewayApiKey: params.gatewayApiKey
                    });
                  }}
                />
              </div>

              <div
                className={`mt-4 md:block ${settingsVisible ? "block" : "hidden"}`}
              >
                {/* biome-ignore lint/a11y/noLabelWithoutControl: eh */}
                <label className="font-semibold text-sm block mb-1">
                  Temperature
                </label>
                <div className="flex items-center p-2 border border-gray-200 rounded-md">
                  <input
                    className="w-full appearance-none cursor-pointer bg-ai rounded-full h-2 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_#901475]"
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={params.temperature}
                    onChange={async (e) => {
                      const temperature = Number.parseFloat(e.target.value);
                      agent.setState({
                        model: params.useExternalProvider
                          ? params.externalModel || params.model
                          : params.model,
                        temperature,
                        stream: params.stream,
                        system: params.system,
                        useExternalProvider: params.useExternalProvider,
                        externalProvider: params.externalProvider,
                        externalModel: params.externalModel,
                        authMethod: params.authMethod,
                        providerApiKey: params.providerApiKey,
                        gatewayAccountId: params.gatewayAccountId,
                        gatewayId: params.gatewayId,
                        gatewayApiKey: params.gatewayApiKey
                      });
                    }}
                  />
                  <span className="ml-3 text-md text-gray-800 w-12 text-right">
                    {params.temperature.toFixed(1)}
                  </span>
                </div>
              </div>

              <div className="mb-4 hidden">
                {/* biome-ignore lint/a11y/noLabelWithoutControl: eh */}
                <label className="text-gray-600 text-sm block mb-1">
                  Streaming
                </label>
                <div className="p-2 border border-gray-200 rounded-md">
                  <input
                    type="checkbox"
                    checked={params.stream}
                    onChange={(e) => {
                      agent.setState({
                        model: params.useExternalProvider
                          ? params.externalModel || params.model
                          : params.model,
                        temperature: params.temperature,
                        stream: e.target.checked,
                        system: params.system,
                        useExternalProvider: params.useExternalProvider,
                        externalProvider: params.externalProvider,
                        externalModel: params.externalModel,
                        authMethod: params.authMethod,
                        providerApiKey: params.providerApiKey,
                        gatewayAccountId: params.gatewayAccountId,
                        gatewayId: params.gatewayId,
                        gatewayApiKey: params.gatewayApiKey
                      });
                    }}
                  />
                </div>
              </div>
            </section>

            <div className="bg-ai h-px mx-2 mt-2 opacity-25" />
            <McpServers agent={agent} mcpState={mcp} mcpLogs={mcpLogs} />
          </div>

          <div
            ref={messageElement}
            className="md:w-2/3 w-full h-full md:ml-6 md:rounded-lg md:shadow-md bg-white relative overflow-auto flex flex-col"
          >
            <div className="bg-ai h-[3px] hidden md:block" />
            <ul className="pb-6 px-6 pt-6">
              {messages.map((message) => {
                const renderedParts = message.parts
                  .map((part, i) => {
                    // Render text messages
                    if (part.type === "text") {
                      // Skip empty text parts (e.g., when message only contains tool calls)
                      if (!part.text || part.text.trim() === "") {
                        return null;
                      }

                      return (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: it's fine
                          key={i}
                          className="mb-3 flex items-start border-b border-b-gray-100 w-full py-2"
                        >
                          <div className="mr-3 w-[80px]">
                            <button
                              type="button"
                              className={`px-3 py-2 bg-orange-100 hover:bg-orange-200 rounded-lg text-sm capitalize cursor-pointer ${
                                (streaming || loading) && "pointer-events-none"
                              }`}
                            >
                              {message.role}
                            </button>
                          </div>
                          <div className="relative grow">
                            <Streamdown
                              className={`rounded-md p-3 w-full resize-none mt-[-6px] hover:bg-gray-50 ${
                                (streaming || loading) && "pointer-events-none"
                              }`}
                            >
                              {part.text}
                            </Streamdown>
                          </div>
                        </li>
                      );
                    }

                    // Render reasoning
                    if (part.type === "reasoning") {
                      // Skip empty reasoning parts
                      if (!part.text || part.text.trim() === "") {
                        return null;
                      }

                      return (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: it's fine
                          key={i}
                          className="mb-3 w-full"
                        >
                          <ReasoningCard part={part} />
                        </li>
                      );
                    }

                    // Render tool calls
                    if (isToolUIPart(part)) {
                      return (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: it's fine
                          key={i}
                          className="mb-3 w-full"
                        >
                          <ToolCallCard part={part} />
                        </li>
                      );
                    }

                    // Render file messages (images)
                    if (
                      part.type === "file" &&
                      part.mediaType.startsWith("image/")
                    ) {
                      return (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: it's fine
                          key={i}
                          className="mb-3 w-full"
                        >
                          <img
                            className="max-w-md mx-auto rounded-lg"
                            src={part.url}
                            // biome-ignore lint/a11y/noRedundantAlt: it's fine
                            alt="Image from tool call response"
                          />
                        </li>
                      );
                    }

                    return null;
                  })
                  .filter(Boolean);

                // Only render the message wrapper if there are actual parts to show
                if (renderedParts.length === 0) {
                  return null;
                }

                return <div key={message.id}>{renderedParts}</div>;
              })}

              {(loading || streaming) &&
              (messages[messages.length - 1].role !== "assistant" ||
                messages[messages.length - 1].parts.length === 0) ? (
                <li className="mb-3 flex items-start border-b border-b-gray-100 w-full py-2">
                  <div className="mr-3 w-[80px]">
                    <button
                      type="button"
                      className="px-3 py-2 bg-orange-100 hover:bg-orange-200 rounded-lg text-sm capitalize cursor-pointer pointer-events-none"
                    >
                      Assistant
                    </button>
                  </div>
                  <div className="relative grow flex items-end min-h-[36px]">
                    <div className="rounded-md p-3 w-full hover:bg-gray-50 pointer-events-none flex items-end gap-1 pb-2">
                      <div
                        className="size-1 rounded-full bg-gray-400 animate-bounce"
                        style={{ animationDelay: "0s" }}
                      />
                      <div
                        className="size-1 rounded-full bg-gray-400 animate-bounce"
                        style={{ animationDelay: "0.1s" }}
                      />
                      <div
                        className="size-1 rounded-full bg-gray-400 animate-bounce"
                        style={{ animationDelay: "0.2s" }}
                      />
                    </div>
                  </div>
                </li>
              ) : null}
            </ul>

            <div className="sticky mt-auto bottom-0 left-0 right-0 bg-white flex items-center p-5 border-t border-t-gray-200 gap-4">
              <div className="flex-1">
                <TextareaAutosize
                  className="rounded-md p-3 w-full resize-none border border-gray-300 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-300 focus:border-transparent disabled:bg-gray-50 disabled:cursor-not-allowed"
                  placeholder="Enter a message..."
                  value={agentInput}
                  disabled={loading || streaming}
                  onChange={handleAgentInputChange}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleAgentSubmit(e);
                    }
                  }}
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  clearHistory();
                }}
                className={`text-gray-500 hover:text-violet-900 ${
                  (streaming || loading) && "pointer-events-none opacity-50"
                }`}
              >
                Clear
              </button>
              {loading || streaming ? (
                <button
                  type="button"
                  onClick={stop}
                  className="bg-red-500 hover:bg-red-600 text-white rounded-md shadow-md py-2 px-6 flex items-center"
                >
                  Stop
                </button>
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
