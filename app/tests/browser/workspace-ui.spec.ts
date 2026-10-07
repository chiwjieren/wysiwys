import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/squads/config", (route) =>
    route.fulfill({ json: { config: null } }),
  );
});

test("first use explains the treasury flow and keeps setup actions in reach", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A clear view. A safer treasury." }),
  ).toBeVisible();
  await expect(
    page.getByText("Create your treasury", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Fund the shared vault", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Review every payment", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create treasury", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Member 2 wallet address")).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: /Member \d+ wallet address/ }),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(dialog.getByLabel("Member 3 wallet address")).toBeFocused();
  await page.screenshot({
    path: "test-results/create-treasury-redesign.png",
    animations: "disabled",
  });
});

test("all workspace pages work on mobile, with treasury switching in navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Switch treasury" }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Transactions", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const path of ["/", "/transactions", "/members", "/settings"]) {
    await page.goto(path);
    await expect(page.locator("#main-content h1")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: `test-results/redesign-${path === "/" ? "dashboard" : path.slice(1)}-mobile.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
});

test("transaction search and filters are distinct, accessible controls", async ({
  page,
}) => {
  await page.goto("/transactions");
  await page.getByRole("button", { name: "Rejected", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Rejected", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Search transactions" }).fill("7");
  await expect(
    page.getByRole("heading", { name: "No matching transactions" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Search transactions" }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "All transactions", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("desktop pages keep a consistent workspace and light mode", async ({
  page,
}) => {
  for (const [path, name] of [
    ["/", "dashboard"],
    ["/transactions", "transactions"],
    ["/members", "members"],
    ["/settings", "settings"],
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/redesign-${name}-desktop.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.goto("/");
  await page.screenshot({
    path: "test-results/redesign-dashboard-light.png",
    fullPage: true,
    animations: "disabled",
  });
});
