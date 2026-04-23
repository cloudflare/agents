export type AuthUser = {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
};

export async function fetchCurrentUser(
  signal?: AbortSignal
): Promise<AuthUser | null> {
  const response = await fetch("/auth/me", {
    headers: { Accept: "application/json" },
    signal
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Failed to load the authenticated user");
  }

  return (await response.json()) as AuthUser;
}

export async function signOut() {
  const response = await fetch("/auth/logout", {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("Failed to sign out");
  }
}

export function startGitHubLogin() {
  window.location.href = "/auth/login";
}
