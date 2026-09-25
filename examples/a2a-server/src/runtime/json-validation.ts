import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type Task
} from "@a2a-js/sdk";

const DATA_NULL_SENTINEL = Object.freeze(Object.create(null)) as object;
const PART_PAYLOAD_KEYS = ["text", "raw", "url", "data"] as const;
const textEncoder = new TextEncoder();
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
export const MAX_JSON_RPC_REQUEST_ID_BYTES = 256;
const ROLE_VALUES = new Map<string | number, Role>([
  ["ROLE_UNSPECIFIED", Role.ROLE_UNSPECIFIED],
  [Role.ROLE_UNSPECIFIED, Role.ROLE_UNSPECIFIED],
  ["ROLE_USER", Role.ROLE_USER],
  [Role.ROLE_USER, Role.ROLE_USER],
  ["ROLE_AGENT", Role.ROLE_AGENT],
  [Role.ROLE_AGENT, Role.ROLE_AGENT]
]);
const TASK_STATE_VALUES = new Map<string | number, TaskState>([
  ["TASK_STATE_UNSPECIFIED", TaskState.TASK_STATE_UNSPECIFIED],
  [TaskState.TASK_STATE_UNSPECIFIED, TaskState.TASK_STATE_UNSPECIFIED],
  ["TASK_STATE_SUBMITTED", TaskState.TASK_STATE_SUBMITTED],
  [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_SUBMITTED],
  ["TASK_STATE_WORKING", TaskState.TASK_STATE_WORKING],
  [TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_WORKING],
  ["TASK_STATE_COMPLETED", TaskState.TASK_STATE_COMPLETED],
  [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_COMPLETED],
  ["TASK_STATE_FAILED", TaskState.TASK_STATE_FAILED],
  [TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_FAILED],
  ["TASK_STATE_CANCELED", TaskState.TASK_STATE_CANCELED],
  [TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_CANCELED],
  ["TASK_STATE_INPUT_REQUIRED", TaskState.TASK_STATE_INPUT_REQUIRED],
  [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_INPUT_REQUIRED],
  ["TASK_STATE_REJECTED", TaskState.TASK_STATE_REJECTED],
  [TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_REJECTED],
  ["TASK_STATE_AUTH_REQUIRED", TaskState.TASK_STATE_AUTH_REQUIRED],
  [TaskState.TASK_STATE_AUTH_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED]
]);
const INTERNAL_ARTIFACT_KEYS = new Set([
  "artifactId",
  "name",
  "description",
  "parts",
  "metadata",
  "extensions"
]);
const INTERNAL_PART_KEYS = new Set([
  "content",
  "metadata",
  "filename",
  "mediaType"
]);
const INTERNAL_CONTENT_KEYS = new Set(["$case", "value"]);

/** Parses JSON after checking details that JSON.parse would otherwise lose. */
export function parseLosslessJson(source: string): unknown {
  const value: unknown = JSON.parse(source);
  new JsonTextInspector(source).inspect();
  assertJsonCompatible(value, "JSON body");
  return value;
}

