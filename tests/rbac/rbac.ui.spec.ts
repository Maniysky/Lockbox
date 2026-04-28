/**
 * tests/rbac/rbac.ui.spec.ts
 *
 * UI-layer RBAC tests — verifies that PermissionGate and PermissionButton
 * (src/components/PermissionGate.tsx, src/components/PermissionButton/index.tsx)
 * correctly show/hide action controls per role.
 *
 * Also verifies the /unauthorized redirect for direct URL access without permission.
 */

import { test, expect } from "@fixtures/roles.fixture";
import {
  AccountWorkspacePage,
  UsersPage,
  LockBoxUploadPage,
} from "@pages/index";

const TEST_ACCOUNT_ID = parseInt(process.env.TEST_GLOBAL_SUSPENSE_ACCOUNT_ID ?? "1");

// ─── Account Workspace — role-based button visibility ────────────────────────

test.describe("AccountWorkspace: action button visibility", () => {
  test("accountant sees Move Cash and Disburse buttons", async ({ accountantPage }) => {
    const ws = new AccountWorkspacePage(accountantPage);
    await ws.goto(TEST_ACCOUNT_ID);
    await expect(ws.moveCashBtn).toBeVisible();
    await expect(ws.disburseBtn).toBeVisible();
  });

  test("ar-assistant does NOT see Move Cash or Disburse buttons", async ({ arPage }) => {
    const ws = new AccountWorkspacePage(arPage);
    await ws.goto(TEST_ACCOUNT_ID);
    await expect(ws.moveCashBtn).not.toBeVisible();
    await expect(ws.disburseBtn).not.toBeVisible();
  });

  test("security-admin cannot access /accounts/workspace (redirects to /unauthorized)", async ({ securityAdminPage }) => {
    await securityAdminPage.goto(`/accounts/workspace/${TEST_ACCOUNT_ID}`);
    await expect(securityAdminPage).toHaveURL(/unauthorized/);
  });
});

// ─── LockBox Upload — only visible to users with lockbox.upload ───────────────

test.describe("LockBox upload: visibility", () => {
  test("accountant can access /lockbox/upload", async ({ accountantPage }) => {
    const pg = new LockBoxUploadPage(accountantPage);
    await pg.goto();
    await expect(accountantPage).not.toHaveURL(/unauthorized/);
    await expect(pg.fileInput).toBeVisible();
  });

  test("ar-assistant cannot access /lockbox/upload", async ({ arPage }) => {
    const pg = new LockBoxUploadPage(arPage);
    await pg.goto();
    await expect(arPage).toHaveURL(/unauthorized/);
  });
});

// ─── Users page — only Security Admin ────────────────────────────────────────

test.describe("Users page: admin-only access", () => {
  test("security-admin can access /users", async ({ securityAdminPage }) => {
    const pg = new UsersPage(securityAdminPage);
    await pg.goto();
    await expect(securityAdminPage).not.toHaveURL(/unauthorized/);
    await expect(pg.usersTable).toBeVisible();
  });

  test("accountant cannot access /users", async ({ accountantPage }) => {
    const pg = new UsersPage(accountantPage);
    await pg.goto();
    await expect(accountantPage).toHaveURL(/unauthorized/);
  });

  test("ar-assistant cannot access /users", async ({ arPage }) => {
    const pg = new UsersPage(arPage);
    await pg.goto();
    await expect(arPage).toHaveURL(/unauthorized/);
  });
});

// ─── Unauthenticated → redirect to /login ────────────────────────────────────

test.describe("unauthenticated: redirected to login", () => {
  const protectedPaths = [
    "/dashboard",
    "/lockbox",
    "/accounts/workspace/1",
    "/audit",
    "/glbatches",
    "/users",
    "/roles",
  ];

  for (const path of protectedPaths) {
    test(`${path} redirects to /login`, async ({ anonPage }) => {
      await anonPage.goto(path);
      await expect(anonPage).toHaveURL(/login/);
    });
  }
});
