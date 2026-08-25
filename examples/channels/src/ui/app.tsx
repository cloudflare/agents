import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Empty,
  LayerCard,
  Text,
  Tooltip
} from "@cloudflare/kumo";
import {
  ChatCircleDotsIcon,
  ClipboardTextIcon,
  PlugsConnectedIcon
} from "@phosphor-icons/react";
import type { ChannelIdentity, ChannelMessageSurface } from "agents/channels";
import type { ConversationPage, UserPage } from "../types";
import { api, useDirectory } from "./api";
import { ConversationView } from "./conversation";
import { IdentityPanel, UserView } from "./people";
import {
  ErrorBanner,
  ModeToggle,
  ProviderAvatar,
  errorMessage,
  formatClock
} from "./shared";

export function App() {
  const directory = useDirectory();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState<ConversationPage | null>(null);
  const [userPage, setUserPage] = useState<UserPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await action();
        return true;
      } catch (caught) {
        setError(errorMessage(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const open = useCallback(
    (conversationId: string) => {
      setSelectedId(conversationId);
      setUserPage(null);
      return run(async () => setPage(await api.conversation(conversationId)));
    },
    [run]
  );

  const updatedAt = directory.conversations.find(
    (conversation) => conversation.id === selectedId
  )?.updatedAt;

  // Reload the open conversation whenever polling shows new activity in it.
  useEffect(() => {
    if (selectedId && updatedAt) {
      void api.conversation(selectedId).then(setPage);
    }
  }, [selectedId, updatedAt]);

  const send = (
    markdown: string,
    surface: ChannelMessageSurface,
    approval: boolean
  ) =>
    run(async () => {
      if (!selectedId) return;
      setPage(
        approval
          ? await api.requestApproval(selectedId, markdown, surface)
          : await api.reply(selectedId, markdown, surface)
      );
    });

  const link = (identity: ChannelIdentity, userId?: string) =>
    void run(async () => {
      if (!selectedId) return;
      await api.link(identity, userId);
      setPage(await api.conversation(selectedId));
    });

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-kumo-canvas">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-kumo-line bg-kumo-base px-5 py-2.5">
        <div className="flex items-center gap-2.5">
          <PlugsConnectedIcon
            size={20}
            weight="fill"
            className="text-kumo-brand"
          />
          <Text size="base" bold as="h1">
            Channels support
          </Text>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Tooltip
            content="Open the customer-facing support form"
            render={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.location.assign("/support-form")}
                icon={<ClipboardTextIcon size={15} />}
              >
                Support form
              </Button>
            }
          />
          <ModeToggle />
        </div>
      </header>

      {error && <ErrorBanner message={error} />}

      <main className="min-h-0 flex-1 overflow-hidden">
        {userPage ? (
          <div className="h-full overflow-y-auto">
            <UserView
              page={userPage}
              onBack={() => setUserPage(null)}
              onOpenConversation={(id) => void open(id)}
            />
          </div>
        ) : (
          <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[19rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)_20rem]">
            <section
              aria-label="Conversations"
              className="flex min-h-0 flex-col border-kumo-line bg-kumo-base md:border-r"
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4 py-3">
                <Text size="sm" bold as="h2">
                  Conversations
                </Text>
                <Badge variant="neutral">
                  {directory.conversations.length}
                </Badge>
              </div>
              {directory.conversations.length === 0 ? (
                <div className="p-4">
                  <Empty
                    size="sm"
                    icon={<ChatCircleDotsIcon size={32} />}
                    title="Nothing yet"
                    description="Send a message through one of the configured Channels."
                  />
                </div>
              ) : (
                <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
                  {directory.conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        onClick={() => void open(conversation.id)}
                        className={`flex w-full gap-3 rounded-lg px-3 py-2.5 text-left ${
                          conversation.id === selectedId
                            ? "bg-kumo-fill"
                            : "hover:bg-kumo-elevated"
                        }`}
                      >
                        <ProviderAvatar
                          channelKey={conversation.lastChannelKey}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <Text size="sm" bold truncate>
                              {conversation.title}
                            </Text>
                            <span className="shrink-0 text-xs text-kumo-inactive">
                              {formatClock(conversation.updatedAt)}
                            </span>
                          </span>
                          <span className="mt-0.5 block">
                            <Text size="xs" variant="secondary" truncate>
                              {conversation.preview}
                            </Text>
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section
              aria-label="Conversation"
              className="min-h-0 border-kumo-line xl:border-r"
            >
              <ConversationView
                page={page}
                busy={busy}
                onSend={send}
                onClose={() =>
                  void run(async () => {
                    if (selectedId) setPage(await api.close(selectedId));
                  })
                }
              />
            </section>

            <aside
              aria-label="People"
              className="hidden min-h-0 overflow-y-auto bg-kumo-base p-4 xl:block"
            >
              {page ? (
                <IdentityPanel
                  page={page}
                  users={directory.users}
                  busy={busy}
                  onLink={link}
                  onOpenUser={(userId) =>
                    void run(async () => setUserPage(await api.user(userId)))
                  }
                />
              ) : (
                <LayerCard className="p-4">
                  <Text size="xs" variant="secondary">
                    Select a conversation to see its channel identities.
                  </Text>
                </LayerCard>
              )}
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