/** Validates every value the SDK JSON-RPC transport may coerce with fromJSON. */
export function validateA2AJsonRpcRequest(
  value: unknown
): asserts value is Record<string, unknown> {
  validateJsonRpcEnvelope(value);
  const request = value;

  const method = request.method;
  if (method === "GetExtendedAgentCard") {
    if (request.params !== undefined) {
      validateTenant(requiredRecord(request.params, "params"), "params");
    }
    return;
  }
  const params = requiredRecord(request.params, "params");
  validateTenant(params, "params");

  switch (method) {
    case "SendMessage":
    case "SendStreamingMessage":
      validateSendMessage(params);
      return;
    case "GetTask":
      requiredString(params.id, "params.id");
      optionalNonNegativeInteger(
        params,
        ["historyLength", "history_length"],
        "params"
      );
      return;
    case "ListTasks":
      optionalString(params, ["contextId", "context_id"], "params");
      optionalTaskState(params, ["status"], "params");
      optionalInteger(params, ["pageSize", "page_size"], "params");
      if (
        typeof params.pageSize === "number" &&
        (params.pageSize < 1 || params.pageSize > 100)
      ) {
        throw new Error("params.pageSize must be between 1 and 100.");
      }
      optionalString(params, ["pageToken", "page_token"], "params");
      optionalNonNegativeInteger(
        params,
        ["historyLength", "history_length"],
        "params"
      );
      optionalString(
        params,
        ["statusTimestampAfter", "status_timestamp_after"],
        "params"
      );
      if (typeof params.statusTimestampAfter === "string") {
        params.statusTimestampAfter = normalizeStatusTimestampAfter(
          params.statusTimestampAfter,
          "params.statusTimestampAfter"
        );
      }
      optionalBoolean(
        params,
        ["includeArtifacts", "include_artifacts"],
        "params"
      );
      return;
    case "CancelTask":
      requiredString(params.id, "params.id");
      optionalMetadata(params, "metadata", "params");
      return;
    case "SubscribeToTask":
      requiredString(params.id, "params.id");
      return;
    case "CreateTaskPushNotificationConfig":
      validatePushNotificationConfig(params, "params");
      return;
    case "GetTaskPushNotificationConfig":
    case "DeleteTaskPushNotificationConfig":
      requiredAliasedString(params, ["taskId", "task_id"], "params");
      requiredString(params.id, "params.id");
      return;
    case "ListTaskPushNotificationConfigs":
      requiredAliasedString(params, ["taskId", "task_id"], "params");
      optionalInteger(params, ["pageSize", "page_size"], "params");
      optionalString(params, ["pageToken", "page_token"], "params");
      return;
    default:
      return;
  }
}

/** Validates only the JSON-RPC envelope so method errors stay distinguishable. */
export function validateJsonRpcEnvelope(
  value: unknown
): asserts value is Record<string, unknown> {
  const request = requiredRecord(value, "JSON-RPC body");
  if (request.jsonrpc !== "2.0") {
    throw new Error('jsonrpc must be exactly "2.0".');
  }
  requiredString(request.method, "method");
  if (!Object.hasOwn(request, "id") || request.id === null) {
    throw new Error("id is required and must not be null.");
  }
  if (!isValidJsonRpcRequestId(request.id)) {
    throw new Error(
      `id must be a string of at most ${MAX_JSON_RPC_REQUEST_ID_BYTES} UTF-8 bytes or a safe integer.`
    );
  }
}

