import type { ChannelIdentity, ChannelMessageSurface } from "agents/channels";
import { directoryFor } from "./directory";

/**
 * The JSON API this example's browser UI calls. Plain plumbing — nothing here
 * is specific to Channels, and you can skip it for learning.
 */
export async function handleApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const [, api, collection, rawId, action] = url.pathname.split("/");
  if (api !== "api") return null;

  const id = rawId ? decodeURIComponent(rawId) : "";
  const body = request.method === "POST" ? await readBody(request) : {};
  const directory = directoryFor(env);

  try {
    if (collection === "directory") {
      return Response.json(await directory.snapshot());
    }
    if (collection === "users" && id) {
      return Response.json(await directory.userPage(id));
    }
    if (collection === "links") {
      if (!body.identity) throw new Error("A Channel identity is required");
      return Response.json(await directory.link(body.identity, body.userId));
    }
    if (collection === "conversations" && id) {
      const conversation = env.Conversation.getByName(id);
      const markdown = body.markdown ?? "";
      if (action === "reply" || action === "approval") {
        // The browser chose one of the surfaces this conversation offered.
        const surface = body.surface;
        if (!surface) throw new Error("A Channel surface is required");
        return Response.json(
          action === "reply"
            ? await conversation.reply(markdown, surface)
            : await conversation.requestApproval(markdown, surface)
        );
      }
      if (action === "close") {
        return Response.json(await conversation.close());
      }
      return Response.json(await conversation.page());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }

  return Response.json({ error: "Unknown API route" }, { status: 404 });
}

type ApiBody = {
  markdown?: string;
  surface?: ChannelMessageSurface;
  identity?: ChannelIdentity;
  userId?: string;
};

async function readBody(request: Request): Promise<ApiBody> {
  const text = await request.text();
  return text ? (JSON.parse(text) as ApiBody) : {};
}
