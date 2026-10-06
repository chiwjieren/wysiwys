import { expect, test } from "@playwright/test";

test("dashboard follows Figma and navigation reaches the required pages", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$2,025,400.00", { exact: true })).toBeVisible();
  await expect(page.locator("[data-shell-sidebar]")).toHaveCSS(
    "width",
    "240px",
  );
  for (const label of ["Transactions", "Members", "Settings"]) {
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await expect(
      page.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
  }
});
test("proposing shows decoding before approval and tracks execution separately from trade settlement", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "+ Initiate settlement", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Read only · from approved trade"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Propose payout" }).click();
  await expect(
    page.getByText("Decoding transaction…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review in progress" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Settlement verified", { exact: true }),
  ).toBeVisible({ timeout: 12000 });
  await page
    .getByRole("button", { name: "Approve payout", exact: true })
    .click();
  await expect(
    page.getByText("3 of 3 approved", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Execute payout", exact: true })
    .click();
  await expect(
    page.getByText("Trade update pending", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Trade SETTLED", { exact: true })).toBeVisible({
    timeout: 10000,
  });
});
test("missing payment and destination mismatch keep execution blocked", async ({
  page,
}) => {
  for (const [id, reason] of [
    ["103", "client payment not received"],
    ["101", "destination mismatch"],
  ]) {
    await page.goto("/transactions/" + id);
    await expect(
      page.getByText("Reason: " + reason, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Execute unavailable" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Approve payout" }),
    ).toHaveCount(0);
  }
});
test("unavailable verification does not pretend a verdict was recorded", async ({
  page,
}) => {
  await page.goto("/transactions/unavailable");
  await expect(
    page.getByText("On-chain verdict: not recorded", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View infrastructure status" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Helius");
  await expect(page.getByRole("dialog")).toContainText("Alchemy");
  await expect(page.getByRole("dialog")).toContainText("QuickNode");
});
test("search, invalid IDs, and mobile navigation are usable", async ({
  page,
}) => {
  await page.goto("/transactions");
  await page
    .getByPlaceholder("Search trade ID, counterparty, or payout")
    .fill("Delta");
  await expect(page.getByText("OTC-10427", { exact: true })).toBeVisible();
  await expect(page.getByText("OTC-10428", { exact: true })).toHaveCount(0);
  await page.goto("/transactions/not-found");
  await expect(
    page.getByRole("heading", { name: "Payout not found" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Members", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
