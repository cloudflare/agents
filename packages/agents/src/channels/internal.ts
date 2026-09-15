import type { Streams, StreamJson } from "../streams";
import type {
  ChannelMessage,
  ChannelMessageResolver,
  ChannelStreamOptions,
  DeliveryResult
} from "./channel";
import type { ChannelIngressEnvelope, ChannelIngressResult } from "./ingress";
import { isChannelMessageSurface, type ChannelMessageSurface } from "./surface";

const textEncoder = new TextEncoder();

/** @internal Binds shared Host services to a configured Channel. */
export const bindChannelHost = Symbol("bindChannelHost");

/** @internal Contributes Channel-specific durable response metadata. */
export const describeChannelResponse = Symbol("describeChannelResponse");

/** @internal Binds push-based ingress to the Host's normal dispatch path. */
export const bindChannelIngress = Symbol("bindChannelIngress");

export type ChannelHostServices = {
  channelKey: string;
  resolveMessages?: ChannelMessageResolver;
  responseStreams?: Pick<Streams, "list" | "read" | "status">;
};

/** @internal Implemented by Channels that consume shared Host services. */
export type BindableChannelHost = {
  [bindChannelHost](services: ChannelHostServices): void;
};

/** @internal Implemented by Channels that describe their response context. */
export type DescribableChannelResponse = {
  [describeChannelResponse](
    surface: ChannelMessageSurface,
    options: ChannelStreamOptions
  ): Record<string, StreamJson> | undefined;
};

export type ChannelIngressDispatchOutcome = "handled" | "ignored";

/** @internal Implemented by Channels whose provider pushes live events. */
export type BindableChannelIngress<TRaw = unknown> = {
  [bindChannelIngress](
    dispatch: (
      envelope: ChannelIngressEnvelope<TRaw>
    ) => Promise<ChannelIngressDispatchOutcome>
  ): void;
};

export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(value);
}

export function utf8ByteLength(value: string): number {
  return encodeUtf8(value).byteLength;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function defaultText(message: ChannelMessage): string {
  return message.title
    ? `${message.title}\n\n${message.markdown}`
    : message.markdown;
}

export function renderInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

export function uncertain(
  code: string,
  message: string,
  reference?: string
): Extract<DeliveryResult, { status: "uncertain" }> {
  return {
    status: "uncertain",
    ...(reference !== undefined && { reference }),
    error: { code, message }
  };
}

export function emptyIngressResponse<TRaw>(
  status = 200
): ChannelIngressResult<TRaw> {
  return { events: [], response: new Response(null, { status }) };
}

export function compositeDestinations(
  surface: ChannelMessageSurface
): readonly ChannelMessageSurface[] | undefined {
  if (
    surface.address === null ||
    typeof surface.address !== "object" ||
    Array.isArray(surface.address)
  ) {
    return undefined;
  }
  const destinations = (surface.address as Record<string, unknown>).surfaces;
  if (
    !Array.isArray(destinations) ||
    destinations.length === 0 ||
    !destinations.every(isChannelMessageSurface)
  ) {
    return undefined;
  }
  return destinations;
}

export function unsupported(
  code: string,
  message: string
): Extract<DeliveryResult, { status: "failed" }> {
  return {
    status: "failed",
    retryable: false,
    error: { code, message }
  };
}
