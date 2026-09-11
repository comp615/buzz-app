import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  largeSidebar: true,
  sidebarUnread: true,
});
const sidebar = (page) =>
  page.getByRole("complementary", { name: "Channel sidebar", exact: true });
const list = (page) =>
  page.getByRole("navigation", { name: "Subscribed channels" });
const cue = (page, edge) =>
  sidebar(page).locator(`button[data-edge="${edge}"]`);
const row = (page, id) =>
  list(page).locator(`button[data-channel-id="${id.toLowerCase()}"]`);
const scroll = (page, top) =>
  list(page).evaluate((el, top) => {
    el.scrollTop = top;
  }, top);
const scrollRowAbove = (page, id) =>
  row(page, id).evaluate((el) => {
    const viewport = el.closest("nav");
    if (!viewport) throw new Error("Channel row is outside the channel list");
    const rowRect = el.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    viewport.scrollTop += rowRect.bottom - viewportRect.top + 1;
  });
const inView = (page, id) =>
  row(page, id).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const viewport = el.closest("nav").getBoundingClientRect();
    return (
      rect.height > 0 &&
      rect.top >= viewport.top &&
      rect.bottom <= viewport.bottom
    );
  });
const heads = (app) =>
  app.report.queries.filter(
    ({ filter }) => filter.kinds?.includes(9) && filter["#h"]?.length === 1,
  );

test("channel establishment preserves an in-flight unread batch and its sidebar badges", async ({
  page,
  app,
}) => {
  const alphaHeads = () =>
    app.report.queries.filter(
      ({ community, filter }) =>
        community === "primary" &&
        filter["#h"]?.[0] === "alpha" &&
        filter.top_level === true &&
        filter.until === undefined,
    );
  const evidence = () =>
    app.report.queries.filter(
      ({ community, filter }) =>
        community === "primary" &&
        filter.kinds?.includes(9) &&
        filter.top_level === undefined &&
        filter.depth_limit === undefined &&
        filter.until === undefined,
    );
  app.relay.holdEose("alpha");
  app.relay.holdUnread();
  try {
    await open(page, app);
    await expect.poll(() => app.report.unreadHolds.length).toBe(1);
    expect(evidence()[0].filter["#h"]).toContain("alpha");
    expect(evidence()[0].filter["#h"]).toContain("dm-090");
    expect(alphaHeads()).toHaveLength(1);
    await expect(row(page, "dm-090").getByRole("img")).toHaveCount(0);

    // Establish only after unread is in flight; observe the real finite catch-up
    // before releasing evidence. No sleep or scheduler luck creates the overlap.
    app.relay.releaseEose("alpha");
    await expect.poll(() => alphaHeads().length).toBe(2);
    expect(app.report.unreadHolds).toEqual([{ pending: true, aborted: false }]);
    app.relay.releaseUnread();
    await expect(row(page, "dm-030").getByRole("img")).toHaveCount(1);
    await expect(row(page, "dm-090").getByRole("img")).toHaveCount(1);
    await expect(cue(page, "below")).toBeVisible();
    await expect.poll(() => evidence().length).toBe(2); // 130 IDs, not retries.
    expect(evidence().map(({ filter }) => filter["#h"].length)).toEqual([
      128, 2,
    ]);
    expect(app.report.unreadHolds).toEqual([
      { pending: false, aborted: false },
    ]);
    expect(app.report.readPublications).toEqual([]);
  } finally {
    app.relay.releaseEose("alpha");
    app.relay.releaseUnread();
  }
});

