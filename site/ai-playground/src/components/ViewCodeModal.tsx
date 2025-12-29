/** biome-ignore-all lint/a11y/noStaticElementInteractions: it's fine */
import type { UIMessage } from "ai";
import type { PlaygroundState } from "../server";

const escapeString = (str: string) => {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
};

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

  // Workers AI mode
  if (!params.useExternalProvider) {
    return `import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const workersAi = createWorkersAI(env);

const result = streamText({
  model: workersAi("${params.model}"),
  system: "${escapeString(params.system)}",
  temperature: ${params.temperature},
  messages: [
${messageArray}
  ],
});

return result.toDataStreamResponse();`;
  }

  // External provider mode
  const modelName = params.externalModel || params.model;
  let modelId = modelName;
  if (modelId.includes("/")) {
    modelId = modelId.split("/")[1];
  }

  if (params.authMethod === "gateway") {
    // AI Gateway (Unified Billing)
    const providerImport =
      params.externalProvider === "openai"
        ? 'createOpenAI from "ai-gateway-provider/providers/openai"'
        : params.externalProvider === "anthropic"
          ? 'createAnthropic from "ai-gateway-provider/providers/anthropic"'
          : params.externalProvider === "google"
            ? 'createGoogleGenerativeAI from "ai-gateway-provider/providers/google"'
            : 'createOpenAI from "ai-gateway-provider/providers/openai"'; // xAI uses OpenAI-compatible API

    const providerName =
      params.externalProvider === "openai"
        ? "createOpenAI"
        : params.externalProvider === "anthropic"
          ? "createAnthropic"
          : params.externalProvider === "google"
            ? "createGoogleGenerativeAI"
            : "createOpenAI"; // xAI uses OpenAI-compatible API

    const accountId = params.gatewayAccountId || "YOUR_ACCOUNT_ID";
    const gatewayId = params.gatewayId || "YOUR_GATEWAY_ID";

    return `import { streamText } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { ${providerImport} };

const gateway = createAiGateway({
  accountId: "${accountId}",
  gateway: "${gatewayId}",
  apiKey: env.CLOUDFLARE_API_KEY, // Store in .dev.vars or secrets
});

const ${params.externalProvider} = ${providerName}();
const model = ${params.externalProvider}.chat("${modelId}");

const result = streamText({
  model: gateway(model),
  system: "${escapeString(params.system)}",
  temperature: ${params.temperature},
  messages: [
${messageArray}
  ],
});

return result.toDataStreamResponse();`;
  } else {
    // Provider API Key (BYOK)
    const providerImport =
      params.externalProvider === "openai"
        ? 'createOpenAI from "@ai-sdk/openai"'
        : params.externalProvider === "anthropic"
          ? 'createAnthropic from "@ai-sdk/anthropic"'
          : params.externalProvider === "google"
            ? 'createGoogleGenerativeAI from "@ai-sdk/google"'
            : 'createOpenAI from "@ai-sdk/openai"'; // xAI uses OpenAI-compatible API

    const providerName =
      params.externalProvider === "openai"
        ? "createOpenAI"
        : params.externalProvider === "anthropic"
          ? "createAnthropic"
          : params.externalProvider === "google"
            ? "createGoogleGenerativeAI"
            : "createOpenAI"; // xAI uses OpenAI-compatible API

    const apiKeyEnvVar =
      params.externalProvider === "openai"
        ? "OPENAI_API_KEY"
        : params.externalProvider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : params.externalProvider === "google"
            ? "GOOGLE_GENERATIVE_AI_API_KEY"
            : "XAI_API_KEY";

    const baseUrlConfig =
      params.externalProvider === "xai"
        ? ',\n  baseURL: "https://api.x.ai/v1"'
        : "";

    return `import { streamText } from "ai";
import { ${providerImport} };

const ${params.externalProvider === "xai" ? "xai" : params.externalProvider} = ${providerName}({
  apiKey: env.${apiKeyEnvVar}${baseUrlConfig}, // Store in .dev.vars or secrets
});

const result = streamText({
  model: ${params.externalProvider === "xai" ? "xai" : params.externalProvider}("${modelId}"),
  system: "${escapeString(params.system)}",
  temperature: ${params.temperature},
  messages: [
${messageArray}
  ],
});

return result.toDataStreamResponse();`;
  }
};

const ViewCodeModal = ({
  visible,
  handleHide,
  params,
  messages
}: {
  visible: boolean;
  handleHide: (e: React.MouseEvent<HTMLDivElement>) => void;
  params: PlaygroundState;
  messages: UIMessage[];
}) => {
  if (!visible) return null;

  return (
    <div
      onClick={handleHide}
      className="fixed top-0 left-0 bottom-0 right-0 bg-[rgba(255,255,255,0.5)] backdrop-blur-sm z-20 flex md:items-center md:justify-center items-end md:p-16"
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
        }}
        className="bg-white shadow-xl rounded-md md:max-w-2xl w-full p-6"
      >
        <h2 className="font-semibold text-xl flex items-center">
          View code{" "}
          <div
            onClick={handleHide}
            className="ml-auto text-4xl text-gray-400 font-thin cursor-pointer"
          >
            ×
          </div>
        </h2>
        <p className="mt-2 text-gray-500">
          {params.useExternalProvider ? (
            <>
              You can use the following code to deploy a Cloudflare Worker using{" "}
              {params.externalProvider === "openai"
                ? "OpenAI"
                : params.externalProvider === "anthropic"
                  ? "Anthropic"
                  : params.externalProvider === "google"
                    ? "Google"
                    : "xAI"}{" "}
              with the current playground messages and settings.
              {params.authMethod === "gateway" && (
                <>
                  {" "}
                  This uses{" "}
                  <a
                    className="text-blue-500 underline"
                    href="https://developers.cloudflare.com/ai-gateway/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Cloudflare AI Gateway
                  </a>{" "}
                  for unified billing.
                </>
              )}
            </>
          ) : (
            <>
              You can use the following code to{" "}
              <a
                className="text-blue-500 underline"
                href="https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/"
                target="_blank"
                rel="noopener noreferrer"
              >
                deploy a Workers AI Worker
              </a>{" "}
              using the current playground messages and settings.
            </>
          )}
        </p>

        <pre className="text-sm py-4 px-3 bg-gray-100 rounded-sm my-4 overflow-auto max-h-[300px]">
          {createMessageString(messages, params)}
        </pre>
      </div>
    </div>
  );
};

export default ViewCodeModal;
