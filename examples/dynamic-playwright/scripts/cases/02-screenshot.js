async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto("https://example.com");
  const screenshot = await page.screenshot();
  console.log("screenshot bytes", screenshot.byteLength);
  return { screenshot };
};
