import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  Select,
  Switch,
  Text,
  Tooltip,
  type BadgeVariant
} from "@cloudflare/kumo";
import {
  ChatCircleDotsIcon,
  PaperPlaneRightIcon,
  ShieldCheckIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import type { ChannelMessageSurface } from "agents/channels";
import type { ConversationPage, Message, SentMessage } from "../types";
import { provider, ProviderAvatar, Timestamp, formatFullTime } from "./shared";

function surfaceKey(surface: ChannelMessageSurface): string {
  return JSON.stringify(surface);
}

function author(message: Message): string {
  return message.direction === "sent"
    ? "Support"
    : (message.author?.name ?? "User");
}

/** How the Channel reported this one attempt. */
function DeliveryReceipt({ message }: { message: SentMessage }) {
  const { delivery, destination } = message;
  const variant: BadgeVariant =
    delivery.status === "delivered"
      ? "success"
      : delivery.status === "failed"
        ? "error"
        : "warning";

  return (
    <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
      <span className="flex items-center gap-1 text-kumo-inactive">
        {provider(destination.channelKey).icon}
        <Text size="xs" variant="secondary">
          {destination.label}
        </Text>
      </span>
      <Badge variant={variant}>{delivery.status}</Badge>
      {delivery.status !== "delivered" && (
        <Tooltip
          content={delivery.error.code}
          render={
            <span className="cursor-help">
              <Text size="xs" variant="secondary">
                {delivery.error.message}
              </Text>
            </span>
          }
        />
      )}
    </div>
  );
}

function ApprovalCard({ message }: { message: SentMessage }) {
  const approval = message.approval;
  if (!approval) return null;

  const variant: BadgeVariant =
    approval.decision === "approve"
      ? "success"
      : approval.decision === "reject"
        ? "error"
        : "warning";

  return (
    <div className="rounded-2xl bg-kumo-base px-4 py-3 ring ring-kumo-line">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon size={16} weight="fill" className="text-kumo-brand" />
        <Text size="xs" bold>
          Elevated access request
        </Text>
        <span className="ml-auto">
          <Badge variant={variant}>
            {approval.decision ?? "awaiting decision"}
          </Badge>
        </span>
      </div>
      <p className="mt-2 mb-0 text-sm leading-6 whitespace-pre-wrap text-kumo-default">
        {message.markdown}
      </p>
      {approval.decidedAt && (
        <div className="mt-2 border-t border-kumo-hairline pt-2">
          <Text size="xs" variant="secondary">
            Decided by the user at {formatFullTime(approval.decidedAt)}
          </Text>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const sent = message.direction === "sent";
  return (
    <li className={`mt-4 flex ${sent ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[46rem] min-w-0">
        <div
          className={`mb-1 flex items-center gap-2 ${sent ? "justify-end" : ""}`}
        >
          <Text size="xs" bold>
            {author(message)}
          </Text>
          <Timestamp at={message.createdAt} />
        </div>
        {message.direction === "sent" && message.approval ? (
          <ApprovalCard message={message} />
        ) : (
          <div
            className={`rounded-2xl px-4 py-2.5 ring ${
              sent
                ? "bg-kumo-brand/8 ring-kumo-brand/20"
                : "bg-kumo-elevated ring-kumo-hairline"
            }`}
          >
            <p className="m-0 text-sm leading-6 whitespace-pre-wrap text-kumo-default">
              {message.markdown}
            </p>
          </div>
        )}
        {message.direction === "sent" && <DeliveryReceipt message={message} />}
      </div>
    </li>
  );
}

function Composer({
  page,
  busy,
  onSend
}: {
  page: ConversationPage;
  busy: boolean;
  onSend: (
    markdown: string,
    surface: ChannelMessageSurface,
    approval: boolean
  ) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [approvalMode, setApprovalMode] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const targets = page.targets;
  const selected =
    targets.find((target) => surfaceKey(target) === selectedKey) ?? targets[0];

  if (page.conversation.closedAt) {
    return (
      <div className="flex items-center justify-center gap-2 border-t border-kumo-line bg-kumo-elevated px-5 py-4">
        <Text size="xs" variant="secondary">
          This conversation is closed.
        </Text>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="border-t border-kumo-line bg-kumo-elevated px-5 py-4">
        <Text size="xs" variant="secondary">
          Nowhere to answer yet. The support form is inbound only — link a
          channel identity to contact this person directly.
        </Text>
      </div>
    );
  }

  return (
    <form
      className="border-t border-kumo-line bg-kumo-base px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSend(text, selected, approvalMode).then((sent) => {
          if (sent) setText("");
        });
      }}
    >
      <div className="rounded-xl ring ring-kumo-line focus-within:ring-kumo-focus">
        <InputArea
          value={text}
          onValueChange={setText}
          rows={3}
          disabled={busy}
          aria-label={approvalMode ? "Approval summary" : "Reply message"}
          placeholder={
            approvalMode
              ? "Describe the access the user should approve…"
              : "Write a reply…"
          }
          className="!min-h-20 !border-0 !bg-transparent !ring-0 focus:!ring-0"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-hairline px-2 py-2">
          <Select
            size="sm"
            aria-label="Destination"
            value={surfaceKey(selected)}
            disabled={busy}
            renderValue={(value) => {
              const target = targets.find(
                (candidate) => surfaceKey(candidate) === String(value)
              );
              return target ? target.label : "Select a destination";
            }}
            onValueChange={(value) => setSelectedKey(String(value))}
          >
            {targets.map((target) => (
              <Select.Option
                key={surfaceKey(target)}
                value={surfaceKey(target)}
              >
                {target.label}
              </Select.Option>
            ))}
          </Select>
          <div className="flex items-center gap-2">
            <Switch
              size="sm"
              label="Request elevated access"
              labelTooltip="Ask the Channel to render an approval the user decides in their own app."
              checked={approvalMode}
              disabled={busy}
              onCheckedChange={setApprovalMode}
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || text.trim().length === 0}
              icon={
                approvalMode ? (
                  <ShieldCheckIcon size={14} weight="fill" />
                ) : (
                  <PaperPlaneRightIcon size={14} weight="fill" />
                )
              }
            >
              {approvalMode ? "Send request" : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

export function ConversationView({
  page,
  busy,
  onSend,
  onClose
}: {
  page: ConversationPage | null;
  busy: boolean;
  onSend: (
    markdown: string,
    surface: ChannelMessageSurface,
    approval: boolean
  ) => Promise<boolean>;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageCount = page?.conversation.messages.length ?? 0;

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messageCount]);

  if (!page) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty
          icon={<ChatCircleDotsIcon size={44} />}
          title="Select a conversation"
          description="Send a message from Slack, Telegram, email, or the support form."
        />
      </div>
    );
  }

  const { conversation } = page;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-kumo-line bg-kumo-base px-5 py-3">
        <ProviderAvatar channelKey={conversation.lastChannelKey} />
        <div className="min-w-0 flex-1">
          <Text size="base" bold truncate as="h2">
            {conversation.title}
          </Text>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Text size="xs" variant="secondary">
              route {conversation.id}
            </Text>
            {conversation.closedAt && <Badge variant="neutral">Closed</Badge>}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || conversation.closedAt !== null}
          onClick={onClose}
          icon={<XCircleIcon size={14} />}
        >
          Close
        </Button>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto bg-kumo-canvas px-5 py-2"
      >
        <ol className="pb-2">
          {conversation.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </ol>
      </div>

      <div className="shrink-0">
        <Composer page={page} busy={busy} onSend={onSend} />
      </div>
    </div>
  );
}
