import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  largeSidebar: true,
});
test("thread buttons show observed unread independently, clear only after reading, and expose hover/focus affordance", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const button = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const first = button(roots[0]);
  const other = button(roots[1]);
  const broadcast = button(
    app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Broadcast reply"),
  );
  const dot = (control) =>
    control.locator('span[title^="Observed unread replies"]');
  await expect(first).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(other).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(dot(first)).toBeVisible();
  await expect(dot(other)).toBeVisible();
  await expect(broadcast).toHaveAccessibleName(/Observed unread replies/);
  const alpha = page.locator('button[data-channel-id="alpha"]');
  const activity = alpha.getByRole("img", { name: /unread threads?/ });
  await expect(activity).toBeVisible();
  await expect(alpha.locator("span").first()).toHaveCSS("font-weight", "650");
  await alpha.hover();
  const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
  await expect(popover).toBeVisible();
  await expect(
    popover.getByRole("button", { name: /Open unread thread from/ }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await alpha.focus();
  await alpha.press("Enter");
  await expect(popover).toBeVisible();
  const item = popover
    .getByRole("button", {
      name: /Open unread thread from/,
    })
    .first();
  await item.focus();
  await expect(item).toBeFocused();
  await item.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(alpha).toBeFocused();
  const queries = () =>
    app.report.queries.filter(({ filter }) => filter.depth_limit);
  expect(queries()).toHaveLength(0); // Merely displaying buttons never fetches threads.
  const rect = await first.boundingBox();
  await first.hover();
  expect(await first.boundingBox()).toEqual(rect);
  await expect(first).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const hover = await first.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopColor, radius: s.borderTopLeftRadius };
  });
  expect(hover.border).not.toBe("rgba(0, 0, 0, 0)");
  expect(hover.radius).not.toBe("0px");
  await first.screenshot({
    path: testInfo.outputPath("thread-button-hover.png"),
  });
  // WebKit's macOS tab policy skips buttons; keyboard input still selects
  // focus-visible modality, then focus the actual control in both engines.
  await page.keyboard.press("Tab");
  await first.focus();
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("outline-style", "solid");
  await expect(first).toHaveCSS("outline-width", "2px");
  await broadcast.focus();
  await broadcast.press("Enter");
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = panel.getByRole("region", { name: "Thread messages" });
  await expect(
    panel.getByText("Unread reply 0", { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("textbox", { name: "Reply to thread", exact: true })
    .focus();
  await page.waitForTimeout(1000);
  await expect(first).toHaveAccessibleName(/Observed unread replies/); // Click/composer focus is not reading.
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(broadcast).toHaveAccessibleName("View thread: 23 replies");
  await expect(dot(first)).toHaveCount(0);
  await expect(dot(other)).toBeVisible();
  await expect(other).toHaveAccessibleName(/Observed unread replies/); // No channel-wide shortcut.
  await panel
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  app.reply(roots[0].id, true);
  await page.waitForTimeout(1000);
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  app.reply(roots[0].id);
  await expect(first).toHaveAccessibleName(/Observed unread replies/);
  await first.click();
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  await page.reload();
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
});
