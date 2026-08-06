import { DurableObject } from "cloudflare:workers";
import { ThinkStore } from "../src/store";

type TestEnv = {
  STORE: DurableObjectNamespace<StoreHarness>;
};

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export class StoreHarness extends DurableObject<TestEnv> {
  readonly #store: ThinkStore;

  constructor(ctx: DurableObjectState, env: TestEnv) {
    super(ctx, env);
    this.#store = new ThinkStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/input") {
        const body = (await request.json()) as {
          id: string;
          task: string;
          material: string;
        };
        return response(
          this.#store.addInputWithId("root", body.id, body.task, body.material)
        );
      }
      if (request.method === "POST" && url.pathname === "/visibility") {
        const body = (await request.json()) as { prefix: string };
        const scope = `visibility:${body.prefix}`;
        const first = `${body.prefix}:first`;
        const second = `${body.prefix}:second`;
        this.#store.addInputWithId(scope, first, "first", "");
        this.#store.addInputWithId(scope, second, "second", "");
        this.#store.activateInput(first, scope);
        const before = this.#store
          .inputs(scope, first)
          .map((input) => input.id);
        this.#store.activateInput(second, scope);
        return response({
          before,
          fromFirst: this.#store.inputs(scope, first).map((input) => input.id),
          fromSecond: this.#store
            .inputs(scope, second)
            .map((input) => input.id),
          secondVisibleFromFirst: this.#store.inputVisibleFrom(
            scope,
            first,
            second
          )
        });
      }
      if (request.method === "POST" && url.pathname === "/operation") {
        const body = (await request.json()) as {
          id: string;
          rootInputId: string;
          argsHash: string;
          childId: string;
          turnInputId: string;
          executionId: string;
        };
        const claim = this.#store.claimRlmOperation({
          id: body.id,
          rootInputId: body.rootInputId,
          kind: "query",
          key: "same-key",
          argsHash: body.argsHash,
          childId: body.childId,
          turnInputId: body.turnInputId,
          sourceExecutionId: body.executionId,
          maximum: 2
        });
        return response({
          ...claim,
          used: this.#store.rlmCalls(body.rootInputId)
        });
      }
      if (request.method === "POST" && url.pathname === "/request") {
        const body = (await request.json()) as {
          requestId: string;
          argsHash: string;
          inputId: string;
        };
        return response(
          this.#store.claimRootRequest({
            requestId: body.requestId,
            kind: "think",
            argsHash: body.argsHash,
            inputId: body.inputId
          })
        );
      }
      if (request.method === "POST" && url.pathname === "/transcript") {
        const body = (await request.json()) as { inputId: string };
        const firstUser = this.#store.recordTurnMessage(
          "root",
          body.inputId,
          "user",
          "question"
        );
        const secondUser = this.#store.recordTurnMessage(
          "root",
          body.inputId,
          "user",
          "question"
        );
        const firstAnswer = this.#store.recordTurnMessage(
          "root",
          body.inputId,
          "assistant",
          "answer"
        );
        const secondAnswer = this.#store.recordTurnMessage(
          "root",
          body.inputId,
          "assistant",
          "answer"
        );
        return response({
          writes: [firstUser, secondUser, firstAnswer, secondAnswer],
          messages: this.#store.messageCount("root")
        });
      }
      if (request.method === "POST" && url.pathname === "/execution") {
        const body = (await request.json()) as {
          executionId: string;
          inputId: string;
        };
        this.#store.bindExecution({
          executionId: body.executionId,
          scope: "root",
          inputId: body.inputId,
          runMode: "think"
        });
        this.#store.finish("root", body.inputId, "done", body.executionId);
        this.#store.finalizeExecution({
          executionId: body.executionId,
          scope: "root",
          inputId: body.inputId,
          runMode: "think",
          status: "completed"
        });
        return response({
          status: this.#store.executionStatus(body.executionId),
          belongs: this.#store.executionBelongs(
            body.executionId,
            "root",
            body.inputId
          ),
          answer: this.#store.answer(body.inputId)
        });
      }
      if (request.method === "POST" && url.pathname === "/child-cas") {
        const body = (await request.json()) as { prefix: string };
        const childId = `${body.prefix}:child`;
        const firstInput = `${body.prefix}:input-1`;
        const secondInput = `${body.prefix}:input-2`;
        this.#store.createChild({
          id: childId,
          parentScope: "root",
          scope: `child:${childId}`,
          depth: 1,
          name: childId,
          mode: "persistent",
          prompt: "first",
          inputId: firstInput
        });
        const advanced = this.#store.setChildStatus(childId, "admitted", {
          inputId: secondInput,
          prompt: "second",
          expectedInputId: firstInput,
          expectedStatus: "admitted"
        });
        const stale = this.#store.setChildStatus(childId, "completed", {
          answer: "stale answer",
          expectedInputId: firstInput
        });
        return response({ advanced, stale, child: this.#store.child(childId) });
      }
      if (request.method === "POST" && url.pathname === "/child-terminal-cas") {
        const body = (await request.json()) as { prefix: string };
        const childId = `${body.prefix}:child`;
        const inputId = `${body.prefix}:input`;
        this.#store.createChild({
          id: childId,
          parentScope: "root",
          scope: `child:${childId}`,
          depth: 1,
          name: childId,
          mode: "persistent",
          prompt: "work",
          inputId
        });
        const running = this.#store.setChildStatus(childId, "running", {
          expectedInputId: inputId,
          expectedStatus: "admitted",
          preserveResult: true
        });
        const completed = this.#store.completeChildTurn({
          childId,
          inputId,
          answer: "terminal answer",
          executionIds: ["execution-1"]
        });
        const stale = this.#store.setChildStatus(childId, "admitted", {
          expectedInputId: inputId,
          expectedStatus: "running",
          preserveResult: true
        });
        const duplicate = this.#store.completeChildTurn({
          childId,
          inputId,
          answer: "terminal answer",
          executionIds: ["execution-1"]
        });
        return response({
          running,
          completed,
          stale,
          duplicate,
          child: this.#store.child(childId)
        });
      }
      if (request.method === "POST" && url.pathname === "/promotion") {
        const body = (await request.json()) as {
          name: string;
          maximum: number;
        };
        return response(
          this.#store.claimSnippetPromotion(
            body.name,
            `execution:${body.name}`,
            body.maximum
          )
        );
      }
      if (request.method === "POST" && url.pathname === "/rollback-retention") {
        for (let index = 0; index < 105; index += 1) {
          this.#store.rollbackHarness(0, `retention ${index}`);
        }
        let oldRevisionPresent = true;
        try {
          this.#store.rollbackHarness(1, "probe pruned revision");
        } catch (error) {
          if (error instanceof Error && /not found/.test(error.message)) {
            oldRevisionPresent = false;
          } else {
            throw error;
          }
        }
        return response({
          revision: this.#store.harness().revision,
          retained: this.#store.harnessRevisions(100).length,
          oldRevisionPresent
        });
      }
      return response({ error: "not found" }, 404);
    } catch (error) {
      return response(
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
