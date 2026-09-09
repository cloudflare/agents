import { useState } from "react";
import {
  Badge,
  Button,
  ClipboardText,
  Empty,
  LayerCard,
  Select,
  Text
} from "@cloudflare/kumo";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  LinkSimpleIcon,
  UserCircleIcon
} from "@phosphor-icons/react";
import {
  identityKey,
  type ChannelIdentity,
  type UserIdentity
} from "agents/channels";
import type { ConversationPage, UserPage } from "../types";
import { provider, ProviderAvatar, ProviderBadge, userLabel } from "./shared";

/**
 * Explicit identity linking: the application decides, never the transport.
 *
 * A conversation belongs to at most one user, so once it has one, every other
 * identity in it joins that same user.
 */
export function IdentityPanel({
  page,
  users,
  busy,
  onLink,
  onOpenUser
}: {
  page: ConversationPage;
  users: readonly UserIdentity[];
  busy: boolean;
  onLink: (identity: ChannelIdentity, userId?: string) => void;
  onOpenUser: (userId: string) => void;
}) {
  const [linkTo, setLinkTo] = useState("new");
  const user = page.user;
  const linked = new Set(user?.channelIdentities.map(identityKey) ?? []);

  return (
    <div className="space-y-4">
      <LayerCard className="p-4">
        <Text size="sm" bold as="h2">
          User
        </Text>
        {user ? (
          <button
            type="button"
            onClick={() => onOpenUser(user.id)}
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-kumo-elevated"
          >
            <UserCircleIcon
              size={20}
              weight="fill"
              className="text-kumo-subtle"
            />
            <span className="min-w-0 flex-1">
              <Text size="sm" bold truncate>
                {userLabel(user)}
              </Text>
            </span>
            <ArrowSquareOutIcon
              size={14}
              className="shrink-0 text-kumo-inactive"
            />
          </button>
        ) : (
          <div className="mt-2">
            <Text size="xs" variant="secondary">
              No user yet. Links are always explicit — nothing is matched by
              address or display name.
            </Text>
          </div>
        )}
      </LayerCard>

      <LayerCard className="p-4">
        <Text size="sm" bold as="h2">
          Channel identities
        </Text>
        {page.conversation.identities.length === 0 ? (
          <div className="mt-2">
            <Text size="xs" variant="secondary">
              This conversation carries no reusable identity.
            </Text>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {page.conversation.identities.map((identity) => (
              <li key={identityKey(identity)} className="space-y-2">
                <div className="flex items-center gap-2">
                  {provider(identity.channelKey).icon}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-kumo-default">
                    {identity.subject}
                  </span>
                  {linked.has(identityKey(identity)) ? (
                    <Badge variant="teal-subtle">Linked</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      icon={<LinkSimpleIcon size={14} />}
                      onClick={() =>
                        onLink(
                          identity,
                          user?.id ?? (linkTo === "new" ? undefined : linkTo)
                        )
                      }
                    >
                      Link
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {!user && users.length > 0 && (
          <div className="mt-3 border-t border-kumo-hairline pt-3">
            <Select
              size="sm"
              aria-label="Link to"
              value={linkTo}
              renderValue={(value) => {
                const candidate = users.find(
                  (user) => user.id === String(value)
                );
                return candidate
                  ? `Link to ${userLabel(candidate)}`
                  : "Link to a new user";
              }}
              onValueChange={(value) => setLinkTo(String(value))}
            >
              <Select.Option value="new">Link to a new user</Select.Option>
              {users.map((candidate) => (
                <Select.Option key={candidate.id} value={candidate.id}>
                  {userLabel(candidate)}
                </Select.Option>
              ))}
            </Select>
          </div>
        )}
      </LayerCard>
    </div>
  );
}

/** One user, every identity linked to them, and every conversation reached. */
export function UserView({
  page,
  onBack,
  onOpenConversation
}: {
  page: UserPage;
  onBack: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-5 py-6">
      <Button
        variant="ghost"
        onClick={onBack}
        icon={<ArrowLeftIcon size={16} />}
      >
        Back to conversations
      </Button>

      <LayerCard className="p-5">
        <div className="flex items-start gap-3">
          <UserCircleIcon
            size={36}
            weight="fill"
            className="shrink-0 text-kumo-subtle"
          />
          <div className="min-w-0 flex-1">
            <Text variant="heading3" as="h1">
              {userLabel(page.user)}
            </Text>
            <div className="mt-1">
              <ClipboardText size="sm" text={page.user.id} />
            </div>
          </div>
        </div>
      </LayerCard>

      <LayerCard className="p-5">
        <Text size="sm" bold as="h2">
          Linked channel identities
        </Text>
        <ul className="mt-3 space-y-2">
          {page.user.channelIdentities.map((identity) => (
            <li
              key={identityKey(identity)}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-kumo-elevated px-3 py-2"
            >
              <ProviderBadge channelKey={identity.channelKey} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-kumo-default">
                {identity.subject}
              </span>
            </li>
          ))}
        </ul>
      </LayerCard>

      <LayerCard className="p-5">
        <Text size="sm" bold as="h2">
          Conversations
        </Text>
        {page.conversations.length === 0 ? (
          <div className="mt-3">
            <Empty size="sm" title="No linked conversations" />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-kumo-line">
            {page.conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 py-3 text-left hover:bg-kumo-elevated"
                  onClick={() => onOpenConversation(conversation.id)}
                >
                  <ProviderAvatar
                    channelKey={conversation.lastChannelKey}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1">
                    <Text size="sm" bold truncate>
                      {conversation.title}
                    </Text>
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
      </LayerCard>
    </div>
  );
}
