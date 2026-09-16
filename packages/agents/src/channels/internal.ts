import type { ChannelMessage, DeliveryResult } from "./channel";
import type { ChannelIngressResult } from "./ingress";
import { isChannelMessageSurface, type ChannelMessageSurface } from "./surface";

const textEncoder = new TextEncoder();

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
