import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  savedSidebar: true,
  largeSidebar: true,
  developmentReact: true,
});
test("Home → Messages keeps saved groups, selected channel, and scroll on every visible frame without re-decoding", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  await expect(sidebar.locator("summary", { hasText: /^Work$/ })).toBeVisible();
  await expect(
    sidebar.locator("summary", { hasText: /Starred$/ }),
  ).toBeVisible();
  await sidebar.locator('button[data-channel-id="beta"]').click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  const scroll = await sidebar.evaluate((element) => {
    element.scrollTop = 1000;
    return element.scrollTop;
  });
  expect(scroll).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await expect(sidebar).toHaveCount(0);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let decodes = 0;
  await page.route("**/sidebar-preferences", async (route) => {
    decodes++;
    await held;
    await route.continue();
  });
  await page.evaluate(() => {
    window.sidebarFrames = [];
    window.captureSidebar = true;
    const frame = () => {
      const list = document.querySelector(
        'nav[aria-label="Subscribed channels"]',
      );
      if (list)
        window.sidebarFrames.push({
          top: list.scrollTop,
          groups: Array.from(list.querySelectorAll("summary"), (el) =>
            el.textContent.replace("★", "").trim(),
          ),
        });
      if (window.captureSidebar) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  try {
    await page
      .getByRole("button", { name: "Messages", exact: true })
      .first()
      .click();
    await expect(sidebar).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(300); // Keep the decode path held for the full interval.
    // Wall time does not guarantee RAF callbacks on a busy runner. Wait for
    // samples, not correct samples: every earlier frame stays in the assertion.
    await page.waitForFunction(() => window.sidebarFrames.length > 3);
    const frames = await page.evaluate(() => {
      window.captureSidebar = false;
      return window.sidebarFrames;
    });
    expect(frames.length).toBeGreaterThan(3);
    expect(
      frames.filter(
        (frame) =>
          !frame.groups.includes("Work") ||
          !frame.groups.includes("Starred") ||
          Math.abs(frame.top - scroll) > 1,
      ),
      "No fallback grouping or top-of-list frame on warm return",
    ).toEqual([]);
    expect(
      decodes,
      "Remount must reuse the engine snapshot, not fetch/decode again",
    ).toBe(0);
  } finally {
    release();
    await page.unroute("**/sidebar-preferences");
  }
});
