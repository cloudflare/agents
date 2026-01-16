/**
 * Type tests for ExportedHandler with Props support
 * @see https://github.com/cloudflare/agents/issues/501
 */
import type { ExportedHandler } from "../types";

type TestEnv = {
  MY_VAR: string;
};

type TestProps = {
  userId: string;
  baseUrl: string;
};

// Props flows to fetch handler
{
  const handler: ExportedHandler<TestEnv, TestProps> = {
    async fetch(request, env, ctx) {
      const _userId: string = ctx.props.userId;
      const _myVar: string = env.MY_VAR;
      return new Response("ok");
    }
  };
  handler;
}

// Props flows to scheduled handler
{
  const handler: ExportedHandler<TestEnv, TestProps> = {
    async scheduled(controller, env, ctx) {
      const _userId: string = ctx.props.userId;
    }
  };
  handler;
}

// Props flows to queue handler
{
  type QueueMessage = { data: string };
  const handler: ExportedHandler<TestEnv, TestProps, QueueMessage> = {
    async queue(batch, env, ctx) {
      const _userId: string = ctx.props.userId;
      const _data: string = batch.messages[0].body.data;
    }
  };
  handler;
}

// satisfies pattern works
{
  const handler = {
    async fetch(request, env, ctx) {
      const userId: string = ctx.props.userId;
      return new Response(userId);
    }
  } satisfies ExportedHandler<TestEnv, TestProps>;
  handler;
}

// Without Props, ctx.props is unknown (default)
{
  const handler: ExportedHandler<TestEnv> = {
    async fetch(request, env, ctx) {
      const _props: unknown = ctx.props;
      return new Response("ok");
    }
  };
  handler;
}
