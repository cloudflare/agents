export const DEFAULT_SCRIPT = `export default async ({ page }) => {
  await page.goto("https://example.com");

  const title = await page.title();
  console.log("Loaded", title);

  return { title, url: page.url() };
};`;

export const SCRIPTS = [
  {
    label: "Example.com",
    code: DEFAULT_SCRIPT
  },
  {
    label: "Screenshot",
    code: `export default async ({ page }) => {
  await page.goto("https://example.com");
  console.log("Taking screenshot");
  return await page.screenshot();
};`
  },
  {
    label: "Search docs",
    code: `export default async ({ page }) => {
  await page.goto("https://developers.cloudflare.com/browser-run/");
  console.log("Title:", await page.title());
  return {
    title: await page.title(),
    headings: await page.$$eval("h1, h2", (items) =>
      items.map((item) => item.textContent?.trim()).filter(Boolean)
    )
  };
};`
  }
];
