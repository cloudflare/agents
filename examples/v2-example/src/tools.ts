import { defineTool } from "agents/v2";

export const internet_search = defineTool(
  {
    name: "internet_search",
    description: "Search the internet for information",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The query to search for" }
      }
    }
  },
  async (p: { query: string }, ctx) => {
    const retries = 3;
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.env.TAVILY_API_KEY}`
          },
          body: JSON.stringify({ query: p.query })
        });
        if (response.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        if (!response.ok) {
          throw new Error(
            `Failed to search the internet: ${response.statusText}`
          );
        }
        return response.text();
      } catch (error) {
        if (i >= retries - 1) {
          throw error;
        }
      }
    }
    return "Error: Failed to search the internet";
  }
);

export const read_website = defineTool(
  {
    name: "read_website",
    description: "Read the contents of a website(s) for information",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          description: "The URLs to read",
          items: { type: "string" }
        }
      }
    }
  },
  async (p: { urls: string[] }, ctx) => {
    const retries = 3;
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch("https://api.tavily.com/extract", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.env.TAVILY_API_KEY}`
          },
          body: JSON.stringify({ urls: p.urls })
        });
        if (response.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        if (!response.ok) {
          throw new Error(
            `Failed to search the internet: ${response.statusText}`
          );
        }
        return response.text();
      } catch (error) {
        if (i >= retries - 1) {
          throw error;
        }
      }
    }
    return "Error: Failed to read the website(s)";
  }
);
