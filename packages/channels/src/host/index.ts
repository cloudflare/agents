import {
  sharedAlarm,
  type DurableObjectAlarmCoordinator
} from "../alarm-coordinator";
import type {
  Channel,
  ChannelApprovalRequest,
  ChannelDeliveryContext,
  ChannelMessage,
  DeliveryResult
} from "../channel";
import type { ChannelApprovalResponse, ChannelEmailInput } from "../ingress";
import {
  createApprovalLinkController,
  type ApprovalLinkController
} from "./approval-links";
import { createDeliveryController, type DeliveryController } from "./delivery";
import {
  createIngressDispatcher,
  type IngressDispatcher
} from "./ingress-dispatch";
import type {
  ChannelHostOptions,
  ChannelHostScheduler,
  HostedDeliveryResult,
  HostedMessageOptions
} from "./types";

export { ChannelApprovalConflictError } from "./types";
export type {
  ChannelApprovalResponseEvent,
  ChannelHostOptions,
  ChannelHostScheduler,
  ChannelHostStorage,
  HostedDeliveryResult,
  HostedMessageOptions
} from "./types";

/**
 * Owns configured routing, durable delivery attempts, interaction correlation,
 * approval links, and normalized ingress dispatch for a set of Channels.
 */
export class ChannelHost {
  readonly #channels: Record<string, Channel>;
  readonly #delivery: DeliveryController;
  readonly #ingress: IngressDispatcher;
  readonly #approvalLinks: ApprovalLinkController;
  readonly #ownedAlarms: DurableObjectAlarmCoordinator | undefined;
  #started: Promise<void> | undefined;

  constructor(options: ChannelHostOptions) {
    this.#channels = { ...options.channels };

    const maxAttempts = options.maxAttempts ?? 3;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0) {
      throw new Error("retryBaseDelayMs must be a non-negative number");
    }

