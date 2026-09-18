import { Agent, callable } from "agents";
import { routeAgentRequest } from "agents/routing";
import type {
  TaskEvent,
  TaskEventReceipt,
  TaskHandlers,
  TaskReceipt,
  TaskRunSnapshot,
  TaskStep
} from "agents/tasks";

const DEFINITION = "prepare-brief@v1";
const NOTE_EVENT = "note";
const AUDIENCE_EVENT = "audience";
const RESEARCH_DELAY_MS = 8_000;
const NOTE_LIMIT = 10;

export type BriefInput = {
  topic: string;
};

export type NotePayload = {
  text: string;
};

export type AudiencePayload = {
  audience: string;
  decision: string;
};

export type BriefResult = {
  topic: string;
  summary: string;
  research: string[];
  audience: TaskEvent<AudiencePayload>;
  notes: TaskEvent<NotePayload>[];
};

export type BriefRun = TaskRunSnapshot<BriefResult>;
export type NoteReceipt = TaskEventReceipt<NotePayload>;
export type AudienceReceipt = TaskEventReceipt<AudiencePayload>;

const taskDefinitions = {
  [DEFINITION]: async (
    input: BriefInput,
    step: TaskStep
  ): Promise<BriefResult> => {
    await step.status(
      "Drafting a technical briefing for 8 seconds. Editor notes are buffered while this step runs."
    );
    const draft = await step.do(
      "research",
      { timeout: "30 seconds" },
      async ({ signal }) => {
        await scheduler.wait(RESEARCH_DELAY_MS, { signal });
        return [
          `Define ${input.topic} in one sentence.`,
          `Explain the current relevance of ${input.topic}.`,
          `Identify one concrete signal to watch for ${input.topic}.`
        ];
      }
    );

    await step.status(
      "Reader context needed. Add any final notes, then describe who will read the brief and what decision they face."
    );
    const audience = await step.waitForEvent<AudiencePayload>(
      "wait-for-audience",
      AUDIENCE_EVENT
    );

    await step.status("Reviewing editor notes and tailoring the outline.");
    const notes = await step.takeEvents<NotePayload>(
      "review-notes",
      NOTE_EVENT,
      { limit: NOTE_LIMIT }
    );

    const readerContext = `${audience.payload.audience} (decision: ${audience.payload.decision})`;
    const outline = [
      `Opening for ${readerContext}: ${draft[0]}`,
      `Relevance for ${readerContext}: ${draft[1]}`,
      `Decision support for ${readerContext}: ${draft[2]}`
    ];
    const noteLabel = notes.length === 1 ? "note" : "notes";
    return {
      topic: input.topic,
      summary: `A three-part technical briefing outline about ${input.topic} for ${audience.payload.audience}. Decision to support: ${audience.payload.decision}. The Task reviewed ${notes.length} editor ${noteLabel} from the durable mailbox.`,
      research: outline,
      audience,
      notes
    };
  }
} satisfies TaskHandlers;

function requiredText(
  value: unknown,
  label: string,
  maxLength: number
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
  return text;
}

export class TaskEventsAgent extends Agent<Env> {
  override readonly taskDefinitions = taskDefinitions;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`CREATE TABLE IF NOT EXISTS task_events_demo_note_deliveries (
      run_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      PRIMARY KEY (run_id, delivery_id)
    )`;
  }

  async #assertBriefRun(runId: string): Promise<string> {
    const id = requiredText(runId, "Run ID", 256);
    const run = await this.tasks.handle(DEFINITION).get(id);
    if (!run) throw new Error("Brief run not found.");
    return id;
  }

  #reserveNoteDelivery(runId: string, deliveryId: string): void {
    const [existing] = this.sql<{ present: number }>`
      SELECT 1 AS present
      FROM task_events_demo_note_deliveries
      WHERE run_id = ${runId} AND delivery_id = ${deliveryId}
    `;
    if (existing) return;

    const [row] = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM task_events_demo_note_deliveries
      WHERE run_id = ${runId}
    `;
    if ((row?.count ?? 0) >= NOTE_LIMIT) {
      throw new Error(`A brief accepts at most ${NOTE_LIMIT} notes.`);
    }

    this.sql`
      INSERT INTO task_events_demo_note_deliveries (run_id, delivery_id)
      VALUES (${runId}, ${deliveryId})
    `;
  }

  @callable()
  async startBrief(topic: string, requestId: string): Promise<TaskReceipt> {
    const cleanTopic = requiredText(topic, "Topic", 120);
    const key = requiredText(requestId, "Request ID", 200);
    return this.tasks.run(
      DEFINITION,
      { topic: cleanTopic },
      {
        idempotencyKey: `brief:${key}`,
        metadata: { topic: cleanTopic }
      }
    );
  }

  @callable()
  async getBrief(runId: string): Promise<BriefRun | null> {
    const id = requiredText(runId, "Run ID", 256);
    const run = await this.tasks.handle(DEFINITION).get(id);
    return run as BriefRun | null;
  }

  @callable()
  async sendNote(
    runId: string,
    text: string,
    deliveryId: string
  ): Promise<NoteReceipt> {
    const id = await this.#assertBriefRun(runId);
    const cleanText = requiredText(text, "Note", 280);
    const key = requiredText(deliveryId, "Delivery ID", 200);
    this.#reserveNoteDelivery(id, key);
    return this.tasks.sendEvent(
      id,
      NOTE_EVENT,
      { text: cleanText },
      { idempotencyKey: `note:${key}` }
    );
  }

  @callable()
  async answerAudience(
    runId: string,
    audience: string,
    decision: string
  ): Promise<AudienceReceipt> {
    const id = await this.#assertBriefRun(runId);
    const cleanAudience = requiredText(audience, "Reader", 80);
    const cleanDecision = requiredText(decision, "Decision context", 120);
    return this.tasks.sendEvent(
      id,
      AUDIENCE_EVENT,
      { audience: cleanAudience, decision: cleanDecision },
      { idempotencyKey: "audience:v1" }
    );
  }

  @callable()
  async cancelBrief(runId: string): Promise<boolean> {
    const id = requiredText(runId, "Run ID", 256);
    return this.tasks
      .handle(DEFINITION)
      .cancel(id, "Cancelled from the task event demo");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
