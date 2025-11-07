import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    author: z.union([z.string(), z.array(z.string())]).default("Cloudflare"),
    tags: z.array(z.string()).optional()
  })
});

const authors = defineCollection({
  type: "data",
  schema: z.object({
    name: z.string(),
    bio: z.string(),
    avatar: z.string(), // path to image
    social: z
      .object({
        twitter: z.string().optional(),
        github: z.string().optional(),
        linkedin: z.string().optional(),
        website: z.string().optional()
      })
      .optional()
  })
});

export const collections = { blog, authors };
