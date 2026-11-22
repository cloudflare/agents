/**
 * The Agent side of email: routing an inbound message to an Agent, the
 * RPC bridge its handler talks back through, and replies. `Agent` keeps
 * thin delegates (`_onEmail`, `replyToEmail`).
 *
 * @internal
 */

import { EmailMessage } from "cloudflare:email";
import { RpcTarget } from "cloudflare:workers";
import { getAgentByName, type AgentOptions } from "./agent-routing";
import { signAgentHeaders, type EmailResolver } from "./email";
import type { Agent } from "./index";
import type { AgentEmail } from "./internal_context";
import { camelCaseToKebabCase } from "./utils";

export type EmailRoutingOptions<Env> = AgentOptions<Env> & {
  resolver: EmailResolver<Env>;
  /**
   * Callback invoked when no routing information is found for an email.
   * Use this to reject the email or perform custom handling.
   * If not provided, a warning is logged and the email is dropped.
   */
  onNoRoute?: (email: ForwardableEmailMessage) => void | Promise<void>;
};

/** What `routeAgentEmail()` sends `Agent._onEmail()`: plain data plus the bridge. @internal */
export type AgentEmailPayload = {
  from: string;
  to: string;
  headers: Headers;
  rawSize: number;
  _secureRouted?: boolean;
  _bridge: EmailBridge;
};

/** @internal */
export type ReplyToEmailOptions = {
  fromName: string;
  subject?: string | undefined;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
  secret?: string | null;
};

// RpcTarget bridge for email callbacks. Consolidates the email event's
// mutation methods (setReject, forward, reply) into a single disposable
// RPC target instead of anonymous closures. This allows the runtime to
// tear down the bidirectional RPC session when _onEmail returns,
// rather than keeping the DO pinned for the caller's entire context
// lifetime (~100-120s for CF Email Routing handlers).
/** @internal */
export class EmailBridge extends RpcTarget {
  #email: ForwardableEmailMessage;

  constructor(email: ForwardableEmailMessage) {
    super();
    this.#email = email;
  }

  async getRaw(): Promise<Uint8Array> {
    const reader = this.#email.raw.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        chunks.push(value);
      }
    }
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  setReject(reason: string) {
    this.#email.setReject(reason);
  }

  forward(rcptTo: string, headers?: Headers): Promise<EmailSendResult> {
    return this.#email.forward(rcptTo, headers);
  }

  reply(options: {
    from: string;
    to: string;
    raw: string;
  }): Promise<EmailSendResult> {
    return this.#email.reply(
      new EmailMessage(options.from, options.to, options.raw)
    );
  }

  [Symbol.dispose]() {
    // Intentionally empty — the runtime calls this when the last
    // stub is disposed, signaling that the RPC target is no longer
    // needed and the bidirectional connection can be torn down.
  }
}

/**
 * The `AgentEmail` an `onEmail` handler sees, rebuilt from the payload.
 * The payload is plain data because of
 * https://github.com/cloudflare/workerd/issues/4499.
 *
 * @internal
 */
export function agentEmailFromPayload(payload: AgentEmailPayload): AgentEmail {
  return {
    from: payload.from,
    to: payload.to,
    headers: payload.headers,
    rawSize: payload.rawSize,
    _secureRouted: payload._secureRouted,
    getRaw: () => payload._bridge.getRaw(),
    setReject: (reason: string) => payload._bridge.setReject(reason),
    forward: (rcptTo: string, headers?: Headers) =>
      payload._bridge.forward(rcptTo, headers),
    reply: (options: { from: string; to: string; raw: string }) =>
      payload._bridge.reply(options)
  };
}

/**
 * Reply to `email` as the agent, with its routing headers, signed when a
 * secret is given. Returns the subject the reply went out with.
 *
 * @internal
 */
