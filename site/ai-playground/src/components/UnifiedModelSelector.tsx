import { useCombobox } from "downshift";
import { useEffect, useRef, useState } from "react";
import { SpinnerIcon, EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import ModelRow from "./ModelRow";
import type { Model } from "../models";

type GatewayProvider = "openai" | "anthropic" | "google" | "xai";
type AuthMethod = "provider-key" | "gateway";

// Latest external provider models for each provider (top 5)
const EXTERNAL_MODELS: Record<
  GatewayProvider,
  Array<{ id: string; name: string; description: string }>
> = {
  openai: [
    {
      id: "openai/gpt-5.2",
      name: "gpt-5.2",
      description:
        "Premier model for coding and agentic tasks across industries"
    },
    {
      id: "openai/gpt-5.2-pro",
      name: "gpt-5.2-pro",
      description: "Enhanced GPT-5.2 with smarter and more precise responses"
    },
    {
      id: "openai/gpt-5-mini",
      name: "gpt-5-mini",
      description:
        "Faster, cost-efficient version of GPT-5, ideal for well-defined tasks"
    },
    {
      id: "openai/gpt-5-nano",
      name: "gpt-5-nano",
      description: "Fastest and most cost-efficient version of GPT-5"
    },
    {
      id: "openai/gpt-5",
      name: "gpt-5",
      description: "Intelligent reasoning model for coding and agentic tasks"
    }
  ],
  anthropic: [
    {
      id: "anthropic/claude-sonnet-4-5-20250929",
      name: "claude-sonnet-4-5-20250929",
      description:
        "Recommended: Best balance of intelligence, speed, and cost. Excellent for coding and agentic tasks"
    },
    {
      id: "anthropic/claude-opus-4-5-20251101",
      name: "claude-opus-4-5-20251101",
      description:
        "Premium model combining maximum intelligence with practical performance"
    },
    {
      id: "anthropic/claude-haiku-4-5-20251001",
      name: "claude-haiku-4-5-20251001",
      description:
        "Fastest model with near-frontier intelligence, optimized for real-time interactions"
    },
    {
      id: "anthropic/claude-opus-4-1-20250805",
      name: "claude-opus-4-1-20250805",
      description:
        "Legacy: Advanced model for complex reasoning tasks (migrate to Opus 4.5)"
    },
    {
      id: "anthropic/claude-sonnet-4-20250514",
      name: "claude-sonnet-4-20250514",
      description:
        "Legacy: High-performance balanced model (migrate to Sonnet 4.5)"
    }
  ],
  google: [
    {
      id: "google-ai-studio/gemini-3-pro-preview",
      name: "gemini-3-pro-preview",
      description:
        "Most intelligent model for multimodal understanding, best for agentic and vibe-coding tasks"
    },
    {
      id: "google-ai-studio/gemini-3-flash-preview",
      name: "gemini-3-flash-preview",
      description:
        "Most intelligent model built for speed, combining frontier intelligence with superior search"
    },
    {
      id: "google-ai-studio/gemini-2.5-pro",
      name: "gemini-2.5-pro",
      description:
        "State-of-the-art thinking model for complex problems in code, math, and STEM"
    },
    {
      id: "google-ai-studio/gemini-2.5-flash",
      name: "gemini-2.5-flash",
      description:
        "Best price-performance model, well-rounded capabilities for large-scale processing"
    },
    {
      id: "google-ai-studio/gemini-2.5-flash-lite",
      name: "gemini-2.5-flash-lite",
      description:
        "Fastest flash model optimized for cost-efficiency and high throughput"
    }
  ],
  xai: [
    {
      id: "xai/grok-4-1-fast-reasoning",
      name: "grok-4-1-fast-reasoning",
      description:
        "Advanced reasoning capabilities with a 2 million token context window"
    },
    {
      id: "xai/grok-4-1-fast-non-reasoning",
      name: "grok-4-1-fast-non-reasoning",
      description: "Optimized for speed with a 2 million token context window"
    },
    {
      id: "xai/grok-3",
      name: "grok-3",
      description: "Standard model with a 256k token context window"
    },
    {
      id: "xai/grok-3-mini",
      name: "grok-3-mini",
      description: "Smaller, faster variant with a 256k token context window"
    },
    {
      id: "xai/grok-2-vision-1212",
      name: "grok-2-vision-1212",
      description: "Supports image input with a 131,072 token context window"
    }
  ]
};

type FilterState = {
  [key: string]: "show" | "hide" | null;
};

interface UnifiedModelSelectorProps {
  workersAiModels: Model[];
  activeWorkersAiModel: Model | undefined;
  isLoadingWorkersAi: boolean;
  useExternalProvider: boolean;
  externalProvider: GatewayProvider;
  externalModel: string | undefined;
  authMethod: AuthMethod;
  providerApiKey?: string;
  gatewayAccountId?: string;
  gatewayId?: string;
  gatewayApiKey?: string;
  onModeChange: (useExternal: boolean) => void;
  onWorkersAiModelSelect: (model: Model | null) => void;
  onExternalProviderChange: (provider: GatewayProvider) => void;
  onExternalModelSelect: (modelId: string) => void;
  onAuthMethodChange: (method: AuthMethod) => void;
  onProviderApiKeyChange: (key: string) => void;
  onGatewayAccountIdChange: (id: string) => void;
  onGatewayIdChange: (id: string) => void;
  onGatewayApiKeyChange: (key: string) => void;
}

const UnifiedModelSelector = ({
  workersAiModels,
  activeWorkersAiModel,
  isLoadingWorkersAi,
  useExternalProvider,
  externalProvider,
  externalModel,
  authMethod,
  providerApiKey,
  gatewayAccountId,
  gatewayId,
  gatewayApiKey,
  onModeChange,
  onWorkersAiModelSelect,
  onExternalProviderChange,
  onExternalModelSelect,
  onAuthMethodChange,
  onProviderApiKeyChange,
  onGatewayAccountIdChange,
  onGatewayIdChange,
  onGatewayApiKeyChange
}: UnifiedModelSelectorProps) => {
  const [showProviderKey, setShowProviderKey] = useState(false);
  const [showGatewayKey, setShowGatewayKey] = useState(false);
  const [inputItems, setInputItems] = useState(workersAiModels);
  const [inputValue, setInputValue] = useState("");
  const [selectedItem, setSelectedItem] = useState<Model | null>(
    activeWorkersAiModel || null
  );
  const [filterState, setFilterState] = useState<FilterState>(() => {
    const storedFilters = sessionStorage.getItem("modelFilters");
    if (storedFilters) {
      try {
        return JSON.parse(storedFilters);
      } catch (e) {
        console.error("Failed to parse stored filters", e);
      }
    }
    return { Beta: null, LoRA: null, MCP: "show" };
  });

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!useExternalProvider) {
      setInputItems(workersAiModels);
      setSelectedItem(activeWorkersAiModel || null);
    }
  }, [workersAiModels, activeWorkersAiModel, useExternalProvider]);

  useEffect(() => {
    if (useExternalProvider) return;

    let filteredItems = workersAiModels;
    if (inputValue) {
      filteredItems = filteredItems.filter((model) =>
        model.name.includes(inputValue)
      );
    }
    for (const [tag, state] of Object.entries(filterState)) {
      if (state === "show") {
        filteredItems = filteredItems.filter((model) =>
          model.properties.some((prop) => {
            if (
              tag === "Beta" &&
              prop.property_id === "beta" &&
              prop.value === "true"
            )
              return true;
            if (
              tag === "LoRA" &&
              prop.property_id === "lora" &&
              prop.value === "true"
            )
              return true;
            if (
              tag === "MCP" &&
              prop.property_id === "function_calling" &&
              prop.value === "true"
            )
              return true;
            return false;
          })
        );
      } else if (state === "hide") {
        filteredItems = filteredItems.filter(
          (model) =>
            !model.properties.some((prop) => {
              if (
                tag === "Beta" &&
                prop.property_id === "beta" &&
                prop.value === "true"
              )
                return true;
              if (
                tag === "LoRA" &&
                prop.property_id === "lora" &&
                prop.value === "true"
              )
                return true;
              if (
                tag === "MCP" &&
                prop.property_id === "function_calling" &&
                prop.value === "true"
              )
                return true;
              return false;
            })
        );
      }
    }
    setInputItems(filteredItems);
    sessionStorage.setItem("modelFilters", JSON.stringify(filterState));
  }, [filterState, inputValue, workersAiModels, useExternalProvider]);

  const toggleFilter = (tag: string, event: React.MouseEvent) => {
    setFilterState((prev) => {
      const currentState = prev[tag];
      let newState = { ...prev };
      if (!event.shiftKey && currentState === null) {
        newState = Object.keys(prev).reduce((acc, key) => {
          acc[key] = null;
          return acc;
        }, {} as FilterState);
      }
      if (currentState === null) newState[tag] = "show";
      else if (currentState === "show") newState[tag] = "hide";
      else newState[tag] = null;
      return newState;
    });
  };

  const {
    isOpen,
    getToggleButtonProps,
    getLabelProps,
    getMenuProps,
    getInputProps,
    highlightedIndex,
    getItemProps
  } = useCombobox({
    inputValue,
    items: inputItems,
    itemToString: (item) => item?.name || "",
    onInputValueChange: ({ inputValue, type }) => {
      if (type === useCombobox.stateChangeTypes.InputChange) {
        setInputValue(inputValue || "");
      }
    },
    onSelectedItemChange: ({ selectedItem: newSelectedItem }) => {
      onWorkersAiModelSelect(newSelectedItem);
      setSelectedItem(newSelectedItem);
      inputRef.current?.blur();
    }
  });

  const externalModels = EXTERNAL_MODELS[externalProvider] || [];

  return (
    <div className="space-y-3">
      {/* Mode Toggle */}
      <div className="flex items-center gap-2 p-2 bg-kumo-control rounded-md">
        <button
          type="button"
          onClick={() => onModeChange(false)}
          className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
            !useExternalProvider
              ? "bg-kumo-base shadow-sm border border-kumo-line text-kumo-default"
              : "text-kumo-secondary hover:text-kumo-default"
          }`}
        >
          Workers AI
        </button>
        <button
          type="button"
          onClick={() => onModeChange(true)}
          className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
            useExternalProvider
              ? "bg-kumo-base shadow-sm border border-kumo-line text-kumo-default"
              : "text-kumo-secondary hover:text-kumo-default"
          }`}
        >
          Other Providers
        </button>
      </div>

      {!useExternalProvider ? (
        /* Workers AI Model Selector */
        <div className="relative">
          <div className="mb-1">
            <div className="flex justify-between items-center mb-1">
              <label
                htmlFor="model"
                {...getLabelProps()}
                className="font-semibold text-sm text-kumo-default"
              >
                Model
              </label>
              <div className="flex space-x-1 min-h-[26px]">
                {!isLoadingWorkersAi &&
                  Object.keys(filterState).map((tag) => (
                    <button
                      type="button"
                      key={tag}
                      onClick={(e) => toggleFilter(tag, e)}
                      className={`text-[10px] px-2 py-1 rounded-full border ${
                        filterState[tag] === "show"
                          ? "bg-green-500/10 border-green-400 text-green-700"
                          : filterState[tag] === "hide"
                            ? "bg-red-500/10 border-red-400 text-red-700"
                            : "bg-transparent border-transparent text-kumo-inactive"
                      }`}
                    >
                      {tag}
                      {filterState[tag] === "show" && " ✓"}
                      {filterState[tag] === "hide" && " ✗"}
                    </button>
                  ))}
              </div>
            </div>
          </div>
          <div className="bg-kumo-base flex items-center justify-between cursor-pointer w-full border border-kumo-line p-3 rounded-md relative">
            <input
              className="absolute left-3 top-3 right-3 bg-transparent outline-none text-kumo-default"
              placeholder={isLoadingWorkersAi ? "Fetching models..." : ""}
              {...getInputProps({ ref: inputRef })}
              onBlur={() => setInputValue("")}
              disabled={isLoadingWorkersAi}
            />
            <div className="flex-1 min-h-[24px]">
              {!isLoadingWorkersAi && !inputValue && selectedItem && (
                <ModelRow model={selectedItem} />
              )}
            </div>
            <span
              className="shrink-0 px-2 text-kumo-secondary"
              {...(isLoadingWorkersAi ? {} : getToggleButtonProps())}
            >
              {isLoadingWorkersAi ? (
                <SpinnerIcon
                  size={20}
                  className="animate-spin text-kumo-inactive"
                />
              ) : isOpen ? (
                <>&#8593;</>
              ) : (
                <>&#8595;</>
              )}
            </span>
          </div>
          {selectedItem && !isOpen && (
            <div className="p-2 bg-kumo-tint rounded-md mt-2">
              <p className="text-sm leading-relaxed text-kumo-secondary">
                {selectedItem.description}
              </p>
            </div>
          )}
          <ul
            className={`absolute left-0 right-0 bg-kumo-base mt-1 border border-kumo-line px-2 py-2 rounded-md shadow-lg max-h-80 overflow-scroll z-50 ${
              !isOpen && "hidden"
            }`}
            {...getMenuProps()}
          >
            {isOpen && inputItems.length === 0 && (
              <li className="py-2 px-3 flex flex-col rounded-md text-kumo-secondary">
                No models found
              </li>
            )}
            {isOpen &&
              inputItems.map((item, index) => (
                <li
                  className={`py-2 px-3 flex flex-col rounded-md text-kumo-default ${
                    selectedItem === item && "font-bold"
                  } ${highlightedIndex === index && "bg-kumo-tint"}`}
                  key={item.id}
                  {...getItemProps({ index, item })}
                >
                  <ModelRow model={item} />
                </li>
              ))}
          </ul>
        </div>
      ) : (
        /* External Provider Models Selector */
        <div className="space-y-3">
          <div>
            <label
              htmlFor="provider"
              className="text-xs text-kumo-secondary block mb-1"
            >
              Provider
            </label>
            <select
              value={externalProvider}
              onChange={(e) =>
                onExternalProviderChange(e.target.value as GatewayProvider)
              }
              className="w-full p-2 border border-kumo-line rounded-md text-sm bg-kumo-base text-kumo-default"
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
              <option value="xai">xAI</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="model"
              className="text-xs text-kumo-secondary block mb-1"
            >
              Model
            </label>
            <div className="bg-kumo-base border border-kumo-line rounded-md p-2 max-h-40 overflow-y-auto">
              {externalModels.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => onExternalModelSelect(model.id)}
                  className={`w-full text-left py-2 px-2 rounded-md text-xs transition-colors mb-1 ${
                    externalModel === model.id
                      ? "bg-kumo-brand/10 border border-kumo-brand/30 text-kumo-default"
                      : "hover:bg-kumo-tint border border-transparent text-kumo-default"
                  }`}
                >
                  <span
                    className={`font-medium ${
                      externalModel === model.id ? "text-kumo-brand" : ""
                    }`}
                  >
                    {model.name}
                  </span>
                  <span className="text-kumo-secondary ml-2">
                    {model.description}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Authentication Method */}
          <div>
            <label
              htmlFor="authentication"
              className="text-xs text-kumo-secondary block mb-2"
            >
              Authentication
            </label>
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                onClick={() => onAuthMethodChange("provider-key")}
                className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                  authMethod === "provider-key"
                    ? "bg-kumo-base shadow-sm border border-kumo-line text-kumo-default"
                    : "bg-kumo-control text-kumo-secondary hover:text-kumo-default border border-transparent"
                }`}
              >
                Provider API Key
              </button>
              <button
                type="button"
                onClick={() => onAuthMethodChange("gateway")}
                className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                  authMethod === "gateway"
                    ? "bg-kumo-base shadow-sm border border-kumo-line text-kumo-default"
                    : "bg-kumo-control text-kumo-secondary hover:text-kumo-default border border-transparent"
                }`}
              >
                AI Gateway
              </button>
            </div>

            {authMethod === "provider-key" ? (
              <div>
                <label
                  htmlFor="provider-api-key"
                  className="text-xs text-kumo-secondary block mb-1"
                >
                  {externalProvider === "openai"
                    ? "OpenAI"
                    : externalProvider === "anthropic"
                      ? "Anthropic"
                      : externalProvider === "google"
                        ? "Google"
                        : "xAI"}{" "}
                  API Key <span className="text-kumo-danger">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showProviderKey ? "text" : "password"}
                    value={providerApiKey || ""}
                    onChange={(e) => onProviderApiKeyChange(e.target.value)}
                    placeholder={`Enter your ${externalProvider === "xai" ? "xAI" : externalProvider} API key`}
                    required
                    className="w-full p-2 pr-10 border border-kumo-line rounded-md text-sm bg-kumo-base text-kumo-default"
                  />
                  <button
                    type="button"
                    onClick={() => setShowProviderKey(!showProviderKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-kumo-secondary hover:text-kumo-default"
                  >
                    {showProviderKey ? (
                      <EyeSlashIcon size={16} />
                    ) : (
                      <EyeIcon size={16} />
                    )}
                  </button>
                </div>
                <p className="text-xs text-kumo-inactive mt-1">
                  Your {externalProvider === "xai" ? "xAI" : externalProvider}{" "}
                  API key for direct access
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="account-id"
                    className="text-xs text-kumo-secondary block mb-1"
                  >
                    Account ID <span className="text-kumo-danger">*</span>
                  </label>
                  <input
                    type="text"
                    value={gatewayAccountId || ""}
                    onChange={(e) => onGatewayAccountIdChange(e.target.value)}
                    placeholder="Enter your Cloudflare account ID"
                    required
                    className="w-full p-2 border border-kumo-line rounded-md text-sm bg-kumo-base text-kumo-default"
                  />
                  <p className="text-xs text-kumo-inactive mt-1">
                    Your Cloudflare account ID
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="gateway-id"
                    className="text-xs text-kumo-secondary block mb-1"
                  >
                    Gateway ID <span className="text-kumo-danger">*</span>
                  </label>
                  <input
                    type="text"
                    value={gatewayId || ""}
                    onChange={(e) => onGatewayIdChange(e.target.value)}
                    placeholder="Enter your AI Gateway ID"
                    required
                    className="w-full p-2 border border-kumo-line rounded-md text-sm bg-kumo-base text-kumo-default"
                  />
                  <p className="text-xs text-kumo-inactive mt-1">
                    The name/ID of your AI Gateway
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="cloudflare-api-key"
                    className="text-xs text-kumo-secondary block mb-1"
                  >
                    Cloudflare API Key{" "}
                    <span className="text-kumo-danger">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showGatewayKey ? "text" : "password"}
                      value={gatewayApiKey || ""}
                      onChange={(e) => onGatewayApiKeyChange(e.target.value)}
                      placeholder="Enter your Cloudflare API key"
                      required
                      className="w-full p-2 pr-10 border border-kumo-line rounded-md text-sm bg-kumo-base text-kumo-default"
                    />
                    <button
                      type="button"
                      onClick={() => setShowGatewayKey(!showGatewayKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-kumo-secondary hover:text-kumo-default"
                    >
                      {showGatewayKey ? (
                        <EyeSlashIcon size={16} />
                      ) : (
                        <EyeIcon size={16} />
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-kumo-inactive mt-1">
                    Required: Cloudflare API key for AI Gateway authentication
                  </p>
                </div>

                <div className="bg-kumo-info/10 border border-kumo-info/30 rounded-md p-2">
                  <p className="text-xs text-kumo-info">
                    <strong>Unified Billing:</strong> Uses Cloudflare credits
                    for provider API calls. Load credits in your{" "}
                    <a
                      href="https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:opacity-80"
                    >
                      Cloudflare dashboard
                    </a>
                    .
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default UnifiedModelSelector;
