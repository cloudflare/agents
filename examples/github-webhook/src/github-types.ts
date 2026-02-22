// GitHub webhook event types
// See: https://docs.github.com/en/webhooks/webhook-events-and-payloads

export type GitHubEventType =
  | "push"
  | "pull_request"
  | "issues"
  | "issue_comment"
  | "star"
  | "fork"
  | "watch"
  | "create"
  | "delete"
  | "release"
  | "ping";

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: GitHubUser;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
}

export interface GitHubCommit {
  id: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
  url: string;
  timestamp: string;
}

export interface GitHubPushPayload {
  ref: string;
  before: string;
  after: string;
  commits: GitHubCommit[];
  pusher: { name: string; email: string };
  repository: GitHubRepository;
  sender: GitHubUser;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: GitHubUser;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface GitHubPullRequestPayload {
  action:
    | "opened"
    | "closed"
    | "reopened"
    | "synchronize"
    | "edited"
    | "review_requested";
  number: number;
  pull_request: GitHubPullRequest;
  repository: GitHubRepository;
  sender: GitHubUser;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: GitHubUser;
  labels: Array<{ name: string; color: string }>;
  created_at: string;
  updated_at: string;
}

export interface GitHubIssuesPayload {
  action: "opened" | "closed" | "reopened" | "edited" | "labeled" | "unlabeled";
  issue: GitHubIssue;
  repository: GitHubRepository;
  sender: GitHubUser;
}

export interface GitHubIssueCommentPayload {
  action: "created" | "edited" | "deleted";
  issue: GitHubIssue;
  comment: {
    id: number;
    body: string;
    user: GitHubUser;
    created_at: string;
    html_url: string;
  };
  repository: GitHubRepository;
  sender: GitHubUser;
}

export interface GitHubStarPayload {
  action: "created" | "deleted";
  starred_at: string | null;
  repository: GitHubRepository;
  sender: GitHubUser;
}

export interface GitHubForkPayload {
  forkee: GitHubRepository;
  repository: GitHubRepository;
  sender: GitHubUser;
}

export interface GitHubReleasePayload {
  action: "published" | "created" | "edited" | "deleted";
  release: {
    id: number;
    tag_name: string;
    name: string | null;
    body: string | null;
    html_url: string;
    author: GitHubUser;
    created_at: string;
    published_at: string | null;
  };
  repository: GitHubRepository;
  sender: GitHubUser;
}

export interface GitHubPingPayload {
  zen: string;
  hook_id: number;
  hook: {
    type: string;
    id: number;
    events: string[];
    active: boolean;
  };
  repository: GitHubRepository;
  sender: GitHubUser;
}

export type GitHubWebhookPayload =
  | GitHubPushPayload
  | GitHubPullRequestPayload
  | GitHubIssuesPayload
  | GitHubIssueCommentPayload
  | GitHubStarPayload
  | GitHubForkPayload
  | GitHubReleasePayload
  | GitHubPingPayload;

// Stored event format
export interface StoredEvent {
  id: string;
  type: GitHubEventType;
  action?: string;
  title: string;
  description: string;
  url: string;
  actor: {
    login: string;
    avatar_url: string;
  };
  timestamp: string;
}
