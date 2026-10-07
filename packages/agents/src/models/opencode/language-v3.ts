import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FilePart,
  LanguageModelV4Message,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  SharedV3Warning,
  SharedV4FileData,
  SharedV4Warning
} from "@ai-sdk/provider";

/**
 * OpenCode loads AI SDK models through the `LanguageModelV3` contract;
 * `agents/models/ai-sdk` implements `LanguageModelV4`. The two differ only in
 * how files are carried (V4 wraps file data in a tagged union and folds the
 * image variants into one `file` part) and in the parts V4 added (`custom`,
 * `reasoning-file`), which V3 has no slot for and are dropped. Text,
 * reasoning, tool calls, usage and finish reasons are the same shape.
 */
export function asLanguageModelV3(model: LanguageModelV4): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const result = await model.doGenerate(callOptions(options));
      return {
        ...result,
        warnings: result.warnings.map(warning),
        content: result.content.flatMap((part) => {
          const converted = content(part);
          return converted === undefined ? [] : [converted];
        })
      };
    },
    async doStream(options) {
      const result = await model.doStream(callOptions(options));
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV3StreamPart
          >({
            transform(part, controller) {
              const converted = streamPart(part);
              if (converted !== undefined) controller.enqueue(converted);
            }
          })
        )
      };
    }
  };
}

function callOptions(
  options: LanguageModelV3CallOptions
): LanguageModelV4CallOptions {
  return { ...options, prompt: options.prompt.map(message) };
}

function message(input: LanguageModelV3Message): LanguageModelV4Message {
  switch (input.role) {
    case "system":
      return input;
    case "user":
      return {
        ...input,
        content: input.content.map((part) =>
          part.type === "file" ? filePart(part) : part
        )
      };
    case "assistant":
      return {
        ...input,
        content: input.content.map((part) => {
          if (part.type === "file") return filePart(part);
          if (part.type === "tool-result") {
            return { ...part, output: toolOutput(part.output) };
          }
          return part;
        })
      };
    case "tool":
      return {
        ...input,
        content: input.content.map((part) =>
          part.type === "tool-result"
            ? { ...part, output: toolOutput(part.output) }
            : part
        )
      };
  }
}

function filePart(part: LanguageModelV3FilePart): LanguageModelV4FilePart {
  return { ...part, data: fileData(part.data) };
}

function fileData(data: LanguageModelV3FilePart["data"]): SharedV4FileData {
  return data instanceof URL
    ? { type: "url", url: data }
    : { type: "data", data };
}

function toolOutput(
  output: LanguageModelV3ToolResultOutput
): LanguageModelV4ToolResultOutput {
  if (output.type !== "content") return output;
  return {
    ...output,
    value: output.value.map((item) => {
      switch (item.type) {
        case "text":
          return item;
        case "file-data":
        case "image-data":
          return {
            type: "file" as const,
            data: { type: "data" as const, data: item.data },
            mediaType: item.mediaType,
            ...("filename" in item && item.filename !== undefined
              ? { filename: item.filename }
              : {}),
            providerOptions: item.providerOptions
          };
        case "file-url":
        case "image-url":
          return {
            type: "file" as const,
            data: { type: "url" as const, url: new URL(item.url) },
            mediaType:
              item.type === "image-url"
                ? "image/*"
                : "application/octet-stream",
            providerOptions: item.providerOptions
          };
        case "file-id":
        case "image-file-id":
          return {
            type: "file" as const,
            data: {
              type: "reference" as const,
              reference:
                typeof item.fileId === "string"
                  ? { id: item.fileId }
                  : item.fileId
            },
            mediaType:
              item.type === "image-file-id"
                ? "image/*"
                : "application/octet-stream",
            providerOptions: item.providerOptions
          };
        case "custom":
          return {
            type: "custom" as const,
            providerOptions: item.providerOptions
          };
      }
    })
  };
}

function content(
  part: LanguageModelV4Content
): LanguageModelV3Content | undefined {
  switch (part.type) {
    case "custom":
    case "reasoning-file":
      return undefined;
    case "file":
      return generatedFile(part);
    default:
      return part;
  }
}

function streamPart(
  part: LanguageModelV4StreamPart
): LanguageModelV3StreamPart | undefined {
  switch (part.type) {
    case "custom":
    case "reasoning-file":
      return undefined;
    case "file":
      return generatedFile(part);
    case "stream-start":
      return { ...part, warnings: part.warnings.map(warning) };
    default:
      return part;
  }
}

/** V4 added `deprecated` warnings; V3 reports them as `other`. */
function warning(input: SharedV4Warning): SharedV3Warning {
  return input.type === "deprecated"
    ? { type: "other", message: `${input.setting}: ${input.message}` }
    : input;
}

function generatedFile(
  part: Extract<LanguageModelV4Content, { type: "file" }>
): Extract<LanguageModelV3Content, { type: "file" }> | undefined {
  // V3 carries generated files inline only; a URL file has no V3 form.
  if (part.data.type !== "data") return undefined;
  return {
    type: "file",
    mediaType: part.mediaType,
    data: part.data.data,
    ...(part.providerMetadata === undefined
      ? {}
      : { providerMetadata: part.providerMetadata })
  };
}