export async function replyToAgentEmail(
  email: AgentEmail,
  options: ReplyToEmailOptions,
  identity: { agentName: string; agentId: string }
): Promise<string | undefined> {
  // Enforce signing for emails routed via createSecureReplyEmailResolver
  if (email._secureRouted && options.secret === undefined) {
    throw new Error(
      "This email was routed via createSecureReplyEmailResolver. " +
        "You must pass a secret to replyToEmail() to sign replies, " +
        "or pass explicit null to opt-out (not recommended)."
    );
  }
  const { agentName, agentId } = identity;

  const { createMimeMessage } = await import("mimetext");
  const msg = createMimeMessage();
  msg.setSender({ addr: email.to, name: options.fromName });
  msg.setRecipient(email.from);
  msg.setSubject(
    options.subject || `Re: ${email.headers.get("subject")}` || "No subject"
  );
  msg.addMessage({
    contentType: options.contentType || "text/plain",
    data: options.body
  });

  const domain = email.from.split("@")[1];
  msg.setHeader("In-Reply-To", email.headers.get("Message-ID")!);
  msg.setHeader("Message-ID", `<${agentId}@${domain}>`);
  msg.setHeader("X-Agent-Name", agentName);
  msg.setHeader("X-Agent-ID", agentId);

  // Signed headers let a reply route back to this agent securely.
  if (typeof options.secret === "string") {
    const signed = await signAgentHeaders(options.secret, agentName, agentId);
    msg.setHeader("X-Agent-Sig", signed["X-Agent-Sig"]);
    msg.setHeader("X-Agent-Sig-Ts", signed["X-Agent-Sig-Ts"]);
  }

  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      msg.setHeader(key, value);
    }
  }
  await email.reply({ from: email.to, raw: msg.asRaw(), to: email.from });

  const rawSubject = email.headers.get("subject");
  return options.subject ?? (rawSubject ? `Re: ${rawSubject}` : undefined);
}

// Cache the agent namespace map for email routing
// This maps original names, kebab-case, and lowercase versions to namespaces
const agentMapCache = new WeakMap<
  Record<string, unknown>,
  { map: Record<string, unknown>; originalNames: string[] }
>();

/**
 * Route an email to the appropriate Agent
 * @param email The email to route
 * @param env The environment containing the Agent bindings
 * @param options The options for routing the email
 * @returns A promise that resolves when the email has been routed
 */
export async function routeAgentEmail<
  Env extends Cloudflare.Env = Cloudflare.Env
>(
  email: ForwardableEmailMessage,
  env: Env,
  options: EmailRoutingOptions<Env>
): Promise<void> {
  const routingInfo = await options.resolver(email, env);

  if (!routingInfo) {
    if (options.onNoRoute) {
      await options.onNoRoute(email);
    } else {
      console.warn("No routing information found for email, dropping message");
    }
    return;
  }

  // Build a map that includes original names, kebab-case, and lowercase versions
  if (!agentMapCache.has(env as Record<string, unknown>)) {
    const map: Record<string, unknown> = {};
    const originalNames: string[] = [];
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (
        value &&
        typeof value === "object" &&
        "idFromName" in value &&
        typeof value.idFromName === "function"
      ) {
        // Add the original name, kebab-case version, and lowercase version
        map[key] = value;
        map[camelCaseToKebabCase(key)] = value;
        map[key.toLowerCase()] = value;
        originalNames.push(key);
      }
    }
    agentMapCache.set(env as Record<string, unknown>, {
      map,
      originalNames
    });
  }

  const cached = agentMapCache.get(env as Record<string, unknown>)!;
  const namespace = cached.map[routingInfo.agentName];

  if (!namespace) {
    // Provide helpful error message listing available agents
    const availableAgents = cached.originalNames.join(", ");
    throw new Error(
      `Agent namespace '${routingInfo.agentName}' not found in environment. Available agents: ${availableAgents}`
    );
  }

  const agent = await getAgentByName(
    namespace as unknown as DurableObjectNamespace<Agent<Env>>,
    routingInfo.agentId
  );

  // Use an RpcTarget bridge instead of bare closures so the runtime
  // can cleanly tear down the bidirectional session after _onEmail returns
  const bridge = new EmailBridge(email);

  await agent._onEmail({
    from: email.from,
    to: email.to,
    headers: email.headers,
    rawSize: email.rawSize,
    _secureRouted: routingInfo._secureRouted,
    _bridge: bridge
  });
}
