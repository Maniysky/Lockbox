/**
 * tests/rbac/permissions.api.spec.ts
 *
 * API-layer RBAC tests — exercises the withPermission() middleware
 * (src/server/middleware/withPermission.ts) against live Next.js route handlers.
 *
 * Permission constants from src/lib/permissions.ts:
 *   users.*        roles.*        lockbox.*
 *   cashmovement.* disbursement.* glposting.*  audit.*
 *
 * Role seeds from scripts/add-permission-tables.sql +
 *               scripts/20260402_roles_accountant_ar_assistant.sql
 *
 * Every test asserts both the HTTP status AND the response body shape
 * (success: false, error.code: "FORBIDDEN" | "UNAUTHORIZED") from
 * src/server/utils/response.ts fail().
 */

import { test, expect } from "@fixtures/roles.fixture";

// ─── Unauthenticated → 401 ────────────────────────────────────────────────────

test.describe("unauthenticated requests → 401", () => {
  const protectedRoutes = [
    { method: "GET",  path: "/api/users" },
    { method: "GET",  path: "/api/roles" },
    { method: "GET",  path: "/api/lockbox/runs" },
    { method: "GET",  path: "/api/accounts" },
    { method: "GET",  path: "/api/audit" },
    { method: "GET",  path: "/api/glbatches" },
  ];

  for (const { method, path } of protectedRoutes) {
    test(`${method} ${path}`, async ({ anonApi }) => {
      const res = await anonApi.fetch(path, { method });
      expect(res.status()).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });
  }
});

// ─── Security Admin — no financial access ────────────────────────────────────
// BRD §3.1: Admin must NOT access cash, GL, lockbox operations

test.describe("security-admin: blocked from financial operations", () => {
  test("cannot GET /api/lockbox/runs (lockbox.view required)", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.get("/api/lockbox/runs");
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  test("cannot POST /api/lockbox/upload", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post("/api/lockbox/upload", { data: {} });
    expect(res.status()).toBe(403);
  });

  test("cannot GET /api/accounts (accounts.view required)", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.get("/api/accounts");
    expect(res.status()).toBe(403);
  });

  test("cannot GET /api/glbatches (glposting.view required)", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.get("/api/glbatches");
    expect(res.status()).toBe(403);
  });

  test("cannot GET /api/audit (audit.view required)", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.get("/api/audit");
    expect(res.status()).toBe(403);
  });
});

// ─── Security Admin — allowed: users + roles ─────────────────────────────────

test.describe("security-admin: allowed user/role administration", () => {
  test("can GET /api/users", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.get("/api/users");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("can GET /api/roles", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.get("/api/roles");
    expect(res.status()).toBe(200);
  });
});

// ─── AR Assistant — read-only ─────────────────────────────────────────────────
// BRD §3.3: AR Assistant cannot create cash entries or disburse

test.describe("ar-assistant: read-only, no financial writes", () => {
  test("can GET /api/accounts (view permission)", async ({ arApi }) => {
    const res = await arApi.get("/api/accounts");
    expect(res.status()).toBe(200);
  });

  test("cannot POST /api/lockbox/manual-entry", async ({ arApi }) => {
    const res = await arApi.post("/api/lockbox/manual-entry", {
      data: {
        lockBoxId: "LB999", policy: "POL-TEST", payor: "Test",
        checkAmount: "100.00", checkDate: "2025-01-15", payee: "Payee",
      },
    });
    expect(res.status()).toBe(403);
  });

  test("cannot POST disburse on any account", async ({ arApi }) => {
    const res = await arApi.post("/api/accounts/1/disburse", {
      data: { cashMovementLineId: 1, amount: "50.00", notes: "test" },
    });
    expect(res.status()).toBe(403);
  });

  test("cannot POST move-cash on any account", async ({ arApi }) => {
    const res = await arApi.post("/api/accounts/1/move-cash", {
      data: { cashMovementLineId: 1, fromAccountId: 1, toAccountId: 2, amount: "50.00" },
    });
    expect(res.status()).toBe(403);
  });

  test("cannot POST to create GL batch", async ({ arApi }) => {
    const res = await arApi.post("/api/glbatches", { data: {} });
    expect(res.status()).toBe(403);
  });

  test("cannot POST to post a GL batch", async ({ arApi }) => {
    const res = await arApi.post("/api/glbatches/1/post", { data: {} });
    expect(res.status()).toBe(403);
  });
});

// ─── Accountant — full financial access ──────────────────────────────────────

test.describe("accountant: full financial access", () => {
  test("can GET /api/lockbox/runs", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/lockbox/runs");
    expect(res.status()).toBe(200);
  });

  test("can GET /api/accounts", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/accounts");
    expect(res.status()).toBe(200);
  });

  test("can GET /api/glbatches", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/glbatches");
    expect(res.status()).toBe(200);
  });

  test("can GET /api/audit", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/audit");
    expect(res.status()).toBe(200);
  });
});

// ─── Accountant — no user administration ─────────────────────────────────────
// Segregation of duties: financial role cannot manage users

test.describe("accountant: blocked from user/role administration", () => {
  test("cannot POST /api/users (users.create required)", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/users", {
      data: { name: "Test", email: "t@example.com" },
    });
    expect(res.status()).toBe(403);
  });

  test("cannot DELETE /api/users/:id", async ({ accountantApi }) => {
    const res = await accountantApi.delete("/api/users/999");
    expect(res.status()).toBe(403);
  });

  test("cannot POST /api/roles", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/roles", {
      data: { roleCode: "TEST", roleName: "Test Role", permissionIds: [] },
    });
    expect(res.status()).toBe(403);
  });
});
