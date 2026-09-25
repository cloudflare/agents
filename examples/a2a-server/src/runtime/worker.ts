import { AGENT_CARD_PATH, AgentCard, ListTasksRequest } from "@a2a-js/sdk";
import { authenticateRequest } from "./auth";
import { readBodyWithLimit } from "./body";
import { applyA2AServerFeatures, resolveA2AServerFeatures } from "./features";
import { contextIdFromTaskId, validateContextId } from "./ids";
import {
  isValidJsonRpcRequestId,
  normalizeStatusTimestampAfter,
  parseLosslessJson,
  validateA2AJsonRpcRequest,
  validateJsonRpcEnvelope
} from "./json-validation";
import { validateClientMessageId } from "./messages";
import { MAX_LIST_RESPONSE_BYTES, encodeTaskPageToken } from "./task-store";
import {
  validateA2ARuntimeOptions,
  type A2ARuntimeEnv,
  type A2ARuntimeOptions
} from "./types";

export const A2A_CONTEXT_SHARD_COUNT = 16;
const LIST_SHARD_CONCURRENCY = 4;
const textEncoder = new TextEncoder();
const A2A_JSON_RPC_METHODS = new Set([
  "SendMessage",
  "SendStreamingMessage",
  "GetTask",
  "ListTasks",
  "CancelTask",
  "SubscribeToTask",
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "DeleteTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "GetExtendedAgentCard"
]);

interface ListedTaskJson {
  id: string;
  serializedBytes: number;
  statusTimestamp: string;
  value: Record<string, unknown>;
}

interface ListShardPage {
  nextPageToken: string;
  pageSize: number;
  tasks: ListedTaskJson[];
  totalSize: number;
}

/**
 * Creates the public Worker that serves the Agent Card and routes A2A requests
 * to one of the authenticated owner's bounded set of Durable Object shards.
 */
export function createA2AWorker<Env extends A2ARuntimeEnv>(
  options: A2ARuntimeOptions<Env>
): { fetch(request: Request, env: Env): Promise<Response> } {
  validateA2ARuntimeOptions(options);
  const features = resolveA2AServerFeatures(options.features);
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === `/${AGENT_CARD_PATH}`) {
        const card = applyA2AServerFeatures(
          options.agentCard(url.origin, env),
          features
        );
        return Response.json(AgentCard.toJSON(card), {
          headers: { "Cache-Control": "public, max-age=300" }
        });
      }
      if (url.pathname !== "/a2a") {
        return new Response("Not found", { status: 404 });
      }
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" }
        });
      }
      if (!(await authenticateRequest(request, options.bearerToken(env)))) {
        return options.unauthorizedResponse();
      }

      let body: string;
      try {
        body = await readBodyWithLimit(request, options.maxRequestBytes);
      } catch (error) {
        const message = errorMessage(error);
        return message === "Request body is too large"
          ? Response.json({ error: message }, { status: 413 })
          : rpcError(null, -32700, "Parse error", message);
      }

      let parsed: unknown;
      try {
        parsed = parseLosslessJson(body);
      } catch (error) {
        return rpcError(null, -32700, "Parse error", errorMessage(error));
      }

      let requestId: string | number | null = null;
      try {
        validateJsonRpcEnvelope(parsed);
        requestId = rpcId(parsed.id);
      } catch (error) {
        return rpcError(
          requestId,
          -32600,
          "Invalid Request",
          errorMessage(error)
        );
      }

      const rpc = parsed;
      const method = rpc.method as string;
      if (!A2A_JSON_RPC_METHODS.has(method)) {
        return rpcError(requestId, -32601, "Method not found");
      }

      try {
        validateA2AJsonRpcRequest(rpc);
      } catch (error) {
        return rpcError(
          requestId,
          -32602,
          "Invalid params",
          errorMessage(error)
        );
      }

      let contextId: string | undefined;
      try {
        contextId = await routeContext(method, rpc);
      } catch (error) {
        return rpcError(
          requestId,
          -32602,
          "Invalid params",
          errorMessage(error)
        );
      }

      const namespace = options.contextNamespace(env);
      const forwardedBody = JSON.stringify(rpc);
      if (method === "ListTasks" && contextId === undefined) {
        try {
          return await listOwnerTasks(
            namespace,
            options.ownerName,
            request,
            forwardedBody,
            rpc,
            requestId
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              message: "owner-wide task listing failed",
              error: errorMessage(error)
            })
          );
          return rpcError(requestId, -32603, "Internal error");
        }
      }

      const shard =
        contextId === undefined ? 0 : await contextShardIndex(contextId);
      return namespace
        .getByName(shardName(options.ownerName, shard))
        .fetch(forwardRequest(request, forwardedBody));
    }
  };
}

/**
 * Validates context ownership from a message or task ID and normalizes mutable
 * message fields before the request reaches the owner's Durable Object.
 */
