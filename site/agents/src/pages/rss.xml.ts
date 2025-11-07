import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

export const GET: APIRoute = async (context) => {
  const blogPosts = await getCollection("blog");
  const sortedPosts = blogPosts.sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime()
  );

  return rss({
    title: "Cloudflare Agents Blog",
    description: "Learn about building agents on Cloudflare",
    site: context.site || "https://agents.cloudflare.com",
    items: sortedPosts.map((post) => {
      const authors = Array.isArray(post.data.author)
        ? post.data.author
        : [post.data.author];
      const authorDisplay =
        authors.length === 1
          ? authors[0]
          : authors.length === 2
            ? `${authors[0]} and ${authors[1]}`
            : `${authors.slice(0, -1).join(", ")}, and ${authors[authors.length - 1]}`;

      return {
        title: post.data.title,
        description: post.data.description,
        pubDate: post.data.pubDate,
        link: `/blog/${post.slug}/`,
        author: authorDisplay
      };
    })
  });
};
