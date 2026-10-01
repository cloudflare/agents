/**
 * Shared plumbing for the non-language models — image, transcription, speech
 * and reranking. They differ only in the body they build and the answer they
 * read; everything between (option merging, gateway headers, fallback, error
 * mapping, envelope unwrapping, provider metadata) is the same call.
 */

import type {
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
  SharedV4Warning
} from "@ai-sdk/provider";
import { CloudflareAIError, requireWorkersAIId } from "../errors";
import {
  parseCallOptions,
  resolveOptions,
  type ModelOptions
} from "../settings";
import {
  definedHeaders,
  errorFromResponse,
  headersToObject,
  unwrapEnvelope
} from "../transport";
import { withFallback } from "./fallback";
import { cloudflareMetadata, type LanguageModelConfig } from "./language";

export { toBase64 } from "../wires/shared";

/** Everything a non-language model needs from the provider that created it. */
export type ModalityConfig = LanguageModelConfig;

/** A run-path body plus whatever the conversion had to drop. */
export interface ModalityRequest {
  input: Record<string, unknown>;
  warnings: SharedV4Warning[];
}

/** One call on a non-language model, before the wire body is built. */
export interface ModalityCall {
  /** The per-call options bag, read for `providerOptions.cloudflare`. */
  providerOptions: SharedV4ProviderOptions | undefined;
  /** Extra request headers from the call. */
  headers: Record<string, string | undefined> | undefined;
  abortSignal: AbortSignal | undefined;
  /**
   * Builds the body for one leg. Called once per fallback attempt, because
   * the body shape depends on which model ends up answering.
   */
  build(modelId: string): ModalityRequest;
}

/** What the run path answered, decoded by content type. */
export interface ModalityAnswer {
  /** The model that answered — the fallback leg, when one was used. */
  modelId: string;
  /** The body that was sent, for `request.body` on the result. */
  input: Record<string, unknown>;
  warnings: SharedV4Warning[];
  headers: Record<string, string>;
  providerMetadata: SharedV4ProviderMetadata;
  /** The parsed JSON body, envelope unwrapped, or `undefined` for bytes. */
  json: unknown;
  /** The raw body, for the models that answer with PNG or MP3 bytes. */
  bytes: Uint8Array | undefined;
  /** The response content type, without parameters. */
  mediaType: string;
  timestamp: Date;
  /** The endpoint that answered, for error reporting. */
  url: string;
}

/** The `unsupported` warning shape, which every modality needs. */
export function unsupported(
  feature: string,
  details?: string
): SharedV4Warning {
  return {
    feature,
    type: "unsupported",
    ...(details === undefined ? {} : { details })
  };
}

/** Decodes base64 into bytes; passes `Uint8Array` input straight through. */
export function toBytes(data: Uint8Array | string): Uint8Array {
  if (typeof data !== "string") return data;
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * A model over the Cloudflare run path that is not a language model. Holds
 * the one call path all four modalities share; each subclass only builds a
 * body and reads an answer.
 *
 * @experimental This surface is experimental and may change.
 */
export abstract class CloudflareModalityModel {
  readonly specificationVersion = "v4" as const;
  readonly provider = "cloudflare";
  readonly modelId: string;

  readonly #config: ModalityConfig;
  readonly #options: ModelOptions | undefined;

  constructor(
    modelId: string,
    options: ModelOptions | undefined,
    config: ModalityConfig
  ) {
    // A leg written as a string is a Workers AI id, and nothing else: the
    // same gate the language models apply, at the line that wrote the leg.
    options?.fallback?.forEach((leg) => {
      if (typeof leg === "string") requireWorkersAIId(leg);
    });
    this.modelId = modelId;
    this.#options = options;
    this.#config = config;
  }

  /** The endpoint this model calls, for error reporting. */
  protected get endpoint(): string {
    return this.#config.transport.url;
  }

  /**
   * Sends one call, trying each fallback leg in turn, and decodes the answer
   * as JSON or as raw bytes depending on what the model sent back.
   */
  protected async send(call: ModalityCall): Promise<ModalityAnswer> {
    const resolved = resolveOptions(
      this.#config.providerGateway,
      this.#options,
      parseCallOptions(call.providerOptions)
    );
    const transport = this.#config.transport;
    return withFallback(
      this.modelId,
      resolved.fallback,
      transport.url,
      async (modelId) => {
        const request = call.build(modelId);
        const response = await transport.run({
          gateway: resolved.gateway,
          headers: {
            // The AI SDK types these as `string | undefined`; an undefined
            // value must not reach the binding as the string "undefined".
            ...definedHeaders(call.headers),
            ...resolved.headers,
            ...(resolved.sessionAffinity === undefined
              ? {}
              : { "x-session-affinity": resolved.sessionAffinity })
          },
          input: request.input,
          model: modelId,
          signal: call.abortSignal
        });
        if (!response.ok) {
          throw await errorFromResponse(response, {
            model: modelId,
            requestBodyValues: request.input,
            url: transport.url
          });
        }

        const mediaType = (response.headers.get("content-type") ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const body = await this.#decode(
          response,
          modelId,
          request.input,
          mediaType
        );
        return {
          headers: headersToObject(response.headers),
          input: request.input,
          mediaType,
          modelId,
          providerMetadata: cloudflareMetadata(
            modelId,
            resolved,
            response,
            transport
          ),
          timestamp: new Date(),
          url: transport.url,
          warnings: request.warnings,
          ...body
        };
      }
    );
  }

  /**
   * Reads a 2xx body. A JSON content type is parsed and unwrapped; anything
   * else is the model's own bytes (PNG, JPEG, MP3). A JSON content type with a
   * body that will not parse is a provider failure, not a caller bug, so it
   * comes back as a {@link CloudflareAIError} rather than a bare `SyntaxError`.
   */
  async #decode(
    response: Response,
    modelId: string,
    input: Record<string, unknown>,
    mediaType: string
  ): Promise<{ json: unknown; bytes: Uint8Array | undefined }> {
    if (!mediaType.includes("json")) {
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        json: undefined
      };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new CloudflareAIError({
        cause: error,
        code: "provider-error",
        isRetryable: false,
        message: `The model answered ${response.status} with a body that is not JSON.`,
        model: modelId,
        requestBodyValues: input,
        status: response.status,
        url: this.#config.transport.url
      });
    }
    return {
      bytes: undefined,
      json: unwrapEnvelope(json, {
        model: modelId,
        status: response.status,
        url: this.#config.transport.url
      })
    };
  }
}