async function routeContext(
  method: string,
  rpc: Record<string, unknown>
): Promise<string | undefined> {
  if (method === "GetExtendedAgentCard") return undefined;
  const params = requiredRecord(rpc.params, "params");
  switch (method) {
    case "SendMessage":
    case "SendStreamingMessage": {
      const message = requiredRecord(params.message, "params.message");
      validateClientMessageId(
        requiredString(message.messageId, "params.message.messageId")
      );
      if (typeof message.taskId === "string" && message.taskId) {
        const contextId = contextIdFromTaskId(message.taskId);
        if (message.contextId && message.contextId !== contextId) {
          throw new Error("message.contextId does not match message.taskId");
        }
        message.contextId = contextId;
        return contextId;
      }
      const contextId =
        typeof message.contextId === "string" && message.contextId
          ? message.contextId
          : await contextIdFromMessage(message);
      message.contextId = validateContextId(contextId);
      return contextId;
    }
    case "GetTask":
    case "CancelTask":
    case "SubscribeToTask":
      return contextIdFromTaskId(requiredString(params.id, "params.id"));
    case "ListTasks":
      return !params.contextId
        ? undefined
        : validateContextId(
            requiredString(params.contextId, "params.contextId")
          );
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
    case "DeleteTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs":
      return contextIdFromTaskId(
        requiredString(params.taskId, "params.taskId")
      );
    default:
      throw new Error("Method not found");
  }
}

/** Maps one validated context to a stable owner shard. */
export async function contextShardIndex(contextId: string): Promise<number> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(validateContextId(contextId))
  );
  return new Uint8Array(digest)[0]! % A2A_CONTEXT_SHARD_COUNT;
}

/** Merges bounded pages from every owner shard into one protocol page. */
async function listOwnerTasks(
  namespace: DurableObjectNamespace,
  ownerName: string,
  request: Request,
  body: string,
  rpc: Record<string, unknown>,
  requestId: string | number | null
): Promise<Response> {
  const params = normalizedListParams(requiredRecord(rpc.params, "params"));
  const pageSize = params.pageSize ?? 50;
  let candidates: ListedTaskJson[] = [];
  let hasMore = false;
  let totalSize = 0;

  for (
    let firstShard = 0;
    firstShard < A2A_CONTEXT_SHARD_COUNT;
    firstShard += LIST_SHARD_CONCURRENCY
  ) {
    const shardNumbers = Array.from(
      {
        length: Math.min(
          LIST_SHARD_CONCURRENCY,
          A2A_CONTEXT_SHARD_COUNT - firstShard
        )
      },
      (_, offset) => firstShard + offset
    );
    const responses = await Promise.all(
      shardNumbers.map((shard) =>
        namespace
          .getByName(shardName(ownerName, shard))
          .fetch(forwardRequest(request, body))
      )
    );
    const envelopes = await Promise.all(
      responses.map((response) => readShardEnvelope(response, requestId))
    );

    for (const envelope of envelopes) {
      if (Object.hasOwn(envelope, "error")) return Response.json(envelope);
      const page = listShardPage(envelope.result);
      if (page.pageSize !== pageSize) {
        throw new Error("A ListTasks shard returned an unexpected page size.");
      }
      if (!Number.isSafeInteger(totalSize + page.totalSize)) {
        throw new Error("The merged ListTasks total exceeds a safe integer.");
      }
      totalSize += page.totalSize;
      hasMore ||= page.nextPageToken.length > 0;

      const merged = [...candidates, ...page.tasks].sort(compareListedTasks);
      if (merged.length > pageSize) hasMore = true;
      candidates = merged.slice(0, pageSize);
    }
  }

  const tasks: ListedTaskJson[] = [];
  let serializedTasksBytes = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const moreAfterCandidate = hasMore || index < candidates.length - 1;
    const nextPageToken = moreAfterCandidate
      ? encodeTaskPageToken(candidate, params)
      : "";
    const responseBytes = listEnvelopeByteLength(
      requestId,
      serializedTasksBytes + candidate.serializedBytes,
      tasks.length + 1,
      nextPageToken,
      pageSize,
      totalSize
    );
    if (responseBytes > MAX_LIST_RESPONSE_BYTES) {
      if (tasks.length === 0) {
        throw new Error("A task exceeds the merged ListTasks response budget.");
      }
      hasMore = true;
      break;
    }
    serializedTasksBytes += candidate.serializedBytes;
    tasks.push(candidate);
  }

  hasMore ||= tasks.length < candidates.length;
  const nextPageToken =
    hasMore && tasks.length > 0
      ? encodeTaskPageToken(tasks.at(-1)!, params)
      : "";
  const responseBody = listEnvelope(
    requestId,
    tasks,
    nextPageToken,
    pageSize,
    totalSize
  );
  if (textEncoder.encode(responseBody).byteLength > MAX_LIST_RESPONSE_BYTES) {
    throw new Error("The merged ListTasks response exceeds its byte budget.");
  }
  return new Response(responseBody, {
    headers: { "Content-Type": "application/json" }
  });
}

