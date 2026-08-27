import {
  email,
  type ChannelEmailMessage,
  type EmailSendBinding
} from "../../src/adapters/email/email";
import type { ChannelMessageSurface } from "../../src/surface";
import {
  requiredEnv,
  type LiveDeliveryBinding,
  type ObservedMessage
} from "../binding";

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";

type FastmailSession = { apiUrl: string; accountId: string };
type FastmailEmail = {
  id: string;
  textBody: { partId: string }[];
  bodyValues: Record<string, { value: string }>;
};

async function openFastmail(token: string): Promise<FastmailSession> {
  const response = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Fastmail session: ${response.status}`);
  const session = (await response.json()) as {
    apiUrl: string;
    primaryAccounts: Record<string, string>;
  };
  return {
    apiUrl: session.apiUrl,
    accountId: session.primaryAccounts[MAIL]
  };
}

async function jmap<T>(
  token: string,
  session: FastmailSession,
  method: string,
  args: Record<string, unknown>
): Promise<T> {
  const response = await fetch(session.apiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      using: [CORE, MAIL],
      methodCalls: [[method, args, "live"]]
    })
  });
  if (!response.ok) throw new Error(`Fastmail ${method}: ${response.status}`);
  const payload = (await response.json()) as {
    methodResponses: [string, unknown, string][];
  };
  const [returnedMethod, result] = payload.methodResponses[0];
  if (returnedMethod !== method) {
    throw new Error(`Fastmail ${method}: ${returnedMethod}`);
  }
  return result as T;
}

function cloudflareBinding(accountId: string, token: string): EmailSendBinding {
  return {
    async send(message: ChannelEmailMessage) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(message)
        }
      );
      const payload = (await response.json()) as { success?: boolean };
      if (!response.ok || payload.success !== true) {
        throw new Error(`Cloudflare Email Service: ${response.status}`);
      }
      return { messageId: "channels-live-test" };
    }
  };
}

export function emailBinding(): LiveDeliveryBinding {
  const from = requiredEnv("CHANNELS_LIVE_EMAIL_FROM");
  const to = requiredEnv("CHANNELS_LIVE_EMAIL_TO");
  const fastmailToken = requiredEnv("CHANNELS_LIVE_FASTMAIL_API_TOKEN");
  const channel = email({
    from,
    binding: cloudflareBinding(
      requiredEnv("CHANNELS_LIVE_CLOUDFLARE_ACCOUNT_ID"),
      requiredEnv("CHANNELS_LIVE_CLOUDFLARE_API_TOKEN")
    )
  });
  const surface: ChannelMessageSurface = {
    channelKey: "email",
    version: 1,
    address: { from, to },
    label: `Email · ${to}`
  };
  let session: FastmailSession;

  async function ids(): Promise<string[]> {
    return (
      await jmap<{ ids: string[] }>(fastmailToken, session, "Email/query", {
        accountId: session.accountId,
        filter: { to },
        limit: 100
      })
    ).ids;
  }

  async function messages(): Promise<FastmailEmail[]> {
    const emailIds = await ids();
    if (emailIds.length === 0) return [];
    return (
      await jmap<{ list: FastmailEmail[] }>(
        fastmailToken,
        session,
        "Email/get",
        {
          accountId: session.accountId,
          ids: emailIds,
          properties: ["id", "textBody", "bodyValues"],
          fetchTextBodyValues: true
        }
      )
    ).list;
  }

  return {
    name: "email",
    destination: `email inbox ${to}`,
    async open() {
      session = await openFastmail(fastmailToken);
    },
    async clear() {
      const emailIds = await ids();
      if (emailIds.length > 0) {
        await jmap(fastmailToken, session, "Email/set", {
          accountId: session.accountId,
          destroy: emailIds
        });
      }
    },
    async deliver(text) {
      return await channel.deliver!(surface, { markdown: text });
    },
    async read(): Promise<ObservedMessage[]> {
      return (await messages()).map((message) => {
        const partId = message.textBody[0].partId;
        return { text: message.bodyValues[partId].value };
      });
    }
  };
}
