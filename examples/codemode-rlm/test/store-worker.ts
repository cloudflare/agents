import { DurableObject } from "cloudflare:workers";
import { normalizeHarnessUpdate } from "../src/core";
import { RlmStore } from "../src/store";

type TestEnv = { STORE: DurableObjectNamespace<StoreHarness> };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export class StoreHarness extends DurableObject<TestEnv> {
  readonly #store: RlmStore;

  constructor(ctx: DurableObjectState, env: TestEnv) {
    super(ctx, env);
    this.#store = new RlmStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      const body = (await request.json()) as Record<string, unknown>;
      if (url.pathname === "/input") {
        return json(
          this.#store.putInput({
            id: String(body.id),
            scope: "root",
            requestId: String(body.requestId),
            kind: "think",
            task: String(body.task),
            material: String(body.material)
          })
        );
      }
      if (url.pathname === "/visibility") {
        const prefix = String(body.prefix);
        const scope = `visibility:${prefix}`;
        const put = (suffix: string) =>
          this.#store.putInput({
            id: `${prefix}:${suffix}`,
            scope,
            kind: "child",
            task: suffix,
            material: ""
          });
        const first = put("first");
        const second = put("second");
        this.#store.activateInput(first.id, scope);
        const before = this.#store
          .inputs(scope, first.id)
          .map((input) => input.id);
        this.#store.activateInput(second.id, scope);
        return json({
          before,
          fromFirst: this.#store
            .inputs(scope, first.id)
            .map((input) => input.id),
          fromSecond: this.#store
            .inputs(scope, second.id)
            .map((input) => input.id),
          secondVisibleFromFirst: this.#store.inputVisibleFrom(
            scope,
            first.id,
            second.id
          )
        });
      }
      if (url.pathname === "/search") {
        const id = String(body.id);
        this.#store.putInput({
          id,
          scope: "root",
          kind: "child",
          task: "find evidence",
          material: String(body.material)
        });
        return json(this.#store.searchInput(id, "material", "needle", 5));
      }
      if (url.pathname === "/operation") {
        const claim = this.#store.claimOperation({
          id: String(body.id),
          rootInputId: String(body.rootInputId),
          kind: "query",
          key: "same-key",
          argsHash: String(body.argsHash),
          childId: String(body.childId),
          turnInputId: String(body.turnInputId),
          maximum: Number(body.maximum ?? 2)
        });
        return json({
          created: claim.created,
          used: this.#store.rlmCalls(String(body.rootInputId))
        });
      }
      if (url.pathname === "/answer") {
        const inputId = String(body.inputId);
        const executionId = String(body.executionId);
        this.#store.stageAnswer("root", inputId, "done", executionId);
        const before = this.#store.answerRecord(inputId);
        this.#store.verifyAnswer(inputId, executionId);
        return json({
          before: before?.content ?? null,
          after: this.#store.answerRecord(inputId)?.content
        });
      }
      if (url.pathname === "/answer-execution") {
        const inputId = String(body.inputId);
        this.#store.stageAnswer("root", inputId, "first", "exec-a");
        const verified = this.#store.verifyAnswer(inputId, "exec-a");
        return json({
          verified,
          wrongExecution: this.#store.verifyAnswer(inputId, "exec-b")
        });
      }
      if (url.pathname === "/answer-race") {
        this.#store.stageAnswer("root", "failed-later", "first", "exec-a");
        this.#store.stageAnswer("root", "failed-later", "second", "exec-b");
        this.#store.discardAnswer("failed-later", "exec-b");
        const recovered = this.#store.verifyAnswer("failed-later", "exec-a");

        this.#store.stageAnswer("root", "completed-later", "first", "exec-a");
        this.#store.stageAnswer("root", "completed-later", "second", "exec-b");
        const winner = this.#store.verifyAnswer("completed-later", "exec-b");
        const loser = this.#store.verifyAnswer("completed-later", "exec-a");

        this.#store.stageAnswer("root", "rolled-back", "answer", "exec-r");
        this.#store.verifyAnswer("rolled-back", "exec-r");
        this.#store.discardAnswer("rolled-back", "exec-r");
        return json({
          recovered,
          recoveredAnswer: this.#store.answerRecord("failed-later")?.content,
          winner,
          loser,
          winnerAnswer: this.#store.answerRecord("completed-later")?.content,
          rolledBack: this.#store.answerRecord("rolled-back")?.content ?? null
        });
      }
      if (url.pathname === "/failed-answer") {
        const inputId = String(body.inputId);
        const executionId = String(body.executionId);
        this.#store.stageAnswer("root", inputId, "discard me", executionId);
        this.#store.discardAnswer(inputId, executionId);
        return json({
          answer: this.#store.answerRecord(inputId)?.content ?? null
        });
      }
      if (url.pathname === "/harness") {
        const state = this.#store.updateHarness(
          `refine-${this.#store.harness().revision}`,
          normalizeHarnessUpdate({
            expectedRevision: this.#store.harness().revision,
            reason: String(body.reason),
            evidence: "test evidence",
            upsert: [
              {
                id: String(body.id),
                kind: "memory",
                content: String(body.content)
              }
            ]
          })
        );
        return json(state);
      }
      if (url.pathname === "/rollback") {
        const state = this.#store.rollbackHarness(
          "refine-rollback",
          this.#store.harness().revision,
          body.targetRevision,
          "test rollback"
        );
        return json({ revision: state.revision, entries: state.entries });
      }
      if (url.pathname === "/kernel-cap") {
        for (let index = 0; index < 256; index += 1) {
          this.#store.setKernel("root", `key-${index}`, index);
        }
        this.#store.setKernel("root", "key-0", "updated");
        try {
          this.#store.setKernel("root", "overflow", true);
          return json({ rejected: false });
        } catch (error) {
          return json({
            rejected: true,
            existing: this.#store.getKernel("root", "key-0"),
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (url.pathname === "/harness-once") {
        const update = normalizeHarnessUpdate({
          expectedRevision: this.#store.harness().revision,
          reason: "first mutation",
          evidence: "test evidence",
          upsert: [{ id: "one", kind: "memory", content: "first" }]
        });
        const first = this.#store.updateHarness("one-refinement", update);
        const replay = this.#store.updateHarness("one-refinement", update);
        try {
          this.#store.updateHarness(
            "one-refinement",
            normalizeHarnessUpdate({
              expectedRevision: first.revision,
              reason: "second mutation",
              evidence: "different evidence",
              upsert: [{ id: "two", kind: "memory", content: "second" }]
            })
          );
          return json({ rejected: false });
        } catch (error) {
          return json({
            firstRevision: first.revision,
            replayRevision: replay.revision,
            rejected: true,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (url.pathname === "/history-limit") {
        const scope = "history";
        for (let index = 0; index < 6; index += 1) {
          const input = this.#store.putInput({
            id: `pending-${index}`,
            scope,
            kind: "child",
            task: index === 0 ? "x".repeat(70_000) : `pending ${index}`,
            material: ""
          });
          this.#store.activateInput(input.id, scope);
        }
        return json(this.#store.history(scope, 6));
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        409
      );
    }
  }
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const instance =
      new URL(request.url).searchParams.get("instance") ?? "store";
    return env.STORE.get(env.STORE.idFromName(instance)).fetch(request);
  }
} satisfies ExportedHandler<TestEnv>;
