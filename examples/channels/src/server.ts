import {
  ChannelRouter,
  email,
  routes,
  telegram,
  type Channel
} from "agents/channels";
import { slack } from "agents/channels/slack";
import { handleApi } from "./api";
import { Conversation } from "./conversation";
import { Directory, directoryFor } from "./directory";
import { supportForm } from "./support-form-channel";

export { Conversation, Directory };

const SLACK_PATH = "/webhooks/slack";
const TELEGRAM_PATH = "/webhooks/telegram";
const SUPPORT_FORM_PATH = "/ingress/support-form";

/**
 * Every Channel this Worker talks through, keyed by the id used in routes.
 *
 * A Channel is static configuration: credentials and a `route` that turns one
 * normalized event into the name of the Durable Object
 * that should own it — or `null` to ignore the event.
 */
function createChannels(env: Env): Record<string, Channel> {
  return {
    slack: slack({
      botToken: env.SLACK_BOT_TOKEN,
      webhook: {
        signingSecret: env.SLACK_SIGNING_SECRET,
        path: SLACK_PATH,
        botUserId: env.SLACK_BOT_USER_ID
      },

      // Slack is the only transport here that shows us ambient traffic, so it
      // is the only route that decides relevance rather than just mapping.
      async route(event, _raw, context) {
        const thread = routes.perThread(event);

        const addressed =
          event.type === "approval-response" ||
          event.thread.isDirectMessage === true ||
          event.message.isMention === true;

        // A Slack message inside a thread carries `reply`, pointing at the
        // message that started it. Join a thread only if we are already in it.
        const known =
          !addressed &&
          event.type === "message" &&
          event.message.reply !== undefined &&
          (await directoryFor(env).knows(thread));

        if (!addressed && !known) return null; // ignore channel chatter

        // look up user identity based on channel identity
        const user = await context.findUser();
        return user ? `user:${user.id}` : thread;
      }
    }),

    telegram: telegram({
      botToken: env.TELEGRAM_BOT_TOKEN,
      webhook: {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
        path: TELEGRAM_PATH
      },

      route: routes.byUser(routes.perThread)
    }),

    email: email({
      binding: env.EMAIL,
      from: env.EMAIL_FROM,
      // Prefer a linked person, then the sender's address, so a second email
      // chain from someone we recognise continues their conversation.
      route: routes.byUser(routes.byIdentity(routes.perThread))
    }),

    "support-form": supportForm({
      path: SUPPORT_FORM_PATH,
      // An anonymous submission has no identity, so it opens its own
      // conversation.
      route: routes.byUser(routes.byIdentity(routes.perEvent))
    })
  };
}

/**
 * A router authenticates and normalizes provider input, asks the Channel where
 * the event belongs, and hands it to the application.
 *
 * It holds no state, so it's safe to build a new one per request.
 */
export function createRouter(env: Env): ChannelRouter {
  return new ChannelRouter({
    channels: createChannels(env),
    findUser(identity) {
      return directoryFor(env).userFor(identity);
    },

    onRoute({ channelKey, event, route }) {
      // debugging support!
      console.log(`${channelKey} ${event.type} -> ${route ?? "ignored"}`);
    },

    async onMessage({ channelKey, route, dispatchId, message }) {
      // This application routes messages into one DO per conversation, representing our application/agent logic
      await env.Conversation.getByName(route).receive(
        route,
        channelKey,
        dispatchId,
        message
      );
    },

    async onApprovalResponse({ route, response }) {
      await env.Conversation.getByName(route).settle(
        response.interactionId,
        response.decision
      );
    }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Channel ingress first: each Channel tries to handle requests to its webhook, returning a response if it matches
    const response = await createRouter(env).handleRequest(request);
    if (response) return response;

    // if the request hasn't been handled by a channels webhook, pass it to our own API
    const api = await handleApi(request, env);
    return api ?? new Response("Not found", { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // channel ingress for email
    await createRouter(env).handleEmail(message);
  }
} satisfies ExportedHandler<Env>;