test("edge pills follow scroll and reveal the nearest unread without selection or reads; focus retains existing preparation", async ({
  page,
  app,
}, info) => {
  // Visible rows can precede the post-establishment catch-up. Force that late
  // ordering, then account for its head read before measuring cue-triggered work.
  app.relay.holdEose("alpha");
  try {
    await open(page, app);
    const alphaHeads = () =>
      heads(app).filter(
        ({ community, filter }) =>
          community === "primary" &&
          filter["#h"][0] === "alpha" &&
          filter.top_level === true &&
          filter.until === undefined,
      );
    expect(alphaHeads()).toHaveLength(1);
    app.relay.releaseEose("alpha");
    await expect.poll(() => alphaHeads().length).toBe(2);
  } finally {
    app.relay.releaseEose("alpha");
  }
  const ordinary = row(page, "alpha").getByRole("img", {
    name: /observed unread messages/,
  });
  const directed = row(page, "dm-090").getByRole("img");
  await expect(ordinary).toHaveAttribute("data-attention", "false");
  await expect(ordinary).toHaveText("");
  await expect(ordinary).toHaveCSS("width", "6px");
  await expect(row(page, "alpha").locator("span").first()).toHaveCSS(
    "font-weight",
    "650",
  );
  await expect(directed).toHaveAttribute("data-attention", "true");
  await expect(directed).toHaveText("1");
  await expect(directed).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(row(page, "dm-090").getByRole("img")).toHaveCount(1);
  await expect(cue(page, "below")).toBeVisible();
  await expect(cue(page, "below")).toHaveText("2 unread");
  await expect(cue(page, "below")).toHaveAttribute("data-attention", "true");
  await expect(cue(page, "above")).toHaveCount(0);
  // Keep actionable DMs below while moving only ordinary unread above: priority
  // is derived from the destinations on each edge, not from the whole roster.
  await scrollRowAbove(page, "alpha");
  await expect.poll(() => inView(page, "alpha")).toBe(false);
  await expect(cue(page, "above")).toBeVisible();
  await expect(cue(page, "above")).toHaveText("1 unread");
  await expect(cue(page, "above")).toHaveAttribute("data-attention", "false");
  await expect(cue(page, "below")).toHaveAttribute("data-attention", "true");
  await scroll(page, 0);
  await expect(cue(page, "below")).toHaveAttribute("data-attention", "true");
  await scroll(page, 1800);
  await expect(cue(page, "above")).toBeVisible();
  await expect(cue(page, "below")).toBeVisible();
  const before = heads(app).length;
  const size = await list(page).boundingBox();
  await sidebar(page).screenshot({
    path: info.outputPath("sidebar-unread-both.png"),
  });
  await cue(page, "above").focus();
  await cue(page, "above").press("Enter");
  await expect.poll(() => inView(page, "dm-030")).toBe(true);
  await expect(row(page, "dm-030")).toBeFocused();
  await expect(list(page).locator('[aria-current="page"]')).toHaveAttribute(
    "title",
    "Alpha",
  );
  await cue(page, "below").focus();
  await cue(page, "below").press("Enter");
  await expect.poll(() => inView(page, "dm-090")).toBe(true);
  await expect(cue(page, "below")).toHaveCount(0);
  expect(await list(page).boundingBox()).toEqual(size); // Overlay never resizes the list.
  await page.waitForTimeout(1000);
  expect(
    heads(app)
      .slice(before)
      .every(({ filter }) => ["dm-030", "dm-090"].includes(filter["#h"][0])),
  ).toBe(true); // Only existing focused-row preparation, never a roster fanout.
  expect(app.report.readPublications).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open("buzz-read-state-v1", 1);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("partitions", "readonly");
            const read = tx.objectStore("partitions").getAll();
            read.onsuccess = () => resolve(read.result[0].state.frontiers);
            tx.oncomplete = () => db.close();
          };
        }),
    ),
  ).toEqual({});
  // Use the real wheel, too; programmatic reveal and direct gestures share updates.
  await list(page).hover({ position: { x: 5, y: 5 } });
  await page.mouse.wheel(0, -10000);
  await expect(cue(page, "above")).toHaveCount(0);
  await expect(cue(page, "below")).toBeVisible();
  await page.getByRole("textbox", { name: "Search channels" }).focus();
  await page.keyboard.press("Tab"); // Set keyboard modality from the visible search, not an offscreen row.
  await cue(page, "below").focus();
  await expect(cue(page, "below")).toHaveCSS("outline-width", "2px");
  await cue(page, "below").press("Enter");
  await expect.poll(() => inView(page, "dm-030")).toBe(true);
  await expect(row(page, "dm-030")).toBeFocused();
  if (info.project.name === "chromium") {
    await page.keyboard.press("Tab");
    await expect(row(page, "dm-031")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(row(page, "dm-030")).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(row(page, "dm-030")).toHaveAttribute("aria-current", "page");
});

