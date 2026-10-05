export type OpenCodeSessionId = string;

export type OpenCodeWhenBusy = "followUp" | "steer";

export type OpenCodeSubmitOptions = {
  readonly session?: OpenCodeSessionId;
  readonly operationId?: string;
  readonly whenBusy?: OpenCodeWhenBusy;
  readonly agent?: string;
};

export type OpenCodeSessionOptions = {
  readonly session?: OpenCodeSessionId;
};

export type OpenCodeReceipt = {
  readonly operationId: string;
  readonly session: OpenCodeSessionId;
  readonly accepted: boolean;
};

export type OpenCodeOperationResult = {
  readonly operationId: string;
  readonly session: OpenCodeSessionId;
  readonly status: "done" | "unanswered";
  readonly reason?: string;
  readonly text?: string;
};

export type OpenCodePromptResponse = OpenCodeOperationResult & {
  readonly messages: readonly OpenCodeMessage[];
};

export type OpenCodePendingOperation = {
  readonly operationId: string;
  readonly session: OpenCodeSessionId;
  readonly status: "queued" | "running";
};

export type OpenCodeSessionInfo = {
  readonly id: OpenCodeSessionId;
  readonly parent?: OpenCodeSessionId;
  readonly busy: boolean;
};

export type OpenCodeModel = {
  readonly providerID: string;
  readonly id: string;
};

export type OpenCodeProvider = {
  readonly id: string;
  readonly config: Record<string, unknown>;
  readonly plugin: unknown;
};

export type OpenCodeJson =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly OpenCodeJson[]
  | { readonly [key: string]: OpenCodeJson };

export type OpenCodePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly status: "pending" | "running" | "completed" | "error";
      readonly input?: OpenCodeJson;
      readonly output?: string;
      readonly error?: string;
    };

export type OpenCodeMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly OpenCodePart[];
  readonly timestamp: number;
};

export type OpenCodePermission = {
  readonly id: string;
  readonly session: OpenCodeSessionId;
  readonly action: string;
  readonly resources: readonly string[];
  readonly askedAt: number;
};

export type OpenCodeEvent =
  | ({ readonly type: "snapshot" } & OpenCodeSnapshot)
  | {
      readonly type: "operation_start";
      readonly operationId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: "operation_end";
      readonly operationId: string;
      readonly status: "completed" | "aborted" | "failed" | "declined";
      readonly error?: { readonly code: string; readonly message: string };
      readonly endedAt: number;
    }
  | {
      readonly type: "operation_wait";
      readonly operationId: string;
      readonly reason: "permission" | "busy" | "budget";
      readonly notBefore: number;
    }
  | { readonly type: "message_start"; readonly message: OpenCodeMessage }
  | {
      readonly type: "text_delta";
      readonly messageId: string;
      readonly partId: string;
      readonly delta: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly messageId: string;
      readonly partId: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool_start";
      readonly toolCallId: string;
      readonly name: string;
      readonly input: OpenCodeJson;
    }
  | {
      readonly type: "tool_end";
      readonly toolCallId: string;
      readonly name: string;
      readonly error: boolean;
      readonly output?: string;
    }
  | {
      readonly type: "permission_asked";
      readonly permission: OpenCodePermission;
    }
  | { readonly type: "permission_replied"; readonly permissionId: string }
  | { readonly type: "message_end"; readonly messageId: string }
  | { readonly type: "transcript_reset"; readonly reason: "compaction" }
  | { readonly type: "fault"; readonly code: string; readonly message: string };

export type OpenCodeSnapshot = {
  readonly session: OpenCodeSessionId;
  readonly messages: readonly OpenCodeMessage[];
  readonly running: boolean;
  readonly operationId: string | null;
  readonly pending: readonly OpenCodePendingOperation[];
  readonly permissions: readonly OpenCodePermission[];
  readonly agent: string | null;
  readonly model: OpenCodeModel | null;
};

export type OpenCodeEventStream = {
  readonly snapshot: OpenCodeEvent & { readonly type: "snapshot" };
  start(listener: (events: readonly OpenCodeEvent[]) => void): void;
  stop(): Promise<void>;
};
