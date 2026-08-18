import type { ChannelApprovalLinks } from "../channel";
import type { ChannelApprovalResponse } from "../ingress";
import {
  approvalDeliveryId,
  approvalLinkKey,
  getDelivery,
  getSettlement,
  putDelivery
} from "./storage";
import {
  ChannelApprovalConflictError,
  type ChannelHostStorage,
  type StoredApprovalLink
} from "./types";

const DEFAULT_APPROVAL_LINK_PATH = "channel-approvals";

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff"
      }
    }
  );
}

export type ApprovalLinkController = {
  get(deliveryId: string): Promise<ChannelApprovalLinks>;
  handleRequest(request: Request): Promise<Response | undefined>;
  publicUrl(path: string): string;
};

export function createApprovalLinkController(options: {
  storage: ChannelHostStorage;
  publicBaseUrl?: string;
  approvalLinkPath?: string;
  handleResponse(event: ChannelApprovalResponse): Promise<void>;
}): ApprovalLinkController {
  const publicBaseUrl = options.publicBaseUrl
    ? normalizePublicBaseUrl(options.publicBaseUrl)
    : undefined;
  const approvalLinkPath = (
    options.approvalLinkPath ?? DEFAULT_APPROVAL_LINK_PATH
  ).replace(/^\/+|\/+$/g, "");
  if (!approvalLinkPath) {
    throw new Error("approvalLinkPath must not be empty");
  }

  function publicUrl(path: string): string {
    if (!publicBaseUrl) {
      throw new Error("ChannelHost publicBaseUrl is not configured");
    }
    return new URL(path.replace(/^\/+/, ""), publicBaseUrl).toString();
  }

  async function get(deliveryId: string): Promise<ChannelApprovalLinks> {
    if (!publicBaseUrl) {
      throw new Error("ChannelHost publicBaseUrl is not configured");
    }
    const delivery = await getDelivery(options.storage, deliveryId);
    if (!delivery?.interactionId) {
      throw new Error(`Unknown approval delivery "${deliveryId}"`);
    }

    let links = delivery.approvalLinks;
    if (!links) {
      links = {
        approveToken: crypto.randomUUID(),
        rejectToken: crypto.randomUUID()
      };
      await Promise.all([
        options.storage.put<StoredApprovalLink>(
          approvalLinkKey(links.approveToken),
          { interactionId: delivery.interactionId, decision: "approve" }
        ),
        options.storage.put<StoredApprovalLink>(
          approvalLinkKey(links.rejectToken),
          { interactionId: delivery.interactionId, decision: "reject" }
        )
      ]);
      await putDelivery(options.storage, {
        ...delivery,
        approvalLinks: links,
        updatedAt: Date.now()
      });
    }

    return {
      approve: publicUrl(`${approvalLinkPath}/${links.approveToken}`),
      reject: publicUrl(`${approvalLinkPath}/${links.rejectToken}`)
    };
  }

  async function handleRequest(
    request: Request
  ): Promise<Response | undefined> {
    if (!publicBaseUrl) return undefined;
    const match = new URL(request.url).pathname.match(
      new RegExp(
        `/${approvalLinkPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)$`
      )
    );
    if (!match?.[1]) return undefined;

    const token = decodeURIComponent(match[1]);
    const link = await options.storage.get<StoredApprovalLink>(
      approvalLinkKey(token)
    );
    if (!link) return html("<h1>Approval link not found</h1>", 404);

    const delivery = await getDelivery(
      options.storage,
      approvalDeliveryId(link.interactionId)
    );
    if (delivery?.response) {
      return html("<h1>This approval has already been resolved</h1>", 409);
    }

    if (request.method === "GET") {
      const label = link.decision === "approve" ? "Approve" : "Reject";
      return html(
        `<h1>Confirm ${label.toLowerCase()}</h1><form method="post"><button type="submit">${label}</button></form>`
      );
    }
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, POST" }
      });
    }

    const settled = await getSettlement(options.storage, link.interactionId);
    if (settled) {
      return settled.decision === link.decision
        ? html("<h1>This response was already recorded</h1>")
        : html("<h1>This approval has already been resolved</h1>", 409);
    }

    try {
      await options.handleResponse({
        type: "approval-response",
        interactionId: link.interactionId,
        decision: link.decision,
        reference: token
      });
      return html("<h1>Response recorded</h1>");
    } catch (error) {
      return error instanceof ChannelApprovalConflictError
        ? html("<h1>This approval has already been resolved</h1>", 409)
        : html("<h1>Could not record this response</h1>", 500);
    }
  }

  return { get, handleRequest, publicUrl };
}

function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("publicBaseUrl must use HTTP or HTTPS");
  }
  if (url.search || url.hash) {
    throw new Error("publicBaseUrl must not include a query or fragment");
  }
  return url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`;
}