/** Returns whether a value is a bounded, non-null A2A JSON-RPC request ID. */
export function isValidJsonRpcRequestId(
  value: unknown
): value is string | number {
  return (
    (typeof value === "string" &&
      textEncoder.encode(value).byteLength <= MAX_JSON_RPC_REQUEST_ID_BYTES) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

/** Validates and normalizes an A2A timestamp filter to server millisecond precision. */
export function normalizeStatusTimestampAfter(
  value: string,
  path = "statusTimestampAfter"
): string {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${path} must be an ISO 8601 UTC timestamp ending in Z.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const millisecond = Number(fraction.slice(0, 3).padEnd(3, "0"));
  const timestamp = new Date(0);
  timestamp.setUTCFullYear(year, month - 1, day);
  timestamp.setUTCHours(hour, minute, second, millisecond);
  if (
    year < 1 ||
    year > 9999 ||
    timestamp.getUTCFullYear() !== year ||
    timestamp.getUTCMonth() !== month - 1 ||
    timestamp.getUTCDate() !== day ||
    timestamp.getUTCHours() !== hour ||
    timestamp.getUTCMinutes() !== minute ||
    timestamp.getUTCSeconds() !== second
  ) {
    throw new Error(`${path} must be a valid ISO 8601 UTC timestamp.`);
  }

  if (/[1-9]/.test(fraction.slice(3))) {
    timestamp.setTime(timestamp.getTime() + 1);
    if (timestamp.getUTCFullYear() > 9999) {
      throw new Error(`${path} exceeds the supported timestamp range.`);
    }
  }
  return timestamp.toISOString();
}

/** Validates protocol JSON for an Artifact before Artifact.fromJSON runs. */
export function validateArtifactJson(value: unknown, path = "artifact"): void {
  assertJsonCompatible(value, path);
  const artifact = requiredRecord(value, path);
  requiredAliasedString(artifact, ["artifactId", "artifact_id"], path);
  optionalString(artifact, ["name"], path);
  optionalString(artifact, ["description"], path);
  const parts = requiredArray(artifact.parts, `${path}.parts`);
  if (parts.length === 0) throw new Error(`${path}.parts must not be empty.`);
  parts.forEach((part, index) => validatePart(part, `${path}.parts[${index}]`));
  optionalMetadata(artifact, "metadata", path);
  optionalStringArray(artifact, ["extensions"], path);
}

/** Strictly validates an SDK-shaped Artifact before serialization or storage. */
export function validateArtifactValue(
  value: unknown,
  path = "artifact"
): asserts value is Artifact {
  const artifact = requiredPlainDataRecord(value, path);
  assertOnlyKeys(artifact, INTERNAL_ARTIFACT_KEYS, path);
  requiredOwnString(artifact, "artifactId", path, true);
  requiredOwnString(artifact, "name", path);
  requiredOwnString(artifact, "description", path);
  const parts = requiredDenseArray(artifact.parts, `${path}.parts`);
  if (parts.length === 0) throw new Error(`${path}.parts must not be empty.`);
  parts.forEach((part, index) =>
    validateInternalPart(part, `${path}.parts[${index}]`)
  );
  optionalInternalMetadata(artifact, "metadata", path);
  requiredInternalStringArray(artifact, "extensions", path);
}

/** Validates an array and every SDK-shaped Artifact it contains. */
export function validateArtifactValues(
  value: unknown,
  path = "artifacts"
): asserts value is Artifact[] {
  const artifacts = requiredDenseArray(value, path);
  artifacts.forEach((artifact, index) =>
    validateArtifactValue(artifact, `${path}[${index}]`)
  );
}

export interface ValidatedTaskJson {
  contextId: string;
  id: string;
  state: TaskState;
  statusTimestamp: string | undefined;
  value: Record<string, unknown>;
}

/** Validates a raw persisted Task before any SDK coercion is allowed. */
export function validateTaskJson(
  value: unknown,
  path = "task"
): ValidatedTaskJson {
  assertJsonCompatible(value, path);
  const task = requiredRecord(value, path);
  const id = requiredString(task.id, `${path}.id`);
  const contextId = requiredAliasedString(
    task,
    ["contextId", "context_id"],
    path
  );
  const status = requiredRecord(task.status, `${path}.status`);
  const state = Object.hasOwn(status, "state")
    ? assertTaskState(status.state, `${path}.status.state`)
    : TaskState.TASK_STATE_UNSPECIFIED;
  if (Object.hasOwn(status, "message")) {
    validateMessageJson(status.message, `${path}.status.message`);
  }
  let statusTimestamp: string | undefined;
  if (Object.hasOwn(status, "timestamp")) {
    if (typeof status.timestamp !== "string") {
      throw new Error(`${path}.status.timestamp must be a string.`);
    }
    statusTimestamp = status.timestamp;
  }

  if (Object.hasOwn(task, "history")) {
    const history = requiredArray(task.history, `${path}.history`);
    history.forEach((message, index) =>
      validateMessageJson(message, `${path}.history[${index}]`)
    );
  }
  if (Object.hasOwn(task, "artifacts")) {
    const artifacts = requiredArray(task.artifacts, `${path}.artifacts`);
    artifacts.forEach((artifact, index) =>
      validateArtifactJson(artifact, `${path}.artifacts[${index}]`)
    );
  }
  optionalMetadata(task, "metadata", path);
  return { contextId, id, state, statusTimestamp, value: task };
}

/** Validates protocol JSON for one Message before Message.fromJSON runs. */
export function validateMessageJson(value: unknown, path = "message"): void {
  assertJsonCompatible(value, path);
  const message = requiredRecord(value, path);
  requiredAliasedString(message, ["messageId", "message_id"], path);
  optionalString(message, ["contextId", "context_id"], path);
  optionalString(message, ["taskId", "task_id"], path);
  const role = aliasedField(message, ["role"], path);
  if (!role.present) throw new Error(`${path}.role is required.`);
  assertRole(role.value, role.path);
  const parts = requiredArray(message.parts, `${path}.parts`);
  if (parts.length === 0) throw new Error(`${path}.parts must not be empty.`);
  parts.forEach((part, index) => validatePart(part, `${path}.parts[${index}]`));
  optionalMetadata(message, "metadata", path);
  optionalStringArray(message, ["extensions"], path);
  optionalStringArray(
    message,
    ["referenceTaskIds", "reference_task_ids"],
    path
  );
}

/** Preserves an explicit data:null while the SDK resolves the Part oneof. */
export function prepareA2ARequestForSdk(
  request: Record<string, unknown>
): void {
  if (
    request.method !== "SendMessage" &&
    request.method !== "SendStreamingMessage"
  )
    return;
  const params = request.params;
  if (!isRecord(params) || !isRecord(params.message)) return;
  preparePartsForSdk(params.message.parts);
}

/** Preserves an explicit data:null in an Artifact callback before fromJSON. */
export function prepareArtifactJsonForSdk(
  value: Record<string, unknown>
): void {
  preparePartsForSdk(value.parts);
}

/** Preserves explicit data:null values in one raw Message object. */
export function prepareMessageJsonForSdk(value: Record<string, unknown>): void {
  preparePartsForSdk(value.parts);
}

/** Preserves explicit data:null values throughout a raw Task object. */
export function prepareTaskJsonForSdk(value: Record<string, unknown>): void {
  if (Array.isArray(value.history)) {
    for (const message of value.history) {
      if (isRecord(message)) prepareMessageJsonForSdk(message);
    }
  }
  if (Array.isArray(value.artifacts)) {
    for (const artifact of value.artifacts) {
      if (isRecord(artifact)) prepareArtifactJsonForSdk(artifact);
    }
  }
  if (isRecord(value.status) && isRecord(value.status.message)) {
    prepareMessageJsonForSdk(value.status.message);
  }
}

/** Restores the sentinel after Message.fromJSON has selected its data oneof. */
export function restoreMessageDataNull(message: Message): void {
  restorePartsDataNull(message.parts);
}

/** Restores the sentinel after Artifact.fromJSON has selected its data oneof. */
export function restoreArtifactDataNull(artifact: Artifact): void {
  restorePartsDataNull(artifact.parts);
}

/** Restores explicit data:null values throughout a decoded Task. */
export function restoreTaskDataNull(task: Task): void {
  for (const message of task.history) restoreMessageDataNull(message);
  for (const artifact of task.artifacts) restoreArtifactDataNull(artifact);
  if (task.status?.message) restoreMessageDataNull(task.status.message);
}

/** Rejects values that cannot make a lossless JSON round trip. */
export function assertJsonCompatible(value: unknown, path = "value"): void {
  validateJsonValue(value, path, new Set<object>());
}

/** Requires a JSON object, rather than silently replacing malformed metadata. */
export function assertJsonObject(
  value: unknown,
  path = "value"
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be a JSON object.`);
  assertJsonCompatible(value, path);
}

function validateSendMessage(params: Record<string, unknown>): void {
  validateMessageJson(params.message, "params.message");

  if (params.configuration !== undefined) {
    const configuration = requiredRecord(
      params.configuration,
      "params.configuration"
    );
    optionalStringArray(
      configuration,
      ["acceptedOutputModes", "accepted_output_modes"],
      "params.configuration"
    );
    const push = aliasedField(
      configuration,
      ["taskPushNotificationConfig", "task_push_notification_config"],
      "params.configuration"
    );
    if (push.present) {
      validatePushNotificationConfig(
        requiredRecord(push.value, `${push.path}`),
        push.path
      );
    }
    optionalNonNegativeInteger(
      configuration,
      ["historyLength", "history_length"],
      "params.configuration"
    );
    optionalBoolean(
      configuration,
      ["returnImmediately", "return_immediately"],
      "params.configuration"
    );
  }
  optionalMetadata(params, "metadata", "params");
}

function validatePart(value: unknown, path: string): void {
  const part = requiredRecord(value, path);
  const payloads = PART_PAYLOAD_KEYS.filter((key) => Object.hasOwn(part, key));
  if (payloads.length !== 1) {
    throw new Error(
      `${path} must contain exactly one of text, raw, url, or data.`
    );
  }
  const payload = payloads[0]!;
  if (payload === "text" || payload === "raw" || payload === "url") {
    const content = part[payload];
    if (typeof content !== "string") {
      throw new Error(`${path}.${payload} must be a string.`);
    }
    if (payload === "raw") assertCanonicalBase64(content, `${path}.raw`);
  } else {
    assertJsonCompatible(part.data, `${path}.data`);
  }
  optionalMetadata(part, "metadata", path);
  optionalString(part, ["filename"], path);
  optionalString(part, ["mediaType", "media_type"], path);
}

function validateInternalPart(value: unknown, path: string): void {
  const part = requiredPlainDataRecord(value, path);
  assertOnlyKeys(part, INTERNAL_PART_KEYS, path);
  const content = requiredPlainDataRecord(part.content, `${path}.content`);
  assertOnlyKeys(content, INTERNAL_CONTENT_KEYS, `${path}.content`);
  if (!Object.hasOwn(content, "$case") || !Object.hasOwn(content, "value")) {
    throw new Error(`${path}.content must contain $case and value.`);
  }
  switch (content.$case) {
    case "text":
    case "url":
      if (typeof content.value !== "string") {
        throw new Error(`${path}.content.value must be a string.`);
      }
      break;
    case "raw":
      if (!(content.value instanceof Uint8Array)) {
        throw new Error(`${path}.content.value must be binary data.`);
      }
      break;
    case "data":
      assertJsonCompatible(content.value, `${path}.content.value`);
      break;
    default:
      throw new Error(`${path}.content.$case is not a supported Part payload.`);
  }
  optionalInternalMetadata(part, "metadata", path);
  requiredOwnString(part, "filename", path);
  requiredOwnString(part, "mediaType", path);
}

function assertCanonicalBase64(value: string, path: string): void {
  const hasStandardAlphabet = /[+/]/.test(value);
  const hasUrlSafeAlphabet = /[-_]/.test(value);
  if (hasStandardAlphabet && hasUrlSafeAlphabet) {
    throw new Error(`${path} must use one base64 alphabet.`);
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error(`${path} must be valid base64.`);
  }
  try {
    const unpadded = normalized.replace(/=+$/, "");
    if (unpadded.length % 4 === 1) throw new Error("invalid length");
    const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
    const canonicalPadded = btoa(atob(padded));
    const canonicalUnpadded = canonicalPadded.replace(/=+$/, "");
    if (normalized !== canonicalPadded && normalized !== canonicalUnpadded) {
      throw new Error("non-canonical");
    }
  } catch {
    throw new Error(`${path} must be valid canonical base64.`);
  }
}

function validatePushNotificationConfig(
  config: Record<string, unknown>,
  path: string
): void {
  validateTenant(config, path);
  optionalString(config, ["id"], path);
  optionalString(config, ["taskId", "task_id"], path);
  optionalString(config, ["url"], path);
  optionalString(config, ["token"], path);
  if (config.authentication !== undefined) {
    const authentication = requiredRecord(
      config.authentication,
      `${path}.authentication`
    );
    optionalString(authentication, ["scheme"], `${path}.authentication`);
    optionalString(authentication, ["credentials"], `${path}.authentication`);
  }
}

function validateTenant(value: Record<string, unknown>, path: string): void {
  optionalString(value, ["tenant"], path);
  if (typeof value.tenant === "string" && value.tenant.length > 0) {
    throw new Error(`${path}.tenant is not supported.`);
  }
}

function optionalMetadata(
  value: Record<string, unknown>,
  key: string,
  path: string
): void {
  if (!Object.hasOwn(value, key)) return;
  assertJsonObject(value[key], `${path}.${key}`);
}

function optionalString(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  const field = aliasedField(value, keys, path);
  if (field.present && typeof field.value !== "string") {
    throw new Error(`${field.path} must be a string.`);
  }
}

function requiredAliasedString(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): string {
  const field = aliasedField(value, keys, path);
  if (!field.present) throw new Error(`${path}.${keys[0]} is required.`);
  return requiredString(field.value, field.path);
}

function optionalBoolean(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  const field = aliasedField(value, keys, path);
  if (field.present && typeof field.value !== "boolean") {
    throw new Error(`${field.path} must be a boolean.`);
  }
}

function optionalInteger(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  const field = aliasedField(value, keys, path);
  if (field.present && !Number.isSafeInteger(field.value)) {
    throw new Error(`${field.path} must be a safe integer.`);
  }
}

function optionalNonNegativeInteger(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  const field = aliasedField(value, keys, path);
  if (
    field.present &&
    (!Number.isSafeInteger(field.value) || (field.value as number) < 0)
  ) {
    throw new Error(`${field.path} must be a non-negative safe integer.`);
  }
}

function optionalTaskState(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  const field = aliasedField(value, keys, path);
  if (field.present) assertTaskState(field.value, field.path);
}

function assertRole(value: unknown, path: string): Role {
  const role = ROLE_VALUES.get(value as string | number);
  if (role === undefined) {
    throw new Error(`${path} must be a supported Role name or number.`);
  }
  return role;
}

function assertTaskState(value: unknown, path: string): TaskState {
  const state = TASK_STATE_VALUES.get(value as string | number);
  if (state === undefined) {
    throw new Error(`${path} must be a supported TaskState name or number.`);
  }
  return state;
}

function optionalStringArray(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  const field = aliasedField(value, keys, path);
  if (!field.present) return;
  const items = requiredArray(field.value, field.path);
  if (items.some((item) => typeof item !== "string")) {
    throw new Error(`${field.path} must contain only strings.`);
  }
}

function optionalInternalMetadata(
  value: Record<string, unknown>,
  key: string,
  path: string
): void {
  if (!Object.hasOwn(value, key) || value[key] === undefined) return;
  assertJsonObject(value[key], `${path}.${key}`);
}

function requiredInternalStringArray(
  value: Record<string, unknown>,
  key: string,
  path: string
): void {
  if (!Object.hasOwn(value, key)) {
    throw new Error(`${path}.${key} is required.`);
  }
  const items = requiredDenseArray(value[key], `${path}.${key}`);
  for (let index = 0; index < items.length; index += 1) {
    if (typeof items[index] !== "string") {
      throw new Error(`${path}.${key} must contain only strings.`);
    }
  }
}

function requiredOwnString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  nonBlank = false
): string {
  if (!Object.hasOwn(value, key) || typeof value[key] !== "string") {
    throw new Error(`${path}.${key} must be a string.`);
  }
  const result = value[key];
  if (nonBlank && result.trim().length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string.`);
  }
  return result;
}

