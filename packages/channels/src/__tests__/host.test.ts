import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelApprovalConflictError,
  ChannelHost,
  type Channel,
  type ChannelHostScheduler,
  type ChannelIngress,
  type ChannelIngressEvent,
  type DurableObjectAlarmSourceTransaction
} from "..";
import { memoryAlarmStorage, memoryStorage } from "./storage";

function ingress(
  path: string,
  events: readonly ChannelIngressEvent[]
): ChannelIngress {
  return {
    path,
    receive: vi.fn(async () => ({
      events,
      response: new Response("accepted", { status: 200 })
    }))
  };
}

function approvalChannel(options?: {
  reference?: string;
  ingress?: ChannelIngress;
  results?: Array<Awaited<ReturnType<Channel["deliver"]>>>;
}): Channel {
  const results = [...(options?.results ?? [])];
  return {
    ...(options?.ingress && { ingress: options.ingress }),
    deliver: vi.fn(async () => ({ status: "delivered" as const })),
    requestApproval: vi.fn(async () => {
      const result = results.shift();
      return (
        result ?? {
          status: "delivered" as const,
          reference: options?.reference ?? "42"
        }
      );
    })
  };
}

function hostOptions(
  channels: Record<string, Channel>,
  overrides: Partial<ConstructorParameters<typeof ChannelHost>[0]> = {}
): ConstructorParameters<typeof ChannelHost>[0] {
  return {
    channels,
    storage: memoryStorage(),
    scheduler: { schedule: vi.fn() },
    onApprovalResponse: vi.fn(),
    ...overrides
  };
}

