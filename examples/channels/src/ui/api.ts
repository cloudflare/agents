import { useEffect, useState } from "react";
import type {
  ChannelIdentity,
  ChannelMessageSurface,
  UserIdentity
} from "agents/channels";
import type { ConversationPage, DirectorySnapshot, UserPage } from "../types";

/** The ingress path of the example's own support-form Channel. */
const SUPPORT_FORM_PATH = "/ingress/support-form";

async function send<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }
  );
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

const path = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;

export const api = {
  directory: () => send<DirectorySnapshot>("/api/directory"),
  conversation: (id: string) => send<ConversationPage>(path(id)),
  reply: (id: string, markdown: string, surface: ChannelMessageSurface) =>
    send<ConversationPage>(`${path(id)}/reply`, { markdown, surface }),
  requestApproval: (
    id: string,
    markdown: string,
    surface: ChannelMessageSurface
  ) => send<ConversationPage>(`${path(id)}/approval`, { markdown, surface }),
  close: (id: string) => send<ConversationPage>(`${path(id)}/close`, {}),
  user: (id: string) => send<UserPage>(`/api/users/${encodeURIComponent(id)}`),
  link: (identity: ChannelIdentity, userId?: string) =>
    send<UserIdentity>("/api/links", { identity, userId }),
  submitSupportForm: (form: {
    message: string;
    email: string;
    name?: string;
  }) => send<{ accepted: boolean }>(SUPPORT_FORM_PATH, form)
};

/** Poll the directory so provider messages appear without a page refresh. */
export function useDirectory(): DirectorySnapshot {
  const [snapshot, setSnapshot] = useState<DirectorySnapshot>({
    conversations: [],
    users: []
  });

  useEffect(() => {
    let active = true;
    const poll = () =>
      api
        .directory()
        .then((next) => {
          if (active) setSnapshot(next);
        })
        .catch(() => undefined);

    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return snapshot;
}
