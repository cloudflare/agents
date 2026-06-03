async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto("https://example.com");
  const title = await page.title();
  console.log("title", title);
  return { title };
};
