export * from "./adapters/email";
export * from "./adapters/telegram";
export * from "./channel";
export * from "./fallback";
export * from "./fanout";
export * from "./host";
export * from "./identity";
export * from "./ingress";
export * from "./routes";
// Only the finalization contract is public. Pacing and collection stay
// internal until a Channel outside this package needs them.
export {
  consumeChunks,
  type ChunkConsumer,
  type StreamOutcome
} from "./stream";
export * from "./surface";