const approvalRequest = {
  title: "Approval required",
  summary: "Deploy release?",
  input: { environment: "production" }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChannelHost", () => {
  it("defaults approval requests to the first configured Channel", async () => {
    const channel = approvalChannel();
    const host = new ChannelHost(hostOptions({ telegram: channel }));

    await expect(
      host.requestApproval({
        interactionId: "actpause_123",
        request: approvalRequest
      })
    ).resolves.toEqual({
      deliveryId: "approval:actpause_123",
      channelId: "telegram",
      result: { status: "delivered", reference: "42" }
    });
    expect(channel.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: "actpause_123",
        request: approvalRequest,
        delivery: {
          deliveryId: "approval:actpause_123",
          attempt: 1
        }
      })
    );
  });

  it("allows an explicit undefined route to disable approval delivery", async () => {
    const channel = approvalChannel();
    const host = new ChannelHost(
      hostOptions({ telegram: channel }, { approvalRequests: undefined })
    );

    await expect(
      host.requestApproval({
        interactionId: "browser-only",
        request: approvalRequest
      })
    ).resolves.toBeUndefined();
    expect(channel.requestApproval).not.toHaveBeenCalled();
  });

  it("persists a runtime approval route across Host recreation", async () => {
    const storage = memoryStorage();
    const channels = {
      telegram: approvalChannel(),
      backup: approvalChannel({ reference: "backup-1" })
    };
    const first = new ChannelHost(
      hostOptions(channels, {
        storage,
        approvalRequests: "telegram"
      })
    );
    await first.setApprovalRequestsChannel("backup");

    const recreated = new ChannelHost(
      hostOptions(channels, {
        storage,
        approvalRequests: "telegram"
      })
    );
    await expect(
      recreated.requestApproval({
        interactionId: "actpause_456",
        request: approvalRequest
      })
    ).resolves.toMatchObject({ channelId: "backup" });
  });

  it("clears an override and immediately restores the configured default", async () => {
    const storage = memoryStorage();
    const channels = { telegram: approvalChannel() };
    const host = new ChannelHost(
      hostOptions(channels, {
        storage,
        approvalRequests: "telegram"
      })
    );
    await host.setApprovalRequestsChannel();

    await expect(
      host.requestApproval({
        interactionId: "cleared",
        request: approvalRequest
      })
    ).resolves.toMatchObject({ channelId: "telegram" });

    const recreated = new ChannelHost(
      hostOptions(channels, {
        storage,
        approvalRequests: "telegram"
      })
    );
    await expect(
      recreated.requestApproval({
        interactionId: "restored",
        request: approvalRequest
      })
    ).resolves.toMatchObject({ channelId: "telegram" });
  });

  it("does not redeliver an existing interaction", async () => {
    const channel = approvalChannel();
    const host = new ChannelHost(
      hostOptions({ telegram: channel }, { approvalRequests: "telegram" })
    );
    const options = {
      interactionId: "actpause_123",
      request: approvalRequest
    };

    await host.requestApproval(options);
    await host.requestApproval(options);

    expect(channel.requestApproval).toHaveBeenCalledOnce();
  });

  it("rejects reuse of an interaction id with different content", async () => {
    const host = new ChannelHost(
      hostOptions(
        { telegram: approvalChannel() },
        { approvalRequests: "telegram" }
      )
    );
    await host.requestApproval({
      interactionId: "actpause_123",
      request: approvalRequest
    });

    await expect(
      host.requestApproval({
        interactionId: "actpause_123",
        request: { ...approvalRequest, summary: "Delete production?" }
      })
    ).rejects.toThrow(
      'Interaction "actpause_123" was already requested differently'
    );
  });

  it("durably correlates provider reply references after recreation", async () => {
    const storage = memoryStorage();
    const sender = approvalChannel({ reference: "42" });
    const first = new ChannelHost(
      hostOptions(
        { telegram: sender },
        { storage, approvalRequests: "telegram" }
      )
    );
    await first.requestApproval({
      interactionId: "actpause_123",
      request: approvalRequest
    });
    await storage.delete("cf_channels:reference:telegram%3A42");

    const onApprovalResponse = vi.fn(async () => undefined);
    const receiver = approvalChannel({
      ingress: ingress("/webhooks/telegram", [
        {
          type: "approval-response",
          decision: "approve",
          reference: "43",
          replyToReference: "42"
        }
      ])
    });
    const recreated = new ChannelHost(
      hostOptions(
        { telegram: receiver },
        { storage, approvalRequests: "telegram", onApprovalResponse }
      )
    );

    await recreated.handleRequest(
      new Request("https://example.com/webhooks/telegram", { method: "POST" })
    );

    expect(onApprovalResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "telegram",
        interactionId: "actpause_123",
        decision: "approve"
      })
    );
  });

  it("accepts an explicit interaction response through another Channel", async () => {
    const onApprovalResponse = vi.fn(async () => undefined);
    const host = new ChannelHost(
      hostOptions(
        {
          email: approvalChannel(),
          telegram: approvalChannel({
            ingress: ingress("/webhooks/telegram", [
              {
                type: "approval-response",
                decision: "reject",
                reference: "99",
                interactionId: "actpause_123"
              }
            ])
          })
        },
        { approvalRequests: "email", onApprovalResponse }
      )
    );
    await host.requestApproval({
      interactionId: "actpause_123",
      request: approvalRequest
    });

    await host.handleRequest(
      new Request("https://example.com/webhooks/telegram", { method: "POST" })
    );

    expect(onApprovalResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "telegram",
        interactionId: "actpause_123",
        decision: "reject"
      })
    );
  });

  it("suppresses ingress replays after Host recreation", async () => {
    const storage = memoryStorage();
    const onApprovalResponse = vi.fn(async () => undefined);
    const channel = approvalChannel({
      ingress: ingress("/webhooks/telegram", [
        {
          type: "approval-response",
          decision: "approve",
          reference: "43",
          interactionId: "actpause_123"
        }
      ])
    });
    const options = hostOptions(
      { telegram: channel },
      { storage, approvalRequests: "telegram", onApprovalResponse }
    );

    const first = new ChannelHost(options);
    await first.requestApproval({
      interactionId: "actpause_123",
      request: approvalRequest
    });
    await first.handleRequest(
      new Request("https://example.com/webhooks/telegram", { method: "POST" })
    );
    await new ChannelHost(options).handleRequest(
      new Request("https://example.com/webhooks/telegram", { method: "POST" })
    );

    expect(onApprovalResponse).toHaveBeenCalledOnce();
  });

  it("retries a confirmed retryable failure with the same delivery id", async () => {
    const requestApproval = vi
      .fn<Channel["requestApproval"]>()
      .mockResolvedValueOnce({
        status: "failed",
        retryable: true,
        error: { code: "RATE_LIMIT", message: "Slow down" }
      })
      .mockResolvedValueOnce({
        status: "failed",
        retryable: true,
        error: { code: "RATE_LIMIT", message: "Still slow" }
      })
      .mockResolvedValueOnce({
        status: "delivered",
        reference: "42"
      });
    const channel: Channel = {
      deliver: vi.fn(),
      requestApproval
    };
    const scheduleRetry = vi.fn(async () => undefined);
    const host = new ChannelHost(
      hostOptions(
        { telegram: channel },
        {
          approvalRequests: "telegram",
          retryBaseDelayMs: 0,
          scheduler: { schedule: scheduleRetry }
        }
      )
    );

    await host.requestApproval({
      interactionId: "actpause_123",
      request: approvalRequest
    });
    expect(scheduleRetry).toHaveBeenCalledWith(
      "approval:actpause_123",
      expect.any(Number)
    );

    await host.retryDelivery("approval:actpause_123");
    expect(scheduleRetry).toHaveBeenCalledTimes(2);

    await expect(
      host.retryDelivery("approval:actpause_123")
    ).resolves.toMatchObject({
      result: { status: "delivered", reference: "42" }
    });
    expect(requestApproval.mock.calls[2]?.[0].delivery).toEqual({
      deliveryId: "approval:actpause_123",
      attempt: 3
    });
  });

  it("owns the native alarm when no scheduler is configured", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const deliver = vi
      .fn<Channel["deliver"]>()
      .mockResolvedValueOnce({
        status: "failed",
        retryable: true,
        error: { code: "RATE_LIMIT", message: "Slow down" }
      })
      .mockResolvedValueOnce({ status: "delivered", reference: "message-1" });
    const host = new ChannelHost({
      channels: { support: { deliver } },
      storage: memoryAlarmStorage(),
      retryBaseDelayMs: 0,
      onApprovalResponse: vi.fn()
    });

    await host.deliver({
      deliveryId: "notice-1",
      message: { markdown: "Hello" }
    });
    await host.handleAlarm();

    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("polls only due confirmed failures and makes extra alarm calls harmless", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const deliver = vi
      .fn<Channel["deliver"]>()
      .mockResolvedValueOnce({
        status: "failed",
        retryable: true,
        error: { code: "RATE_LIMIT", message: "Slow down" }
      })
      .mockResolvedValueOnce({ status: "delivered", reference: "message-1" });
    const host = new ChannelHost(
      hostOptions(
        { support: { deliver } },
        { retryBaseDelayMs: 100, scheduler: { schedule: vi.fn() } }
      )
    );
    await host.deliver({
      deliveryId: "notice-1",
      message: { markdown: "Hello" }
    });

    now.mockReturnValue(1_099);
    await host.handleAlarm();
    expect(deliver).toHaveBeenCalledOnce();

    now.mockReturnValue(1_100);
    await host.handleAlarm();
    await host.handleAlarm();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("uses supplied alarm IDs to bound due delivery polling", async () => {
    const attempts = new Map<string, number>();
    const deliver = vi.fn<Channel["deliver"]>(async (_message, context) => {
      if (!context) throw new Error("Expected durable delivery context");
      const attempt = (attempts.get(context.deliveryId) ?? 0) + 1;
      attempts.set(context.deliveryId, attempt);
      return attempt === 1
        ? {
            status: "failed",
            retryable: true,
            error: { code: "RATE_LIMIT", message: "Slow down" }
          }
        : { status: "delivered", reference: context.deliveryId };
    });
    const host = new ChannelHost(
      hostOptions(
        { support: { deliver } },
        { retryBaseDelayMs: 0, scheduler: { schedule: vi.fn() } }
      )
    );
    await host.deliver({
      deliveryId: "notice-1",
      message: { markdown: "First" }
    });
    await host.deliver({
      deliveryId: "notice-2",
      message: { markdown: "Second" }
    });

    await host.handleAlarm(["notice-2", "unknown"]);

    expect(deliver).toHaveBeenCalledTimes(3);
    await expect(host.getDelivery("notice-1")).resolves.toMatchObject({
      result: { status: "failed", retryable: true }
    });
    await expect(host.getDelivery("notice-2")).resolves.toMatchObject({
      result: { status: "delivered" }
    });
  });

  it("resumes a pending delivery during initialization", async () => {
    const storage = memoryStorage();
    await storage.put("cf_channels:delivery:notice-1", {
      id: "notice-1",
      kind: "message",
      channelId: "support",
      message: { markdown: "Hello" },
      status: "pending",
      attempt: 0,
      createdAt: 100,
      updatedAt: 100
    });
    const deliver = vi.fn(async () => ({ status: "delivered" as const }));
    const host = new ChannelHost(
      hostOptions({ support: { deliver } }, { storage })
    );

    await host.init();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await vi.waitFor(async () =>
      expect(host.getDelivery("notice-1")).resolves.toMatchObject({
        result: { status: "delivered" }
      })
    );
  });

  it("reconciles persisted retry state after a non-transactional scheduler failure", async () => {
    const storage = memoryStorage();
    const deliver = vi.fn(async () => ({
      status: "failed" as const,
      retryable: true,
      error: { code: "RATE_LIMIT", message: "Slow down" }
    }));
    const first = new ChannelHost(
      hostOptions(
        { support: { deliver } },
        {
          storage,
          scheduler: {
            schedule: vi.fn(async () => {
              throw new Error("scheduler unavailable");
            })
          }
        }
      )
    );

    await expect(
      first.deliver({
        deliveryId: "notice-1",
        message: { markdown: "Hello" }
      })
    ).rejects.toThrow("scheduler unavailable");
    await expect(first.getDelivery("notice-1")).resolves.toMatchObject({
      result: { status: "failed", retryable: true }
    });

    const schedule = vi.fn();
    const recreated = new ChannelHost(
      hostOptions(
        { support: { deliver } },
        { storage, scheduler: { schedule } }
      )
    );
    await recreated.init();

    expect(schedule).toHaveBeenCalledWith("notice-1", expect.any(Number));
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("does not replace a due scheduler generation when alarm handling initializes a recreated Host", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const storage = memoryStorage();
    const deliver = vi
      .fn<Channel["deliver"]>()
      .mockResolvedValueOnce({
        status: "failed",
        retryable: true,
        error: { code: "RATE_LIMIT", message: "Slow down" }
      })
      .mockResolvedValueOnce({ status: "delivered", reference: "message-1" });
    const first = new ChannelHost(
      hostOptions({ support: { deliver } }, { storage, retryBaseDelayMs: 100 })
    );
    await first.deliver({
      deliveryId: "notice-1",
      message: { markdown: "Hello" }
    });

    now.mockReturnValue(1_100);
    const schedule = vi.fn();
    const recreated = new ChannelHost(
      hostOptions(
        { support: { deliver } },
        { storage, scheduler: { schedule } }
      )
    );
    await recreated.handleAlarm();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("never retries an uncertain provider attempt", async () => {
    const deliver = vi.fn(async () => {
      throw new Error("The request outcome is unknown");
    });
    const host = new ChannelHost(
      hostOptions({ support: { deliver } }, { retryBaseDelayMs: 0 })
    );

    await host.deliver({
      deliveryId: "notice-1",
      message: { markdown: "Hello" }
    });
    await host.handleAlarm();

    expect(deliver).toHaveBeenCalledOnce();
    await expect(host.getDelivery("notice-1")).resolves.toMatchObject({
      result: { status: "uncertain" }
    });
  });

  it("marks an interrupted attempting record uncertain without retrying it", async () => {
    const storage = memoryStorage();
    await storage.put("cf_channels:delivery:notice-1", {
      id: "notice-1",
      kind: "message",
      channelId: "support",
      message: { markdown: "Hello" },
      status: "attempting",
      attempt: 1,
      createdAt: 100,
      updatedAt: 100
    });
    const deliver = vi.fn<Channel["deliver"]>();
    const host = new ChannelHost(
      hostOptions({ support: { deliver } }, { storage })
    );

    await host.handleAlarm();

    expect(deliver).not.toHaveBeenCalled();
    await expect(host.getDelivery("notice-1")).resolves.toMatchObject({
      result: { status: "uncertain" }
    });
  });

  it("atomically records retry state when the scheduler supports transactions", async () => {
    const storage = memoryStorage();
    const schedule = vi.fn(async () => undefined);
    const scheduleInTransaction = vi.fn(async () => undefined);
    const scheduler: ChannelHostScheduler = {
      schedule,
      async transaction<T>(
        callback: (
          transaction: DurableObjectAlarmSourceTransaction
        ) => Promise<T>
      ): Promise<T> {
        return callback({
          get: storage.get.bind(storage),
          list: storage.list.bind(storage),
          put: storage.put.bind(storage),
          delete: storage.delete.bind(storage),
          schedule: scheduleInTransaction,
          cancel: vi.fn(async () => undefined)
        } as DurableObjectAlarmSourceTransaction);
      }
    };
    const host = new ChannelHost(
      hostOptions(
        {
          support: {
            deliver: vi.fn(async () => ({
              status: "failed" as const,
              retryable: true,
              error: { code: "RATE_LIMIT", message: "Slow down" }
            }))
          }
        },
        { storage, scheduler }
      )
    );

    await host.deliver({
      deliveryId: "notice-1",
      message: { markdown: "Hello" }
    });

    expect(schedule).not.toHaveBeenCalled();
    expect(scheduleInTransaction).toHaveBeenCalledWith(
      "notice-1",
      expect.any(Number)
    );
    await expect(host.getDelivery("notice-1")).resolves.toMatchObject({
      result: { status: "failed", retryable: true }
    });
  });

  it("does not send an approval that settled before its delivery intent was created", async () => {
    const channel = approvalChannel();
    const host = new ChannelHost(
      hostOptions({ email: channel }, { approvalRequests: "email" })
    );

    await host.settleApproval("actpause_123", "approve");

    await expect(
      host.requestApproval({
        interactionId: "actpause_123",
        request: approvalRequest
      })
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: { code: "INTERACTION_ALREADY_SETTLED" }
      }
    });
    expect(channel.requestApproval).not.toHaveBeenCalled();
  });

  it("cancels a pending notification retry when the application settles the approval", async () => {
    const requestApproval = vi.fn(async () => ({
      status: "failed" as const,
      retryable: true,
      error: { code: "RATE_LIMIT", message: "Slow down" }
    }));
    const host = new ChannelHost(
      hostOptions(
        { email: { deliver: vi.fn(), requestApproval } },
        {
          approvalRequests: "email",
          retryBaseDelayMs: 0,
          scheduler: { schedule: vi.fn() }
        }
      )
    );
    await host.requestApproval({
      interactionId: "actpause_123",
      request: approvalRequest
    });

    await host.settleApproval("actpause_123", "approve");
    await host.retryDelivery("approval:actpause_123");

    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it("generates stable Host-owned links and requires POST to settle", async () => {
    const onApprovalResponse = vi.fn(async () => undefined);
    let deliveredText = "";
    const channel: Channel = {
      deliver: vi.fn(),
      async requestApproval({ getApprovalLinks }) {
        const first = await getApprovalLinks?.();
        const second = await getApprovalLinks?.();
        expect(second).toEqual(first);
        deliveredText = `${first?.approve}\n${first?.reject}`;
        return { status: "delivered", reference: "email-1" };
      }
    };
    const host = new ChannelHost(
      hostOptions(
        { email: channel },
        {
          approvalRequests: "email",
          publicBaseUrl: "https://example.com/agents/support/123/",
          approvalLinkPath: "approvals",
          onApprovalResponse
        }
      )
    );
    await host.requestApproval({
      interactionId: "actpause_123",
      request: approvalRequest
    });
    const approve = deliveredText.split("\n")[0];
    expect(approve).toMatch(
      /^https:\/\/example\.com\/agents\/support\/123\/approvals\//
    );

    const confirmation = await host.handleRequest(new Request(approve));
    expect(confirmation?.status).toBe(200);
    expect(await confirmation?.text()).toContain("Confirm approve");
    expect(onApprovalResponse).not.toHaveBeenCalled();

    const resolved = await host.handleRequest(
      new Request(approve, { method: "POST" })
    );
    expect(resolved?.status).toBe(200);
    expect(onApprovalResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "approval-link",
        interactionId: "actpause_123",
        decision: "approve"
      })
    );
  });

  it("returns a conflict when the application ledger already settled a link", async () => {
    let approve = "";
    const host = new ChannelHost(
      hostOptions(
        {
          email: {
            deliver: vi.fn(),
            requestApproval: vi.fn(async ({ getApprovalLinks }) => {
              approve = (await getApprovalLinks?.())?.approve ?? "";
              return { status: "delivered", reference: "email-1" };
            })
          }
        },
        {
          approvalRequests: "email",
          publicBaseUrl: "https://example.com",
          onApprovalResponse: vi.fn(async () => {
            throw new ChannelApprovalConflictError();
          })
        }
      )
    );
    await host.requestApproval({
      interactionId: "actpause_conflict",
      request: approvalRequest
    });

    const response = await host.handleRequest(
      new Request(approve, { method: "POST" })
    );

    expect(response?.status).toBe(409);
  });

  it("durably delivers ordinary messages through the configured route", async () => {
    const deliver = vi.fn(async () => ({
      status: "delivered" as const,
      reference: "message-1"
    }));
    const host = new ChannelHost(hostOptions({ support: { deliver } }));
    const options = {
      deliveryId: "notice-1",
      message: { markdown: "Hello" }
    };

    await host.deliver(options);
    await host.deliver(options);

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      { markdown: "Hello" },
      { deliveryId: "notice-1", attempt: 1 }
    );
  });

  it("resolves registered ingress against the top-level public URL", () => {
    const host = new ChannelHost(
      hostOptions(
        {
          telegram: approvalChannel({
            ingress: ingress("/webhooks/telegram", [])
          })
        },
        {
          publicBaseUrl: "https://example.com/agents/support/123"
        }
      )
    );

    expect(host.ingressUrl("telegram")).toBe(
      "https://example.com/agents/support/123/webhooks/telegram"
    );
  });

  it("chooses the longest matching ingress path", async () => {
    const short = ingress("/telegram", []);
    const specific = ingress("/webhooks/telegram", []);
    const host = new ChannelHost(
      hostOptions({
        short: approvalChannel({ ingress: short }),
        specific: approvalChannel({ ingress: specific })
      })
    );

    await host.handleRequest(
      new Request("https://example.com/webhooks/telegram", { method: "POST" })
    );

    expect(specific.receive).toHaveBeenCalledOnce();
    expect(short.receive).not.toHaveBeenCalled();
  });
});
