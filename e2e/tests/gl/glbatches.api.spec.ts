/**
 * e2e/tests/gl/glbatches.api.spec.ts
 *
 * API tests for General Ledger batch operations.
 *
 * Endpoints:
 *   GET  /api/glbatches                  glposting.view
 *   GET  /api/glbatches/:id              glposting.view
 *   GET  /api/glbatches/:id/transactions glposting.view
 *   POST /api/glbatches/:id/post         glposting.manage
 *   POST /api/glbatches/:id/resubmit     glposting.manage
 *   POST /api/glbatches/auto-batch       glposting.manage
 *
 * Also covers:
 *   GET  /api/glaccounts                 glaccounts.view
 *   GET  /api/glaccounts/:id             glaccounts.view
 *   GET  /api/glentrytypes               glentrytypes.view
 *
 * Business rules (BRD §8, Tech Spec §13):
 *   - GL entries are triggered by: cash receipt, suspense distribution,
 *     cash movement, cash disbursement
 *   - Debit/credit rules: Cash Receipt → Debit Cash / Credit Global Suspense
 *                         Move Cash   → Debit Target / Credit Source
 *                         Disburse    → Debit Clearing / Credit Suspense
 *   - Only balanced batches (sum debits == sum credits) may be posted externally
 *   - Failed batches are retained, not discarded
 *   - All financial records are immutable after creation
 */

import { test, expect } from "@fixtures/roles.fixture";

// ─── GET /api/glbatches ───────────────────────────────────────────────────────

test.describe("GET /api/glbatches", () => {
  test("accountant gets list with expected shape", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/glbatches");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    if (body.data.length > 0) {
      const batch = body.data[0];
      expect(batch).toHaveProperty("batchId");
      expect(batch).toHaveProperty("status");
      expect(batch).toHaveProperty("totalDebit");
      expect(batch).toHaveProperty("totalCredit");
    }
  });

  test("ar-assistant can view GL batches", async ({ arApi }) => {
    const res = await arApi.get("/api/glbatches");
    expect(res.status()).toBe(200);
  });

  test("security-admin blocked → 403", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.get("/api/glbatches");
    expect(res.status()).toBe(403);
  });

  test("unauthenticated → 401", async ({ anonApi }) => {
    expect((await anonApi.get("/api/glbatches")).status()).toBe(401);
  });
});

// ─── GET /api/glbatches/:id ───────────────────────────────────────────────────

test.describe("GET /api/glbatches/:id", () => {
  test("non-numeric id → 422", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/glbatches/abc");
    expect(res.status()).toBe(422);
  });

  test("unknown batch → 404", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/glbatches/99999999");
    expect(res.status()).toBe(404);
  });
});

// ─── GET /api/glbatches/:id/transactions ─────────────────────────────────────

test.describe("GET /api/glbatches/:id/transactions", () => {
  test("non-numeric id → 422", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/glbatches/abc/transactions");
    expect(res.status()).toBe(422);
  });
});

// ─── POST /api/glbatches/:id/post ─────────────────────────────────────────────
// Only balanced batches may be posted (sum debits == sum credits)

test.describe("POST /api/glbatches/:id/post — access control", () => {
  test("ar-assistant cannot post a batch → 403", async ({ arApi }) => {
    const res = await arApi.post("/api/glbatches/1/post", { data: {} });
    expect(res.status()).toBe(403);
  });

  test("security-admin cannot post a batch → 403", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post("/api/glbatches/1/post", { data: {} });
    expect(res.status()).toBe(403);
  });

  test("unknown batch id → 404", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/glbatches/99999999/post", { data: {} });
    expect(res.status()).toBe(404);
  });

  test("non-numeric batch id → 422", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/glbatches/abc/post", { data: {} });
    expect(res.status()).toBe(422);
  });
});

// ─── POST /api/glbatches/:id/resubmit ────────────────────────────────────────

test.describe("POST /api/glbatches/:id/resubmit — access control", () => {
  test("ar-assistant cannot resubmit → 403", async ({ arApi }) => {
    const res = await arApi.post("/api/glbatches/1/resubmit", { data: {} });
    expect(res.status()).toBe(403);
  });

  test("unknown batch → 404", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/glbatches/99999999/resubmit", { data: {} });
    expect(res.status()).toBe(404);
  });
});

// ─── POST /api/glbatches/auto-batch ──────────────────────────────────────────

test.describe("POST /api/glbatches/auto-batch", () => {
  test("ar-assistant blocked → 403", async ({ arApi }) => {
    const res = await arApi.post("/api/glbatches/auto-batch", { data: {} });
    expect(res.status()).toBe(403);
  });

  test("accountant can trigger auto-batch (returns 200 or 409 if nothing to batch)", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/glbatches/auto-batch", { data: {} });
    // 200 = batch created; 409 = no unposted entries (both valid)
    expect([200, 409]).toContain(res.status());
  });
});

// ─── GL Accounts CRUD ─────────────────────────────────────────────────────────

test.describe("GET /api/glaccounts", () => {
  test("returns list with accountant", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/glaccounts");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("security-admin blocked → 403", async ({ securityAdminApi }) => {
    expect((await securityAdminApi.get("/api/glaccounts")).status()).toBe(403);
  });
});

test.describe("POST /api/glaccounts — validation", () => {
  test("missing required fields → 422", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/glaccounts", { data: {} });
    expect(res.status()).toBe(422);
  });

  test("duplicate account code → 409", async ({ accountantApi }) => {
    // First, get an existing GL account code
    const listRes = await accountantApi.get("/api/glaccounts");
    const existing = (await listRes.json()).data[0];
    if (!existing) return; // skip if no accounts seeded

    const res = await accountantApi.post("/api/glaccounts", {
      data: {
        accountCode: existing.accountCode,
        accountName: "Duplicate Test",
      },
    });
    expect(res.status()).toBe(409);
  });
});

// ─── GL Entry Types ───────────────────────────────────────────────────────────

test.describe("GET /api/glentrytypes", () => {
  test("returns list with accountant", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/glentrytypes");
    expect(res.status()).toBe(200);
    expect(Array.isArray((await res.json()).data)).toBe(true);
  });

  test("security-admin blocked → 403", async ({ securityAdminApi }) => {
    expect((await securityAdminApi.get("/api/glentrytypes")).status()).toBe(403);
  });
});

// ─── Audit log ────────────────────────────────────────────────────────────────

test.describe("GET /api/audit", () => {
  test("returns log entries with expected shape", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/audit");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    // Verify audit log entries have required SOX fields
    if (body.data.length > 0) {
      const entry = body.data[0];
      expect(entry).toHaveProperty("performedBy");   // UserID
      expect(entry).toHaveProperty("action");         // Action performed
      expect(entry).toHaveProperty("createdAt");      // Timestamp
    }
  });

  test("ar-assistant can view audit log", async ({ arApi }) => {
    expect((await arApi.get("/api/audit")).status()).toBe(200);
  });

  test("security-admin blocked → 403 (no financial data access)", async ({ securityAdminApi }) => {
    expect((await securityAdminApi.get("/api/audit")).status()).toBe(403);
  });
});
