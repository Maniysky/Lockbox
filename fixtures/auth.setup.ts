/**
 * fixtures/auth.setup.ts
 *
 * Signs in as each test role and saves storageState under .auth/
 *
 * Modes (PLAYWRIGHT_AUTH_MODE):
 *   credentials — NextAuth Credentials provider: email + password on /login
 *   sso         — Microsoft Entra ID: SSO button on /login, then Microsoft pages
 *
 * After sign-in the app should land on /dashboard (configurable via
 * PLAYWRIGHT_POST_LOGIN_PATH for unusual deployments).
 *
 * Saved storageState files (.gitignored):
 *   .auth/accountant.json
 *   .auth/ar-assistant.json
 *   .auth/security-admin.json
 *   .auth/app-admin.json
 */

import { test as setup, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { getPlaywrightAuthMode } from "./auth-mode";
import { signInWithSso } from "./sso-microsoft";

const AUTH_DIR = path.join(__dirname, "../.auth");
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const postLoginPath = process.env.PLAYWRIGHT_POST_LOGIN_PATH ?? "/dashboard";
const successUrl = new RegExp(
  postLoginPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
);

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

const authMode = getPlaywrightAuthMode();

for (const role of ROLES) {
  setup(`authenticate: ${role.name}`, async ({ page }) => {
    await page.goto("/login");

    if (authMode === "sso") {
      await signInWithSso(page, role.email, role.password, successUrl);
    } else {
      await page.getByLabel(/email/i).fill(role.email);
      await page.getByLabel(/password/i).fill(role.password);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL(successUrl);
    }

    await expect(page).toHaveURL(successUrl);
    await page.context().storageState({ path: role.file });
  });
}