async function readShardEnvelope(
  response: Response,
  requestId: string | number | null
): Promise<Record<string, unknown>> {
  const body = await readBodyWithLimit(
    response,
    MAX_LIST_RESPONSE_BYTES,
    "ListTasks shard response is too large"
  );
  if (!response.ok) {
    throw new Error(`A ListTasks shard returned HTTP ${response.status}.`);
  }
  const value = parseLosslessJson(body);
  const envelope = requiredRecord(value, "ListTasks shard response");
  if (envelope.jsonrpc !== "2.0" || rpcId(envelope.id) !== requestId) {
    throw new Error("A ListTasks shard returned an invalid JSON-RPC envelope.");
  }
  if (!Object.hasOwn(envelope, "result") && !isRecord(envelope.error)) {
    throw new Error("A ListTasks shard response has no result or error.");
  }
  return envelope;
}

function listShardPage(value: unknown): ListShardPage {
  const result = requiredRecord(value, "ListTasks shard result");
  if (!Array.isArray(result.tasks)) {
    throw new Error("ListTasks shard result.tasks must be an array.");
  }
  const nextPageToken = result.nextPageToken;
  const pageSize = result.pageSize;
  const totalSize = result.totalSize;
  if (typeof nextPageToken !== "string") {
    throw new Error("ListTasks shard nextPageToken must be a string.");
  }
  if (!Number.isSafeInteger(pageSize) || (pageSize as number) < 1) {
    throw new Error("ListTasks shard pageSize must be a positive integer.");
  }
  if (!Number.isSafeInteger(totalSize) || (totalSize as number) < 0) {
    throw new Error(
      "ListTasks shard totalSize must be a non-negative integer."
    );
  }
  return {
    nextPageToken,
    pageSize: pageSize as number,
    tasks: result.tasks.map((task, index) => listedTask(task, index)),
    totalSize: totalSize as number
  };
}

function listedTask(value: unknown, index: number): ListedTaskJson {
  const task = requiredRecord(value, `ListTasks shard tasks[${index}]`);
  const id = requiredString(task.id, `ListTasks shard tasks[${index}].id`);
  const status = requiredRecord(
    task.status,
    `ListTasks shard tasks[${index}].status`
  );
  const timestamp = status.timestamp;
  if (timestamp !== undefined && typeof timestamp !== "string") {
    throw new Error(
      `ListTasks shard tasks[${index}].status.timestamp must be a string.`
    );
  }
  return {
    id,
    serializedBytes: textEncoder.encode(JSON.stringify(task)).byteLength,
    statusTimestamp: timestamp ?? "",
    value: task
  };
}

function compareListedTasks(
  left: ListedTaskJson,
  right: ListedTaskJson
): number {
  if (left.statusTimestamp !== right.statusTimestamp) {
    return left.statusTimestamp > right.statusTimestamp ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

function normalizedListParams(
  value: Record<string, unknown>
): ListTasksRequest {
  const params = ListTasksRequest.fromJSON(value);
  if (params.statusTimestampAfter) {
    params.statusTimestampAfter = normalizeStatusTimestampAfter(
      params.statusTimestampAfter
    );
  }
  return params;
}

function listEnvelope(
  id: string | number | null,
  tasks: ListedTaskJson[],
  nextPageToken: string,
  pageSize: number,
  totalSize: number
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      tasks: tasks.map((task) => task.value),
      nextPageToken,
      pageSize,
      totalSize
    }
  });
}

function listEnvelopeByteLength(
  id: string | number | null,
  serializedTasksBytes: number,
  taskCount: number,
  nextPageToken: string,
  pageSize: number,
  totalSize: number
): number {
  const emptyEnvelope = listEnvelope(
    id,
    [],
    nextPageToken,
    pageSize,
    totalSize
  );
  return (
    textEncoder.encode(emptyEnvelope).byteLength +
    serializedTasksBytes +
    Math.max(0, taskCount - 1)
  );
}

function shardName(ownerName: string, shard: number): string {
  return `${ownerName}:a2a-shard:${shard}`;
}

function forwardRequest(request: Request, body: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("x-agents-lifecycle-")) {
      headers.delete(name);
    }
  }
  return new Request(request.url, {
    method: "POST",
    headers,
    body,
    signal: request.signal
  });
}

/** Derives a stable first-turn context from the caller's idempotency key. */
async function contextIdFromMessage(
  message: Record<string, unknown>
): Promise<string> {
  if (typeof message.messageId !== "string" || !message.messageId) {
    throw new Error("params.message.messageId must be a non-empty string");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(message.messageId)
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcId(value: unknown): string | number | null {
  return isValidJsonRpcRequestId(value) ? value : null;
}

/** Builds a JSON-RPC error while preserving any valid request ID. */
function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  detail?: string
): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(detail ? { data: { detail } } : {}) }
  });
}

/** Safely turns any thrown value into an error message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
