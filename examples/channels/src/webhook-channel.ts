import type {
  Channel,
  ChannelMessage,
  DeliveryResult
} from "@cloudflare/channels";

export function webhookChannel(url: string): Channel {
  return {
    deliver(message) {
      return sendWebhook(url, message);
    },

    async requestApproval({ request, getApprovalLinks }) {
      if (!getApprovalLinks) {
        return {
          status: "failed",
          retryable: false,
          error: {
            code: "approval_links_unavailable",
            message: "The Channel Host did not provide approval links"
          }
        };
      }

      const links = await getApprovalLinks();
      return sendWebhook(url, {
        title: request.title,
        markdown: [
          request.summary,
          `Approve: ${links.approve}`,
          `Reject: ${links.reject}`
        ].join("\n\n")
      });
    }
  };
}

function sendWebhook(
  url: string,
  message: ChannelMessage
): Promise<DeliveryResult> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message)
  })
    .then((response) => {
      if (!response.ok) {
        return {
          status: "failed" as const,
          retryable: response.status === 429 || response.status >= 500,
          error: {
            code: "webhook_rejected",
            message: `The webhook returned HTTP ${response.status}`
          }
        };
      }

      return {
        status: "delivered" as const,
        reference: response.headers.get("x-message-id") ?? undefined
      };
    })
    .catch(() => ({
      status: "uncertain" as const,
      error: {
        code: "network_error",
        message: "The webhook may have received the message"
      }
    }));
}
