import { expect } from "@playwright/test";
const rowSelector = "[data-message-id]";
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });

export async function settle(page) {
  // Wait for geometry to stop moving, rather than assuming a fixed animation delay.
  let previous;
  let stable = 0;
  await expect
    .poll(
      async () => {
        const value = await history(page).evaluate((element) =>
          JSON.stringify([
            element.scrollTop,
            element.scrollHeight,
            element.clientHeight,
            ...Array.from(element.querySelectorAll("[data-message-id]")).map(
              (row) => [row.dataset.messageId, row.getBoundingClientRect().y],
            ),
          ]),
        );
        stable = value === previous ? stable + 1 : 0;
        previous = value;
        return stable;
      },
      { intervals: [50], message: "timeline geometry settles" },
    )
    .toBeGreaterThanOrEqual(3);
}
export async function anchor(page) {
  return history(page).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const rows = Array.from(element.querySelectorAll("[data-message-id]"));
    // Prefer a whole paragraph, but tall messages can leave only clipped rows.
    // Track the first intersecting row in that case, as the reader does. The
    // same-ID/Y assertion below still detects displacement after a resize.
    const row =
      rows.find((row) => {
        const rect = row.querySelector("p").getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      }) ??
      rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
    if (!row) throw new Error("No visible message anchor");
    return {
      id: row.dataset.messageId,
      y: row.querySelector("p").getBoundingClientRect().top - bounds.top,
    };
  });
}
export async function expectAnchor(page, expected) {
  await expect
    .poll(
      async () =>
        history(page).evaluate((element, expected) => {
          const row = element.querySelector(
            `[data-message-id="${expected.id}"]`,
          );
          return row
            ? Math.abs(
                row.querySelector("p").getBoundingClientRect().top -
                  element.getBoundingClientRect().top -
                  expected.y,
              )
            : Infinity;
        }, expected),
      { message: `same visible message ${expected.id} at same viewport Y` },
    )
    .toBeLessThan(4);
}
export async function edge(page, direction) {
  const distance = () =>
    history(page).evaluate(
      (element, direction) =>
        direction < 0
          ? element.scrollTop
          : element.scrollHeight - element.scrollTop - element.clientHeight,
      direction,
    );
  await history(page).hover();
  // Send one real gesture for the actual distance, not an arbitrary 100,000px
  // overshoot. At the boundary, retain input so production can initiate paging.
  await page.mouse.wheel(0, direction * Math.max(1, await distance()));
  await expect
    .poll(distance, { message: "wheel reaches timeline edge" })
    .toBeLessThan(4);
  await settle(page);
  expect(await distance(), "timeline stays at the requested edge").toBeLessThan(
    4,
  );
}
export async function end(page) {
  await edge(page, 1);
}
export async function open(page, app) {
  await page.goto(app.origin);
  await button(page, "Messages").first().click();
  await composer(page, "Alpha").waitFor();
  await expect(history(page).locator(rowSelector).first()).toBeVisible();
  await settle(page);
}
export async function upper(page) {
  await end(page);
  const distance = () =>
    history(page).evaluate(
      (element) =>
        element.scrollHeight - element.scrollTop - element.clientHeight,
    );
  await history(page).hover();
  expect(
    await history(page).evaluate((element) => element.scrollTop),
    "history has room for an above-bottom reading position",
  ).toBeGreaterThan(400);
  // This establishes a reading position, not a wheel-delta measurement. A wheel
  // request does not guarantee exact displacement (Linux WebKit stopped short).
  // Each bounded gesture must make real progress; never assign scrollTop or
  // repeat an assertion until an immobile timeline happens to pass.
  for (let gesture = 0; gesture < 4; gesture++) {
    const before = await distance();
    if (before > 400) break;
    await page.mouse.wheel(0, -(650 - before));
    // expect.poll races its deadline; it does not cancel an in-flight callback.
    // Drain the final DOM read before a caller handles the expected rejection
    // and closes the page, otherwise its element handle can arrive after close.
    let pendingRead;
    try {
      await expect
        .poll(() => (pendingRead = distance()), {
          message: "reading gesture moves away from bottom",
        })
        .toBeGreaterThan(before);
    } finally {
      await pendingRead;
    }
    await settle(page);
  }
  expect(await distance(), "reading position is above bottom").toBeGreaterThan(
    400,
  );
  return anchor(page);
}
