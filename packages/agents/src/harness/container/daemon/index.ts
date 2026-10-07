/**
 * The harness daemon's core, for the process inside the container. Pair it
 * with a transport (`agents/harness/container/runtime` serves it in Node) and an
 * adapter for the agent you run. Runs anywhere: it uses no Node or Workers
 * APIs.
 *
 * @experimental The API may change before it stabilizes.
 */
export {
  ContainerDaemon,
  echoAdapter,
  type AdapterContext,
  type AdapterSession,
  type AdapterTurn,
  type ContainerAdapter,
  type ContainerDaemonOptions,
  type DaemonConnection,
  type DaemonSocket
} from "../daemon-core";
export {
  chunkEntries,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  CONTAINER_ENV,
  CONTAINER_HEALTH_PATH,
  CONTAINER_PROTOCOL_VERSION,
  CONTAINER_SESSION_PATH,
  CONTAINER_TOKEN_HEADER,
  inputText,
  MAX_CHUNK_CHARS,
  parseDaemonMessage,
  parseHostMessage,
  type AdapterInfo,
  type ContainerEvent,
  type ContainerInput,
  type ContainerInputPart,
  type ContainerMessage,
  type ContainerOutcome,
  type ContainerPart,
  type ContainerSettings,
  type ContainerWhenBusy,
  type DaemonFrame,
  type DaemonMessage,
  type DaemonOperation,
  type HostMessage,
  type JsonValue
} from "../protocol";
