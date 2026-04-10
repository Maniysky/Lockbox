/**
 * e2e/fixtures/roles.fixture.ts
 *
 * Exports a `test` object extended with per-role Page fixtures.
 * Each fixture creates a fresh browser context with the saved storageState
 * so the session cookie is already present before any navigation.
 *
 * Usage:
 *   import { test, expect } from "@fixtures/roles.fixture";
 *
 *   test("accountant can view disbursements", async ({ accountantPage }) => { ... });
 *   test("ar-assistant is read-only",          async ({ arPage })          => { ... });
 *   test("unauthenticated gets 401",           async ({ anonPage })        => { ... });
 */

import { test as base, type Page, type APIRequestContext } from "@playwright/test";
import * as path from "path";

export const AUTH_DIR  = path.join(__dirname, "../.auth");
export const AUTH_FILES = {
  accountant:    path.join(AUTH_DIR, "accountant.json"),
  arAssistant:   path.join(AUTH_DIR, "ar-assistant.json"),
  securityAdmin: path.join(AUTH_DIR, "security-admin.json"),
  appAdmin:      path.join(AUTH_DIR, "app-admin.json"),
} as const;

interface RoleFixtures {
  accountantPage:    Page;
  arPage:            Page;
  securityAdminPage: Page;
  appAdminPage:      Page;
  anonPage:          Page;
  // API request contexts (no browser — for *.api.spec.ts)
  accountantApi:     APIRequestContext;
  arApi:             APIRequestContext;
  securityAdminApi:  APIRequestContext;
  appAdminApi:       APIRequestContext;
  anonApi:           APIRequestContext;
}

export const test = base.extend<RoleFixtures>({
  accountantPage: async ({ browser }, use) => {
    const ctx  = await browser.newContext({ storageState: AUTH_FILES.accountant });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },

  arPage: async ({ browser }, use) => {
    const ctx  = await browser.newContext({ storageState: AUTH_FILES.arAssistant });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },

  securityAdminPage: async ({ browser }, use) => {
    const ctx  = await browser.newContext({ storageState: AUTH_FILES.securityAdmin });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },

  appAdminPage: async ({ browser }, use) => {
    const ctx  = await browser.newContext({ storageState: AUTH_FILES.appAdmin });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },

  anonPage: async ({ browser }, use) => {
    const ctx  = await browser.newContext(); // no storageState
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },

  // ── API request contexts ──────────────────────────────────────────────────
  accountantApi: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      storageState: AUTH_FILES.accountant,
      extraHTTPHeaders: { "Content-Type": "application/json" },
    });
    await use(ctx);
    await ctx.dispose();
  },

  arApi: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      storageState: AUTH_FILES.arAssistant,
      extraHTTPHeaders: { "Content-Type": "application/json" },
    });
    await use(ctx);
    await ctx.dispose();
  },

  securityAdminApi: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      storageState: AUTH_FILES.securityAdmin,
      extraHTTPHeaders: { "Content-Type": "application/json" },
    });
    await use(ctx);
    await ctx.dispose();
  },

  appAdminApi: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      storageState: AUTH_FILES.appAdmin,
      extraHTTPHeaders: { "Content-Type": "application/json" },
    });
    await use(ctx);
    await ctx.dispose();
  },

  anonApi: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { "Content-Type": "application/json" },
    });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect } from "@playwright/test";
