/**
 * tests/login/dashboard-login.ui.spec.ts
 *
 * Verifies that a user lands on dashboard after signing in from /login.
 * Uses the "Dev only" mock sign-in path shown on the login page.
 */

import { test, expect } from "@playwright/test";

test("dashboard is displayed upon login", async ({ page }) => {
  const loginEmail =
    process.env.PLAYWRIGHT_LOGIN_EMAIL ??
    process.env.TEST_ACCOUNTANT_EMAIL ??
    "mnagarajan@skywardinsurance.com";

  await page.goto("/login");

  await page.getByPlaceholder(/enter any email to mock sign-in/i).fill(loginEmail);
  await page.getByRole("button", { name: /sign in as/i }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: /lockbox dashboard/i })).toBeVisible();
});