test("search, resizing, collapsed groups and new unread evidence update only the displayed roster", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(row(page, "dm-090").getByRole("img")).toHaveCount(1);
  const search = page.getByRole("textbox", { name: "Search channels" });
  await search.fill("Alpha");
  await expect(cue(page, "below")).toHaveCount(0);
  await expect(cue(page, "above")).toHaveCount(0);
  await search.fill("missing-channel");
  await expect(cue(page, "below")).toHaveCount(0);
  await search.fill("");
  await expect(cue(page, "below")).toBeVisible();
  // DMs are hidden behind a visible section summary: not below the scroll fold.
  await list(page).locator("summary").filter({ hasText: /^DMs$/ }).click();
  await expect(cue(page, "below")).toHaveCount(0);
  await list(page).locator("summary").filter({ hasText: /^DMs$/ }).click();
  await cue(page, "below").click();
  await expect.poll(() => inView(page, "dm-030")).toBe(true);
  // Collapse the preceding group without scrolling it into view first.
  await list(page)
    .locator("summary")
    .filter({ hasText: /^Channels$/ })
    .evaluate((el) => el.click());
  await expect(cue(page, "above")).toBeVisible();
  await cue(page, "above").click();
  await expect.poll(() => inView(page, "Beta")).toBe(true);
  await expect(list(page).locator("details").first()).toHaveAttribute(
    "open",
    "",
  );
  // A tall viewport makes every row visible; shrinking restores the bottom cue.
  await scroll(page, 0);
  await page.setViewportSize({ width: 1440, height: 6000 });
  await expect(cue(page, "below")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect(cue(page, "below")).toBeVisible();
  await cue(page, "below").click();
  await cue(page, "below").click();
  await expect(cue(page, "below")).toHaveCount(0);
  app.append("primary", "dm-127", "New offscreen unread", false, false);
  // Non-active channels have no live content route. Discover the new evidence
  // through the existing bounded refresh, not by inventing a subscription.
  await page.getByLabel("Conversation options", { exact: true }).click();
  await page.getByText("Unread status", { exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh unread observations", exact: true })
    .click();
  await page.getByLabel("Conversation options", { exact: true }).click();
  await expect(cue(page, "below")).toBeVisible();
  await cue(page, "below").click();
  await expect.poll(() => inView(page, "dm-127")).toBe(true);
  // Source badges disappear on an explicit read, and the edge cue follows.
  await row(page, "dm-127").click();
  await expect(
    page.getByText("New offscreen unread", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Conversation options", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  await expect(row(page, "dm-127").getByRole("img")).toHaveCount(0);
  await page.getByLabel("Conversation options", { exact: true }).click();
  await scroll(page, 2700);
  await expect(cue(page, "below")).toHaveCount(0);
});

test("session changes discard the previous sidebar targets and manual unread still participates", async ({
  page,
  app,
}) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(
    "**/api/relay/secondary/sidebar-preferences",
    async (route) => {
      requested = true;
      await held;
      await route.continue();
    },
  );
  try {
    await open(page, app);
    await expect(cue(page, "below")).toBeVisible();
    await page
      .getByRole("button", { name: "Switch community", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Switch to Secondary", exact: true })
      .click();
    await expect(
      page.getByText(/secondary alpha message/).first(),
    ).toBeVisible();
    await expect(cue(page, "below")).toHaveCount(0);
    await page.getByLabel("Conversation options", { exact: true }).click();
    await page
      .getByRole("button", { name: "Mark unread on this device", exact: true })
      .click();
    await page.getByLabel("Conversation options", { exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await scroll(page, 1800);
    await expect(cue(page, "above")).toBeVisible();
    // Completing delayed preferences must not replace the user's newer viewport.
    release();
    await expect(
      page.getByText("Loading saved groups and stars…", { exact: true }),
    ).toBeHidden();
    expect(await list(page).evaluate((element) => element.scrollTop)).toBe(
      1800,
    );
    await cue(page, "above").click();
    await expect.poll(() => inView(page, "alpha")).toBe(true);
    await expect(
      row(page, "alpha").getByRole("img", {
        name: "Marked unread on this device only",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    release();
    await page.unroute("**/api/relay/secondary/sidebar-preferences");
  }
});

test("DM attention badge uses semantic primary colors in both modes", async ({
  page,
  app,
}) => {
  await open(page, app);
  const badge = row(page, "dm-030").locator("[data-channel-unread]");
  await expect(badge).toHaveAttribute("data-attention", "true");
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.style.backgroundColor = root.getPropertyValue("--primary");
      probe.style.color = root.getPropertyValue("--on-primary");
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const colors = {
        primary: style.backgroundColor,
        onPrimary: style.color,
      };
      probe.remove();
      return colors;
    });
    await expect(badge).toHaveCSS("background-color", colors.primary);
    await expect(badge).toHaveCSS("color", colors.onPrimary);
  }
});