    const defaultChannelId = Object.keys(this.#channels)[0];
    const configuredApprovalChannelId =
      "approvalRequests" in options
        ? options.approvalRequests
        : defaultChannelId;
    const configuredDeliveryChannelId =
      "delivery" in options ? options.delivery : defaultChannelId;
    this.#validateChannelId(configuredApprovalChannelId);
    this.#validateChannelId(configuredDeliveryChannelId);
    this.#validateIngressPaths();

    let scheduler: ChannelHostScheduler;
    if (options.scheduler) {
      scheduler = options.scheduler;
      this.#ownedAlarms = undefined;
    } else {
      this.#ownedAlarms = sharedAlarm(options.storage);
      scheduler = this.#ownedAlarms.source("channels");
    }

    this.#ingress = createIngressDispatcher({
      channels: this.#channels,
      storage: options.storage,
      onApprovalResponse: options.onApprovalResponse,
      onMessage: options.onMessage
    });
    this.#approvalLinks = createApprovalLinkController({
      storage: options.storage,
      publicBaseUrl: options.publicBaseUrl,
      approvalLinkPath: options.approvalLinkPath,
      handleResponse: (event) =>
        this.#ingress.handleEvent("approval-link", event)
    });
    this.#delivery = createDeliveryController({
      channels: this.#channels,
      storage: options.storage,
      scheduler,
      configuredApprovalChannelId,
      configuredDeliveryChannelId,
      maxAttempts,
      retryBaseDelayMs,
      approvalLinksAvailable: options.publicBaseUrl !== undefined,
      getApprovalLinks: (deliveryId) => this.#approvalLinks.get(deliveryId)
    });
  }

  /** Initialize durable routes and recover interrupted or scheduled delivery. */
  async init(): Promise<void> {
    await this.#ensureInitialized(true);
  }

  async #ensureInitialized(reconcileRetrySchedules: boolean): Promise<void> {
    this.#started ??= this.#delivery.initialize(reconcileRetrySchedules);
    await this.#started;
  }

  async setApprovalRequestsChannel(channelId?: string): Promise<void> {
    await this.init();
    await this.#delivery.setApprovalRequestsChannel(channelId);
  }

  async setDeliveryChannel(channelId?: string): Promise<void> {
    await this.init();
    await this.#delivery.setDeliveryChannel(channelId);
  }

  async deliver(
    message: ChannelMessage,
    context?: ChannelDeliveryContext
  ): Promise<DeliveryResult>;
  async deliver(
    options: HostedMessageOptions
  ): Promise<HostedDeliveryResult | undefined>;
  async deliver(
    input: ChannelMessage | HostedMessageOptions,
    context?: ChannelDeliveryContext
  ): Promise<DeliveryResult | HostedDeliveryResult | undefined> {
    await this.init();
    if ("message" in input) {
      return this.#delivery.deliver(input);
    }

    const hosted = await this.#delivery.deliver({
      deliveryId: context?.deliveryId,
      message: input
    });
    return (
      hosted?.result ?? {
        status: "failed",
        retryable: false,
        error: {
          code: "DELIVERY_ROUTE_NOT_CONFIGURED",
          message: "ChannelHost has no delivery route configured"
        }
      }
    );
  }

  async requestApproval(options: {
    interactionId: string;
    request: ChannelApprovalRequest;
  }): Promise<HostedDeliveryResult | undefined> {
    await this.init();
    return this.#delivery.requestApproval(options);
  }

  async retryDelivery(deliveryId: string): Promise<HostedDeliveryResult> {
    await this.init();
    return this.#delivery.retryDelivery(deliveryId);
  }

  /**
   * Retry confirmed failures whose durable backoff has elapsed. When supplied,
   * delivery IDs bound the scan but are still validated against durable state.
   */
  async handleAlarm(deliveryIds?: readonly string[]): Promise<void> {
    if (this.#ownedAlarms) {
      await this.#ownedAlarms.handleAlarm({
        channels: (dueIds) => this.#handleDueDeliveries(dueIds)
      });
      return;
    }
    await this.#handleDueDeliveries(deliveryIds);
  }

  async #handleDueDeliveries(deliveryIds?: readonly string[]): Promise<void> {
    // Do not reschedule due records during initialization: a coordinator uses
    // generation-safe cleanup after this handler returns. Replacing a due
    // generation before attempting it would preserve a stale logical alarm.
    await this.#ensureInitialized(false);
    await this.#delivery.handleDueDeliveries(deliveryIds);
  }

  /** Mark an approval settled by the owning application or another surface. */
  async settleApproval(
    interactionId: string,
    decision: ChannelApprovalResponse["decision"],
    channelId = "application"
  ): Promise<void> {
    await this.init();
    await this.#delivery.settleApproval(interactionId, decision, channelId);
  }

  async getDelivery(
    deliveryId: string
  ): Promise<HostedDeliveryResult | undefined> {
    await this.init();
    return this.#delivery.getHostedDelivery(deliveryId);
  }

  async handleRequest(request: Request): Promise<Response | undefined> {
    await this.init();
    const approvalLinkResponse =
      await this.#approvalLinks.handleRequest(request);
    return approvalLinkResponse ?? this.#ingress.handleRequest(request);
  }

  async handleEmail(email: ChannelEmailInput): Promise<boolean> {
    await this.init();
    return this.#ingress.handleEmail(email);
  }

  /** Resolve one registered HTTP ingress path against the Host's public URL. */
  ingressUrl(channelId: string): string {
    this.#validateChannelId(channelId);
    const path = this.#channels[channelId]?.ingress?.path;
    if (!path) {
      throw new Error(`Channel "${channelId}" does not have HTTP ingress`);
    }
    return this.#approvalLinks.publicUrl(path);
  }

  #validateChannelId(channelId: string | undefined): void {
    if (channelId !== undefined && !this.#channels[channelId]) {
      throw new Error(`Unknown channel "${channelId}"`);
    }
  }

  #validateIngressPaths(): void {
    const ingressPaths = new Set<string>();
    for (const channel of Object.values(this.#channels)) {
      const path = channel.ingress?.path;
      if (!path) continue;
      if (ingressPaths.has(path)) {
        throw new Error(`Duplicate Channel ingress path "${path}"`);
      }
      ingressPaths.add(path);
    }
  }
}
