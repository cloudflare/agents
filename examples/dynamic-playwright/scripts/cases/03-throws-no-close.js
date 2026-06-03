// @expect-error intentional failure before close
async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto("https://example.com");
  throw new Error("intentional failure before close");
};
