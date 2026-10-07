import { test, expect } from "@playwright/test";

test("treasury members use individual wallet fields with add and remove controls", async ({
  page,
}) => {
  await page.route("**/api/squads/config", (route) =>
    route.fulfill({ json: { config: null } }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create treasury", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("textbox", { name: /Wallet address \d+/ }),
  ).toHaveCount(1);
  await dialog
    .getByLabel("Wallet address 1", { exact: true })
    .fill("wallet-one");
  await expect(
    dialog.getByText("2 of 2 members", { exact: false }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Add wallet", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: /Wallet address \d+/ }),
  ).toHaveCount(2);
  await dialog
    .getByLabel("Wallet address 2", { exact: true })
    .fill("wallet-two");
  await expect(dialog.getByLabel("Required approvals")).toHaveValue("3");
  await dialog
    .getByRole("button", { name: "Remove wallet 1", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Wallet address 1", { exact: true }),
  ).toHaveValue("wallet-two");
  await expect(dialog.getByLabel("Required approvals")).toHaveValue("2");
  for (let i = 1; i < 12; i++)
    await dialog
      .getByRole("button", { name: "Add wallet", exact: true })
      .click();
  await expect(
    dialog.getByRole("textbox", { name: /Wallet address \d+/ }),
  ).toHaveCount(12);
  await expect(
    dialog.getByRole("button", { name: "Add wallet", exact: true }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
test("Wallet picker offers installed Solana wallets and installation links without requiring deployment data", async ({
  page,
}) => {
  await page.route("**/api/squads/config", (route) =>
    route.fulfill({ json: { config: null } }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Phantom", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/wallet-picker-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/wallet-picker-mobile.png" });
});

test("new users can create or open a group without setup notices or fabricated data", async ({
  page,
}) => {
  await page.route("**/api/squads/config", (route) =>
    route.fulfill({ json: { config: null } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Holdings" })).toBeVisible();
  await expect(page.getByText("$2,025,400.00", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Sample data", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("No deployment is configured.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create treasury", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create treasury", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("Treasury name"),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByLabel("Wallet address 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByLabel("Required approvals"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  for (const label of ["Transactions", "Members", "Settings"]) {
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await expect(
      page.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "Treasury information" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your preferences" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Payment protection" }),
  ).toBeVisible();
});

test("mobile navigation remains accessible with no deployment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/squads/config", (route) =>
    route.fulfill({ json: { config: null } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Members" }).click();
  await expect(
    page.getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("server rejects anonymous submissions and settlement preparation", async ({
  request,
}) => {
  const headers = { origin: "http://127.0.0.1:3105" };
  const submit = await request.post("/api/squads/rpc", {
    headers,
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: ["AA=="],
    },
  });
  expect(submit.status()).toBe(401);
  expect((await submit.json()).error).toMatch(/signed transaction/i);
  const prepare = await request.post("/api/squads/prepare", {
    headers,
    data: { action: "execute" },
  });
  expect(prepare.status()).toBe(401);
});

// Layout fixtures are isolated to browser tests. Product pages never use fabricated treasury data.
test("Figma pages retain their content and geometry with no treasury", async ({
  page,
}) => {
  await page.route("**/api/squads/config", (route) =>
    route.fulfill({ json: { config: null } }),
  );
  for (const [path, title, section] of [
    ["/", "Dashboard", "Holdings"],
    ["/transactions", "Transactions", "Treasury transactions"],
    ["/members", "Members", "Human signers"],
    ["/settings", "Settings", "Treasury information"],
  ]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: section, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Create your first group" }),
    ).toHaveCount(0);
    const geometry = await page.locator("#main-content").boundingBox();
    expect(geometry?.x).toBe(240);
    const heading = await page
      .getByRole("heading", { name: title, exact: true })
      .boundingBox();
    expect(heading?.x).toBe(280);
    const sidebar = await page.locator("[data-shell-sidebar]").boundingBox();
    expect(sidebar?.width).toBe(240);
    for (const img of await page.locator('img[src^="/figma/"]').all()) {
      await expect(img).toBeVisible();
      expect(
        await img.evaluate(
          (node: HTMLImageElement) =>
            node.complete && node.naturalWidth > 0 && node.naturalHeight > 0,
        ),
      ).toBeTruthy();
    }
    await page.screenshot({
      path: `test-results/${title.toLowerCase()}-desktop.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/transactions", "/members", "/settings"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#main-content h1")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  }
  await page.screenshot({
    path: "test-results/settings-mobile.png",
    fullPage: true,
  });
});
