async ({ browser }) => {
  const first = await browser.newPage();
  const second = await browser.newPage();
  await Promise.all([
    first.goto("https://example.com"),
    second.goto("https://example.org")
  ]);
  const titles = await Promise.all([first.title(), second.title()]);
  return { titles };
};
