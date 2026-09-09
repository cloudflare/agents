import type { ChannelChunk, DeliveryResult } from "../src/channel";
import type { ChannelHost } from "../src/host";
import type { ChannelMessageSurface } from "../src/surface";

export type ObservedMessage = { text: string };

export type LiveStreamSession = {
  push(chunk: ChannelChunk): Promise<void>;
  finish(): Promise<DeliveryResult>;
  /** End the stream the way a failed generation does. */
  fail(reason: string): Promise<DeliveryResult>;
};

export type LiveDeliveryBinding = {
  name: "telegram" | "slack" | "slack-thread" | "email";
  destination: string;
  host: ChannelHost;
  surface: ChannelMessageSurface;
  /** Initialize the observer and start from an empty destination. */
  open(): Promise<void>;
  clear(): Promise<void>;
  /** Provider-side evidence that an ephemeral preview reached the reader. */
  previews?(): number;
  read(): Promise<ObservedMessage[]>;
  close?(): Promise<void>;
};

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing live delivery configuration: ${name}`);
  return value;
}