function requiredPlainDataRecord(
  value: unknown,
  path: string
): Record<string, unknown> {
  const record = requiredRecord(value, path);
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must not be a class instance.`);
  }
  if (Reflect.ownKeys(record).some((key) => typeof key === "symbol")) {
    throw new Error(`${path} must not contain symbol keys.`);
  }
  for (const key of Object.getOwnPropertyNames(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${path}.${key} must be a plain data property.`);
    }
  }
  return record;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`${path}.${unknown} is not a supported field.`);
  }
}

function requiredDenseArray(value: unknown, path: string): unknown[] {
  const items = requiredArray(value, path);
  if (Object.getPrototypeOf(items) !== Array.prototype) {
    throw new Error(`${path} must not be a class instance.`);
  }
  for (let index = 0; index < items.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(items, index);
    if (!descriptor) {
      throw new Error(`${path} must not contain array holes.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${path}[${index}] must be a plain data property.`);
    }
  }
  const extraKeys = Object.getOwnPropertyNames(items).filter(
    (key) =>
      key !== "length" &&
      (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= items.length)
  );
  if (extraKeys.length > 0)
    throw new Error(`${path} has non-array properties.`);
  if (Reflect.ownKeys(items).some((key) => typeof key === "symbol")) {
    throw new Error(`${path} must not contain symbol keys.`);
  }
  return items;
}

