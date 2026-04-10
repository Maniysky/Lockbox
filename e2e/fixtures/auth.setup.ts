/**
 * e2e/fixtures/auth.setup.ts
 *
 * Signs in as each test role using the Credentials provider in src/auth.ts
 * (dev-only provider — active on non-prod builds, accepts email + password).
 *
 * Login page: src/app/(auth)/login/page.tsx
 * After sign-in NextAuth v5 redirects to /dashboard.
 *
 * Saved storageState files (.gitignored):
 *   e2e/.auth/accountant.json
 *   e2e/.auth/ar-assistant.json
 *   e2e/.auth/security-admin.json
 *   e2e/.auth/app-admin.json
 */

import { test as setup, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const AUTH_DIR = path.join(__dirname, "../.auth");
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const ROLES = [
  {
    name: "accountant",
    email:    process.env.TEST_ACCOUNTANT_EMAIL    ?? "accountant@test.local",
    password: process.env.TEST_ACCOUNTANT_PASSWORD ?? "test-password",
    file:     path.join(AUTH_DIR, "accountant.json"),
  },
  {
    name: "ar-assistant",
    email:    process.env.TEST_AR_ASSISTANT_EMAIL    ?? "arassistant@test.local",
    password: process.env.TEST_AR_ASSISTANT_PASSWORD ?? "test-password",
    file:     path.join(AUTH_DIR, "ar-assistant.json"),
  },
  {
    name: "security-admin",
    email:    process.env.TEST_SECURITY_ADMIN_EMAIL    ?? "securityadmin@test.local",
    password: process.env.TEST_SECURITY_ADMIN_PASSWORD ?? "test-password",
    file:     path.join(AUTH_DIR, "security-admin.json"),
  },
  {
    name: "app-admin",
    email:    process.env.TEST_APP_ADMIN_EMAIL    ?? "appadmin@test.local",
    password: process.env.TEST_APP_ADMIN_PASSWORD ?? "test-password",
    file:     path.join(AUTH_DIR, "app-admin.json"),
  },
] as const;

for (const role of ROLES) {
  setup(`authenticate: ${role.name}`, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(role.email);
    await page.getByLabel(/password/i).fill(role.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/dashboard/);
    await expect(page).toHaveURL(/dashboard/);
    await page.context().storageState({ path: role.file });
  });
}
