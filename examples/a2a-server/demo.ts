import {
  AgentCard,
  parseSseStream,
  StreamResponse,
  Task,
  TaskState,
  type Artifact,
  type Message
} from "@a2a-js/sdk";
import { parseDemoArguments } from "./src/demo-args";

const { baseUrl, prompt } = parseDemoArguments(
  process.argv.slice(2),
  process.env.A2A_BASE_URL
);
const token = process.env.A2A_BEARER_TOKEN;

if (!token) {
  throw new Error("Set A2A_BEARER_TOKEN before running the demo.");
}

const [coordinator, specialist] = await Promise.all([
  discover("coordinator"),
  discover("specialist")
]);

console.log(
  `Coordinator Card: ${coordinator.name} -> ${endpoint(coordinator)}`
);
console.log(`Specialist Card: ${specialist.name} -> ${endpoint(specialist)}`);
console.log(`\nPrompt: ${prompt}\n`);

const requestId = crypto.randomUUID();
const response = await fetch(endpoint(coordinator), {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "SendStreamingMessage",
    params: {
      message: {
        messageId: requestId,
        contextId: crypto.randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: prompt }]
      },
      configuration: {}
    }
  })
});

if (!response.ok) {
  throw new Error(
    `Coordinator stream failed (${response.status}): ${await response.text()}`
  );
}

let coordinatorTaskId = "";
for await (const event of parseSseStream(response)) {
  const envelope = JSON.parse(event.data) as {
    error?: { message?: string };
    result?: unknown;
  };
  if (envelope.error) {
    throw new Error(envelope.error.message ?? "Coordinator stream failed.");
  }
  const update = StreamResponse.fromJSON(envelope.result);
  const payload = update.payload;
  if (!payload) continue;
  if (payload.$case === "task") {
    coordinatorTaskId = payload.value.id;
    console.log(`Coordinator task: ${coordinatorTaskId}`);
  } else if (payload.$case === "statusUpdate") {
    coordinatorTaskId ||= payload.value.taskId;
    console.log(`Status: ${stateName(payload.value.status?.state)}`);
    printMessage(payload.value.status?.message);
  } else if (payload.$case === "artifactUpdate") {
    coordinatorTaskId ||= payload.value.taskId;
    printArtifact(payload.value.artifact);
  }
}

if (!coordinatorTaskId) throw new Error("The stream did not return a task ID.");
const completed = await getTask(endpoint(coordinator), coordinatorTaskId);
console.log(`\nCoordinator task: ${completed.id}`);
console.log(
  `Specialist task: ${String(completed.metadata?.specialistTaskId ?? "unknown")}`
);
console.log(
  `Continuation request: ${String(completed.metadata?.specialistQuestion ?? "unknown")}`
);
console.log(
  `Continuation response: ${String(completed.metadata?.specialistContinuationResponse ?? "unknown")}`
);
printMessage(completed.status?.message);

async function discover(
  route: "coordinator" | "specialist"
): Promise<AgentCard> {
  const response = await fetch(
    `${baseUrl}/${route}/.well-known/agent-card.json`
  );
  if (!response.ok) {
    throw new Error(
      `Agent Card discovery failed for ${route}: ${response.status}`
    );
  }
  return AgentCard.fromJSON(await response.json());
}

function endpoint(card: AgentCard): string {
  const supported = card.supportedInterfaces.find(
    (value) => value.protocolBinding === "JSONRPC"
  );
  if (!supported) throw new Error(`${card.name} has no JSON-RPC endpoint.`);
  return supported.url;
}

async function getTask(url: string, taskId: string): Promise<Task> {
  const response = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "GetTask",
      params: { id: taskId }
    })
  });
  const envelope = (await response.json()) as {
    error?: { message?: string };
    result?: unknown;
  };
  if (!response.ok || envelope.error) {
    throw new Error(
      envelope.error?.message ?? `GetTask failed (${response.status}).`
    );
  }
  return Task.fromJSON(envelope.result);
}

function headers(): Record<string, string> {
  return {
    "A2A-Version": "1.0",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

function stateName(state: TaskState | undefined): string {
  return state === undefined ? "unknown" : TaskState[state].toLowerCase();
}

function printArtifact(artifact: Artifact | undefined): void {
  if (!artifact) return;
  const text = artifact.parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .filter(Boolean)
    .join("\n");
  console.log(`Artifact [${artifact.artifactId}]: ${text}`);
}

function printMessage(message: Message | undefined): void {
  if (!message) return;
  const text = message.parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .filter(Boolean)
    .join("\n");
  if (text) console.log(text);
}
