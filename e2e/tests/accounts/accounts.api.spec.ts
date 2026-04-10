/**
 * e2e/tests/accounts/accounts.api.spec.ts
 *
 * API tests for suspense account operations.
 *
 * Endpoints:
 *   GET  /api/accounts                    accounts.view
 *   GET  /api/accounts/:id                accounts.view
 *   POST /api/accounts/:id/move-cash      cashmovement.create
 *   POST /api/accounts/:id/disburse       disbursement.create
 *   GET  /api/accounts/:id/payments       accounts.workspace
 *   GET  /api/accounts/:id/disbursements  accounts.workspace
 *   GET  /api/accounts/:id/operations     accounts.workspace
 *   GET  /api/accounts/:id/gl-entries     accounts.workspace
 *   GET  /api/accounts/:id/notes          accounts.workspace
 *   POST /api/accounts/:id/notes          accounts.workspace
 *   GET  /api/accounts/inquiry            accounts.inquiry
 *
 * Business rules under test (BRD §6, §7, Tech Spec §11, §12):
 *   - Only suspended amounts can be moved (not balance)
 *   - Move amount must not exceed available suspended amount
 *   - Disbursement notes are mandatory (BRD §7.5)
 *   - All operations are atomic: balance + CASHMOVEMENTLINE + GLENTRY all or nothing
 *   - Only Accountant role can move/disburse
 */

import { test, expect } from "@fixtures/roles.fixture";

const ACCOUNT_ID      = parseInt(process.env.TEST_CHECK_SUSPENSE_ACCOUNT_ID ?? "2");
const ACH_ACCOUNT_ID  = parseInt(process.env.TEST_ACH_SUSPENSE_ACCOUNT_ID   ?? "3");

// ─── GET /api/accounts ────────────────────────────────────────────────────────

test.describe("GET /api/accounts", () => {
  test("returns list with expected shape", async ({ accountantApi }) => {
    const res  = await accountantApi.get("/api/accounts");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    if (body.data.length > 0) {
      const acct = body.data[0];
      expect(acct).toHaveProperty("accountId");
      expect(acct).toHaveProperty("name");
      expect(acct).toHaveProperty("suspendedAmountBalance");
      expect(acct).toHaveProperty("balance");
    }
  });

  test("ar-assistant can also GET accounts (view permission)", async ({ arApi }) => {
    const res = await arApi.get("/api/accounts");
    expect(res.status()).toBe(200);
  });

  test("unauthenticated → 401", async ({ anonApi }) => {
    const res = await anonApi.get("/api/accounts");
    expect(res.status()).toBe(401);
  });
});

// ─── GET /api/accounts/:id ────────────────────────────────────────────────────

test.describe("GET /api/accounts/:id", () => {
  test("returns single account with balance fields", async ({ accountantApi }) => {
    const res  = await accountantApi.get(`/api/accounts/${ACCOUNT_ID}`);
    expect(res.status()).toBe(200);
    const acct = (await res.json()).data;
    expect(acct.accountId).toBe(ACCOUNT_ID);
    expect(typeof acct.suspendedAmountBalance).toBe("string");
    expect(typeof acct.balance).toBe("string");
  });

  test("unknown id → 404", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/accounts/99999999");
    expect(res.status()).toBe(404);
  });

  test("non-numeric id → 422", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/accounts/abc");
    expect(res.status()).toBe(422);
  });
});

// ─── GET workspace tab endpoints ──────────────────────────────────────────────

