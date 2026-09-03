import { sseResponse, type Streams } from "agents/streams";
import type { SelfModifyingHarness } from "./self-modifying-harness";
import { HarnessBuildError } from "./harness-runtime";

function jsonBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  // SAFETY: The branch above narrowed the parsed JSON value to a non-null,
  // non-array object. Each consumed field is parsed below.
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function requiredInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${key} must be a safe integer`);
  }
  return value;
}

function statusForError(error: unknown): number {
  if (error instanceof HarnessBuildError) return 422;
  return 400;
}

function errorResponse(error: unknown): Response {
  return Response.json(
    {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof HarnessBuildError
        ? { tag: error._tag, phase: error.phase }
        : {})
    },
    { status: statusForError(error) }
  );
}

/** Serve the self-modifying harness operator API and durable turn streams. */
export async function handleSelfModifyingHarnessRequest(
  harness: SelfModifyingHarness,
  streams: Streams,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json(await harness.snapshot());
    }

    if (request.method === "POST" && url.pathname === "/turns") {
      const body = jsonBody(await request.json());
      const prompt = requiredString(body, "prompt");
      const turnId =
        typeof body.turnId === "string" ? body.turnId : crypto.randomUUID();
      if (body.wait === false) {
        const receipt = await harness.submit(prompt, turnId);
        return Response.json(receipt, {
          status: receipt.accepted ? 202 : 200
        });
      }
      return Response.json(await harness.prompt(prompt, turnId));
    }

    const turnMatch = url.pathname.match(/^\/turns\/([^/]+)$/);
    if (request.method === "GET" && turnMatch) {
      const turnId = decodeURIComponent(turnMatch[1] ?? "");
      const turn = await harness.getTurn(turnId);
      return turn
        ? Response.json(turn)
        : Response.json({ error: "Turn not found" }, { status: 404 });
    }

    const streamMatch = url.pathname.match(/^\/streams\/([^/]+)$/);
    if (request.method === "GET" && streamMatch) {
      return sseResponse(streams, decodeURIComponent(streamMatch[1] ?? ""), {
        request
      });
    }

    if (request.method === "PUT" && url.pathname === "/source") {
      const body = jsonBody(await request.json());
      await harness.writeSource(
        requiredString(body, "path"),
        requiredString(body, "content")
      );
      return Response.json({ written: true });
    }

    if (request.method === "POST" && url.pathname === "/activate") {
      const body = jsonBody(await request.json());
      return Response.json(
        await harness.activate(requiredString(body, "note"))
      );
    }

    if (request.method === "POST" && url.pathname === "/restore") {
      const body = jsonBody(await request.json());
      return Response.json(
        await harness.restore(requiredInteger(body, "revisionId"))
      );
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