function aliasedField(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
):
  | { present: false; path: string; value: undefined }
  | { present: true; path: string; value: unknown } {
  const present = keys.filter((key) => Object.hasOwn(value, key));
  if (present.length > 1) {
    throw new Error(
      `${path} must not contain multiple aliases for ${keys[0]}.`
    );
  }
  if (present.length === 0) {
    return { present: false, path: `${path}.${keys[0]}`, value: undefined };
  }
  const key = present[0]!;
  const fieldValue = value[key];
  const canonicalKey = keys[0]!;
  if (key !== canonicalKey) {
    value[canonicalKey] = fieldValue;
    delete value[key];
  }
  return { present: true, path: `${path}.${key}`, value: fieldValue };
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function preparePartsForSdk(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (isRecord(item) && Object.hasOwn(item, "data") && item.data === null) {
      item.data = DATA_NULL_SENTINEL;
    }
  }
}

function restorePartsDataNull(parts: Part[]): void {
  for (const part of parts) {
    if (
      part.content?.$case === "data" &&
      part.content.value === DATA_NULL_SENTINEL
    ) {
      part.content.value = null;
    }
  }
}

function validateJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be finite.`);
    if (Object.is(value, -0))
      throw new Error(`${path} must not be negative zero.`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${path} contains an unrepresentable integer.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} is not JSON-compatible.`);
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle.`);
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new Error(`${path} must not contain class instances.`);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    throw new Error(`${path} must not contain symbol keys.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(`${path} must not contain array holes.`);
        }
        validateJsonValue(value[index], `${path}[${index}]`, ancestors);
      }
      const extraKeys = Object.keys(value).filter(
        (key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
      );
      if (extraKeys.length > 0)
        throw new Error(`${path} has non-JSON array keys.`);
      return;
    }

    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`${path}.${key} is not a plain JSON property.`);
      }
      validateJsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class JsonTextInspector {
  private position = 0;

  constructor(private readonly source: string) {}

  inspect(): void {
    this.skipWhitespace();
    this.inspectValue();
    this.skipWhitespace();
    if (this.position !== this.source.length) {
      throw new Error("JSON body contains trailing input.");
    }
  }

  private inspectValue(): void {
    const character = this.source[this.position];
    if (character === "{") return this.inspectObject();
    if (character === "[") return this.inspectArray();
    if (character === '"') {
      this.inspectString();
      return;
    }
    if (character === "t") return this.inspectLiteral("true");
    if (character === "f") return this.inspectLiteral("false");
    if (character === "n") return this.inspectLiteral("null");
    this.inspectNumber();
  }

  private inspectObject(): void {
    this.position += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.source[this.position] === "}") {
      this.position += 1;
      return;
    }
    while (true) {
      const key = this.inspectString();
      if (keys.has(key))
        throw new Error(`JSON object contains duplicate key ${key}.`);
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      this.inspectValue();
      this.skipWhitespace();
      if (this.source[this.position] === "}") {
        this.position += 1;
        return;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private inspectArray(): void {
    this.position += 1;
    this.skipWhitespace();
    if (this.source[this.position] === "]") {
      this.position += 1;
      return;
    }
    while (true) {
      this.inspectValue();
      this.skipWhitespace();
      if (this.source[this.position] === "]") {
        this.position += 1;
        return;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private inspectString(): string {
    const start = this.position;
    this.expect('"');
    while (this.position < this.source.length) {
      const character = this.source[this.position++];
      if (character === "\\") {
        this.position += 1;
        continue;
      }
      if (character === '"') {
        return JSON.parse(this.source.slice(start, this.position)) as string;
      }
    }
    throw new Error("Unterminated JSON string.");
  }

  private inspectLiteral(literal: string): void {
    if (
      this.source.slice(this.position, this.position + literal.length) !==
      literal
    ) {
      throw new Error("Invalid JSON literal.");
    }
    this.position += literal.length;
  }

  private inspectNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.position)
    );
    if (!match) throw new Error("Invalid JSON number.");
    const token = match[0];
    const number = Number(token);
    if (!Number.isFinite(number)) {
      throw new Error(`JSON number ${token} is not finite.`);
    }
    if (Object.is(number, -0)) {
      throw new Error(`JSON number ${token} is negative zero.`);
    }
    if (Number.isInteger(number) && !Number.isSafeInteger(number)) {
      throw new Error(`JSON integer ${token} cannot be represented safely.`);
    }
    if (canonicalDecimal(token) !== canonicalDecimal(number.toString())) {
      throw new Error(`JSON number ${token} cannot be represented exactly.`);
    }
    this.position += token.length;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.position] ?? "")) this.position += 1;
  }

  private expect(character: string): void {
    if (this.source[this.position] !== character) {
      throw new Error(`Expected ${character} in JSON body.`);
    }
    this.position += 1;
  }
}

/** Normalizes equivalent decimal spellings without using floating-point math. */
function canonicalDecimal(token: string): string {
  const match = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw new Error(`Invalid JSON number ${token}.`);
  const negative = match[1] !== undefined;
  const fraction = match[3] ?? "";
  let coefficient = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (coefficient.length === 0) return "0e0";
  let exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length);
  const trailingZeros = /0+$/.exec(coefficient)?.[0].length ?? 0;
  if (trailingZeros > 0) {
    coefficient = coefficient.slice(0, -trailingZeros);
    exponent += BigInt(trailingZeros);
  }
  return `${negative ? "-" : ""}${coefficient}e${exponent}`;
}
