export const WEBHOOK_PATH = "/webhooks/telegram";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export type TelegramWebhookSetupResult = {
  ok: boolean;
  webhookUrl: string;
  alreadyConfigured: boolean;
  description: string;
};

type TelegramApiResponse<T> =
  | {
      ok: true;
      result: T;
      description?: string;
    }
  | {
      ok: false;
      description?: string;
      error_code?: number;
    };

type TelegramWebhookInfo = {
  url?: string;
};

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers
    }
  });
}

async function telegramApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>
): Promise<TelegramApiResponse<T>> {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body ?? {})
  });
  return (await response.json()) as TelegramApiResponse<T>;
}

export async function setupTelegramWebhook(
  request: Request,
  env: Cloudflare.Env
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const webhookUrl = `${requestUrl.origin}${WEBHOOK_PATH}`;
  if (requestUrl.protocol !== "https:") {
    return jsonResponse(
      {
        ok: false,
        webhookUrl,
        error:
          "Telegram webhooks require HTTPS. Open the Quick Tunnel or deployed Worker URL and click Set webhook here again."
      },
      { status: 400 }
    );
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return jsonResponse(
      {
        ok: false,
        error: "TELEGRAM_BOT_TOKEN is not configured."
      },
      { status: 400 }
    );
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET_TOKEN) {
    return jsonResponse(
      {
        ok: false,
        error: "TELEGRAM_WEBHOOK_SECRET_TOKEN is not configured."
      },
      { status: 400 }
    );
  }

  const current = await telegramApi<TelegramWebhookInfo>(
    env.TELEGRAM_BOT_TOKEN,
    "getWebhookInfo"
  );

  if (!current.ok) {
    return jsonResponse(
      {
        ok: false,
        webhookUrl,
        error: current.description ?? "Failed to inspect Telegram webhook."
      },
      { status: 502 }
    );
  }

  if (current.result.url === webhookUrl) {
    return jsonResponse({
      ok: true,
      webhookUrl,
      alreadyConfigured: true,
      description: "Telegram webhook already points at this origin."
    } satisfies TelegramWebhookSetupResult);
  }

  const next = await telegramApi<true>(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET_TOKEN
  });

  if (!next.ok) {
    return jsonResponse(
      {
        ok: false,
        webhookUrl,
        error: next.description ?? "Failed to set Telegram webhook."
      },
      { status: 502 }
    );
  }

  return jsonResponse({
    ok: true,
    webhookUrl,
    alreadyConfigured: false,
    description: next.description ?? "Telegram webhook configured."
  } satisfies TelegramWebhookSetupResult);
}
