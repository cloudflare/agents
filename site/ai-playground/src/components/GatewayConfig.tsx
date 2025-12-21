import { useState } from "react";

type GatewayProvider = "openai" | "anthropic" | "google";

interface GatewayConfigProps {
  useGateway: boolean;
  gatewayProvider: GatewayProvider;
  gatewayAccountId?: string;
  gatewayId?: string;
  gatewayApiKey?: string;
  currentModel?: string;
  onToggle: (enabled: boolean) => void;
  onProviderChange: (provider: GatewayProvider) => void;
  onAccountIdChange: (accountId: string) => void;
  onGatewayIdChange: (gatewayId: string) => void;
  onApiKeyChange: (apiKey: string) => void;
  onModelSelect: (modelId: string) => void;
}

// Latest foundation models for each provider (top 5)
// Model IDs use provider prefix format for unified billing: provider/model-name
const FOUNDATION_MODELS: Record<
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
  ]
};

const GatewayConfig = ({
  useGateway,
  gatewayProvider,
  gatewayAccountId,
  gatewayId,
  gatewayApiKey,
  currentModel,
  onToggle,
  onProviderChange,
  onAccountIdChange,
  onGatewayIdChange,
  onApiKeyChange,
  onModelSelect
}: GatewayConfigProps) => {
  const [showApiKey, setShowApiKey] = useState(false);

  return (
    <div className="mt-4 p-3 border border-gray-200 rounded-md bg-gray-50">
      <div className="flex items-center justify-between mb-3">
        <label className="font-semibold text-sm flex items-center">
          <input
            type="checkbox"
            checked={useGateway}
            onChange={(e) => onToggle(e.target.checked)}
            className="mr-2"
          />
          Use AI Gateway (Unified Billing)
        </label>
      </div>

      {useGateway && (
        <div className="space-y-3 mt-3">
          <div>
            <label className="text-xs text-gray-600 block mb-1">
              Account ID
            </label>
            <input
              type="text"
              value={gatewayAccountId || ""}
              onChange={(e) => onAccountIdChange(e.target.value)}
              placeholder="Enter your Cloudflare account ID"
              className="w-full p-2 border border-gray-200 rounded-md text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              Your Cloudflare account ID (found in your dashboard URL)
            </p>
          </div>

          <div>
            <label className="text-xs text-gray-600 block mb-1">
              Gateway ID
            </label>
            <input
              type="text"
              value={gatewayId || ""}
              onChange={(e) => onGatewayIdChange(e.target.value)}
              placeholder="Enter your AI Gateway ID"
              className="w-full p-2 border border-gray-200 rounded-md text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              The name/ID of your AI Gateway
            </p>
          </div>

          <div>
            <label className="text-xs text-gray-600 block mb-1">
              Cloudflare API Key <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                type={showApiKey ? "text" : "password"}
                value={gatewayApiKey || ""}
                onChange={(e) => onApiKeyChange(e.target.value)}
                placeholder="Enter your Cloudflare API key"
                required
                className="w-full p-2 pr-10 border border-gray-200 rounded-md text-sm"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
              >
                {showApiKey ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Required: Cloudflare API key for AI Gateway authentication
            </p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-md p-2 mb-3">
            <p className="text-xs text-blue-800">
              <strong>Unified Billing:</strong> Uses Cloudflare credits for
              provider API calls. You still need a Cloudflare API key for
              gateway authentication. Load credits in your{" "}
              <a
                href="https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-blue-900"
              >
                Cloudflare dashboard
              </a>
              .
            </p>
          </div>

          <div>
            <label className="text-xs text-gray-600 block mb-1">Provider</label>
            <select
              value={gatewayProvider}
              onChange={(e) =>
                onProviderChange(e.target.value as GatewayProvider)
              }
              className="w-full p-2 border border-gray-200 rounded-md text-sm"
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-gray-600 block mb-1">
              Available Models
            </label>
            <div className="bg-white border border-gray-200 rounded-md p-2 max-h-40 overflow-y-auto">
              {FOUNDATION_MODELS[gatewayProvider].map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => onModelSelect(model.id)}
                  className={`w-full text-left py-2 px-2 rounded-md text-xs transition-colors ${
                    currentModel === model.id
                      ? "bg-blue-50 border border-blue-200"
                      : "hover:bg-gray-50 border border-transparent"
                  }`}
                >
                  <span
                    className={`font-medium ${currentModel === model.id ? "text-blue-700" : ""}`}
                  >
                    {model.name}
                  </span>
                  <span className="text-gray-500 ml-2">
                    {model.description}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GatewayConfig;