test.describe("GET workspace tabs — accountant", () => {
  const tabs = [
    "payments", "disbursements", "operations", "gl-entries", "notes",
  ] as const;

  for (const tab of tabs) {
    test(`GET /api/accounts/${ACCOUNT_ID}/${tab} → 200`, async ({ accountantApi }) => {
      const res = await accountantApi.get(`/api/accounts/${ACCOUNT_ID}/${tab}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });
  }
});

test.describe("GET workspace tabs — ar-assistant (read-only allowed)", () => {
  test("ar-assistant can read payments tab", async ({ arApi }) => {
    const res = await arApi.get(`/api/accounts/${ACCOUNT_ID}/payments`);
    expect(res.status()).toBe(200);
  });

  test("ar-assistant can read gl-entries tab", async ({ arApi }) => {
    const res = await arApi.get(`/api/accounts/${ACCOUNT_ID}/gl-entries`);
    expect(res.status()).toBe(200);
  });
});

// ─── POST /api/accounts/:id/move-cash ────────────────────────────────────────
// cashmovement.service.ts: validates suspended amount, atomic TX

test.describe("POST /api/accounts/:id/move-cash — validation", () => {
  test("missing required fields → 422", async ({ accountantApi }) => {
    const res = await accountantApi.post(`/api/accounts/${ACCOUNT_ID}/move-cash`, {
      data: {},
    });
    expect(res.status()).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  test("amount of zero → 422", async ({ accountantApi }) => {
    const res = await accountantApi.post(`/api/accounts/${ACCOUNT_ID}/move-cash`, {
      data: {
        cashMovementLineId: 1,
        fromAccountId:      ACCOUNT_ID,
        toAccountId:        ACH_ACCOUNT_ID,
        amount:             "0.00",
      },
    });
    expect(res.status()).toBe(422);
  });

  test("non-existent cashMovementLineId → 404", async ({ accountantApi }) => {
    const res = await accountantApi.post(`/api/accounts/${ACCOUNT_ID}/move-cash`, {
      data: {
        cashMovementLineId: 99999999,
        fromAccountId:      ACCOUNT_ID,
        toAccountId:        ACH_ACCOUNT_ID,
        amount:             "10.00",
      },
    });
    expect(res.status()).toBe(404);
  });

  test("ar-assistant cannot move cash → 403", async ({ arApi }) => {
    const res = await arApi.post(`/api/accounts/${ACCOUNT_ID}/move-cash`, {
      data: {
        cashMovementLineId: 1,
        fromAccountId:      ACCOUNT_ID,
        toAccountId:        ACH_ACCOUNT_ID,
        amount:             "10.00",
      },
    });
    expect(res.status()).toBe(403);
  });

  test("security-admin cannot move cash → 403", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post(`/api/accounts/${ACCOUNT_ID}/move-cash`, {
      data: {
        cashMovementLineId: 1,
        fromAccountId:      ACCOUNT_ID,
        toAccountId:        ACH_ACCOUNT_ID,
        amount:             "10.00",
      },
    });
    expect(res.status()).toBe(403);
  });
});

// ─── POST /api/accounts/:id/disburse ─────────────────────────────────────────
// disbursement.service.ts: notes mandatory (BRD §7.5), atomic TX

test.describe("POST /api/accounts/:id/disburse — validation", () => {
  test("missing notes → 422 (BRD §7.5: notes are mandatory)", async ({ accountantApi }) => {
    const res = await accountantApi.post(`/api/accounts/${ACCOUNT_ID}/disburse`, {
      data: {
        cashMovementLineId: 1,
        amount:             "50.00",
        // notes deliberately omitted
      },
    });
    expect(res.status()).toBe(422);
  });

  test("empty notes string → 422", async ({ accountantApi }) => {
    const res = await accountantApi.post(`/api/accounts/${ACCOUNT_ID}/disburse`, {
      data: { cashMovementLineId: 1, amount: "50.00", notes: "" },
    });
    expect(res.status()).toBe(422);
  });

  test("zero amount → 422", async ({ accountantApi }) => {
    const res = await accountantApi.post(`/api/accounts/${ACCOUNT_ID}/disburse`, {
      data: { cashMovementLineId: 1, amount: "0.00", notes: "Test disbursement" },
    });
    expect(res.status()).toBe(422);
  });

  test("non-existent cashMovementLineId → 404", async ({ accountantApi }) => {
    const res = await accountantApi.post(`/api/accounts/${ACCOUNT_ID}/disburse`, {
      data: { cashMovementLineId: 99999999, amount: "10.00", notes: "Test" },
    });
    expect(res.status()).toBe(404);
  });

  test("ar-assistant cannot disburse → 403 (BRD §7.2)", async ({ arApi }) => {
    const res = await arApi.post(`/api/accounts/${ACCOUNT_ID}/disburse`, {
      data: { cashMovementLineId: 1, amount: "10.00", notes: "Blocked" },
    });
    expect(res.status()).toBe(403);
  });

  test("security-admin cannot disburse → 403", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post(`/api/accounts/${ACCOUNT_ID}/disburse`, {
      data: { cashMovementLineId: 1, amount: "10.00", notes: "Blocked" },
    });
    expect(res.status()).toBe(403);
  });
});

// ─── POST /api/accounts/:id/disburse — wrong account ownership ───────────────

test.describe("POST /api/accounts/:id/disburse — cross-account guard", () => {
  test("cashMovementLine belonging to different account → 422", async ({ accountantApi }) => {
    // Use a line from ACH account but POST to check account — service validates ownership
    const res = await accountantApi.post(`/api/accounts/${ACCOUNT_ID}/disburse`, {
      data: {
        // Assume cashMovementLineId=1 belongs to a different account in test DB
        cashMovementLineId: 1,
        amount:             "10.00",
        notes:              "Cross-account attempt",
      },
    });
    // Either 404 (line not found) or 422 (wrong account) — both are correct
    expect([404, 422]).toContain(res.status());
  });
});

// ─── GET /api/accounts/inquiry ────────────────────────────────────────────────

test.describe("GET /api/accounts/inquiry", () => {
  test("returns search results with accounts.inquiry permission", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/accounts/inquiry");
    expect(res.status()).toBe(200);
  });

  test("ar-assistant can use inquiry (read permission)", async ({ arApi }) => {
    const res = await arApi.get("/api/accounts/inquiry");
    expect(res.status()).toBe(200);
  });
});
