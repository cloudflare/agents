import type { UIMessage } from "ai";
import { Link } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import type { PlaygroundState } from "../server";

const escapeString = (str: string) => {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
};

// ── Provider config lookup tables ──

type ProviderKey = "openai" | "anthropic" | "google" | "xai";

const PROVIDER_CONFIG: Record<
  ProviderKey,
  {
    displayName: string;
    constructorName: string;
    sdkImport: string;
    gatewayImport: string;
    apiKeyEnv: string;
    baseUrl?: string;
  }
> = {
  openai: {
    displayName: "OpenAI",
    constructorName: "createOpenAI",
    sdkImport: 'createOpenAI from "@ai-sdk/openai"',
    gatewayImport: 'createOpenAI from "ai-gateway-provider/providers/openai"',
    apiKeyEnv: "OPENAI_API_KEY"
  },
  anthropic: {
    displayName: "Anthropic",
    constructorName: "createAnthropic",
    sdkImport: 'createAnthropic from "@ai-sdk/anthropic"',
    gatewayImport:
      'createAnthropic from "ai-gateway-provider/providers/anthropic"',
    apiKeyEnv: "ANTHROPIC_API_KEY"
  },
  google: {
    displayName: "Google",
    constructorName: "createGoogleGenerativeAI",
    sdkImport: 'createGoogleGenerativeAI from "@ai-sdk/google"',
    gatewayImport:
      'createGoogleGenerativeAI from "ai-gateway-provider/providers/google"',
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY"
  },
  xai: {
    displayName: "xAI",
    constructorName: "createOpenAI",
    sdkImport: 'createOpenAI from "@ai-sdk/openai"',
    gatewayImport: 'createOpenAI from "ai-gateway-provider/providers/openai"',
    apiKeyEnv: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1"
  }
};

const getConfig = (provider: string | undefined) =>
  PROVIDER_CONFIG[(provider as ProviderKey) || "openai"] ||
  PROVIDER_CONFIG.openai;

// ── Code generation ──

const createMessageString = (
  messages: UIMessage[],
  params: PlaygroundState
) => {
  const messageArray = messages
    .map(
      (message) =>
        `    { role: "${message.role}", content: "${escapeString(
          message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
        )}"}`
    )
    .join(",\n");

  const streamTextTail = `  system: "${escapeString(params.system)}",
  temperature: ${params.temperature},
  messages: [
${messageArray}
  ],
});

return result.toDataStreamResponse();`;

  if (!params.useExternalProvider) {
    return `import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const workersAi = createWorkersAI(env);

const result = streamText({
  model: workersAi("${params.model}"),
  ${streamTextTail}`;
  }

  const cfg = getConfig(params.externalProvider);
  const modelName = params.externalModel || params.model;
  const modelId = modelName.includes("/") ? modelName.split("/")[1] : modelName;
  const varName =
    params.externalProvider === "xai" ? "xai" : params.externalProvider;

  if (params.authMethod === "gateway") {
    const accountId = params.gatewayAccountId || "YOUR_ACCOUNT_ID";
    const gatewayId = params.gatewayId || "YOUR_GATEWAY_ID";

    return `import { streamText } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { ${cfg.gatewayImport} };

const gateway = createAiGateway({
  accountId: "${accountId}",
  gateway: "${gatewayId}",
  apiKey: env.CLOUDFLARE_API_KEY,
});

const ${varName} = ${cfg.constructorName}();
const model = ${varName}.chat("${modelId}");

const result = streamText({
  model: gateway(model),
  ${streamTextTail}`;
  }

  const baseUrlConfig = cfg.baseUrl ? `,\n  baseURL: "${cfg.baseUrl}"` : "";

  return `import { streamText } from "ai";
import { ${cfg.sdkImport} };

const ${varName} = ${cfg.constructorName}({
  apiKey: env.${cfg.apiKeyEnv}${baseUrlConfig},
});

const result = streamText({
  model: ${varName}("${modelId}"),
  ${streamTextTail}`;
};

// ── Component ──

const ViewCodeModal = ({
  visible,
  handleHide,
  params,
  messages
}: {
  visible: boolean;
  handleHide: (e: React.MouseEvent<HTMLElement>) => void;
  params: PlaygroundState;
  messages: UIMessage[];
}) => {
  if (!visible) return null;

  const cfg = getConfig(params.externalProvider);

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- modal backdrop dismiss
    <div
      onClick={handleHide}
      className="fixed inset-0 bg-kumo-base/50 backdrop-blur-sm z-20 flex md:items-center md:justify-center items-end md:p-16"
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stop propagation */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-kumo-base shadow-xl rounded-lg md:max-w-2xl w-full p-6 ring ring-kumo-line"
      >
        <h2 className="font-semibold text-xl flex items-center text-kumo-default">
          View code
          {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- close button */}
          <button
            type="button"
            onClick={handleHide}
            className="ml-auto text-kumo-secondary cursor-pointer hover:text-kumo-default"
          >
            <XIcon size={24} />
          </button>
        </h2>
        <p className="mt-2 text-kumo-secondary">
          {params.useExternalProvider ? (
            <>
              You can use the following code to deploy a Cloudflare Worker using{" "}
              {cfg.displayName} with the current playground messages and
              settings.
              {params.authMethod === "gateway" && (
                <>
                  {" "}
                  This uses{" "}
                  <Link href="https://developers.cloudflare.com/ai-gateway/">
                    Cloudflare AI Gateway
                  </Link>{" "}
                  for unified billing.
                </>
              )}
            </>
          ) : (
            <>
              You can use the following code to{" "}
              <Link href="https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/">
                deploy a Workers AI Worker
              </Link>{" "}
              using the current playground messages and settings.
            </>
          )}
        </p>

        <pre className="text-sm py-4 px-3 bg-kumo-control text-kumo-default rounded-md my-4 overflow-auto max-h-[300px]">
          {createMessageString(messages, params)}
        </pre>
      </div>
    </div>
  );
};

export default ViewCodeModal;
