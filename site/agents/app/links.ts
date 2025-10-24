export const withUtm = (link: string) => {
  const url = new URL(link);
  url.searchParams.append("utm_content", "agents.cloudflare.com");
  return url.toString();
};

export const DASHBOARD_HREF = withUtm(
  "https://dash.cloudflare.com/?to=/:account/workers-and-pages/create"
);
export const AGENTS_DOCS_HREF = withUtm(
  "https://developers.cloudflare.com/agents/"
);
