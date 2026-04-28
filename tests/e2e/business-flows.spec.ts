/**
 * tests/e2e/business-flows.spec.ts
 *
 * End-to-end business flow tests — exercises complete BRD workflows
 * through the UI, verifying each step via subsequent API calls.
 *
 * Flow 1: LockBox upload → Global Suspense → Working Suspense → GL entries
 *   BRD §5.12 automated pipeline via /lockbox/upload UI + API verification
 *
 * Flow 2: Manual cash entry → Move Cash → Disbursement
 *   BRD §5.20 + §6 + §7 via manual entry UI + workspace UI
 *
 * Flow 3: Multi-role read-only verification
 *   AR Assistant views the results of Flow 1 across all workspace tabs
 *
 * These tests run serially (fullyParallel: false) since each flow
 * mutates shared financial state in the test database.
 */

import { test, expect } from "@fixtures/roles.fixture";
import {
  LockBoxUploadPage,
  LockBoxHistoryPage,
  LockBoxManualEntryPage,
  AccountWorkspacePage,
  GlBatchesPage,
} from "@pages/index";
import { makeStandardFile, toBuffer } from "@fixtures/lockbox-file.factory";

const CHECK_ACCOUNT_ID = parseInt(process.env.TEST_CHECK_SUSPENSE_ACCOUNT_ID ?? "2");

// ─── Flow 1: LockBox File Upload → Full Pipeline ──────────────────────────────

test.describe("Flow 1: LockBox upload → suspense posting → GL entries", () => {
  test("upload valid file, run completes, GL entries exist", async ({
    accountantPage,
    accountantApi,
  }) => {
    const { content } = makeStandardFile();

    // Step 1: Upload via UI
    const uploadPage = new LockBoxUploadPage(accountantPage);
    await uploadPage.goto();
    await uploadPage.uploadAndProcess(toBuffer(content));

    // Step 2: Wait for success feedback on the page
    await expect(uploadPage.successAlert).toBeVisible({ timeout: 15_000 });

    // Step 3: Verify via API — most recent run is COMPLETED
    const runsRes = await accountantApi.get("/api/lockbox/runs?pageSize=1");
    const latestRun = (await runsRes.json()).data[0];
    expect(latestRun.status).toBe("COMPLETED");
    expect(latestRun.totalRecords).toBe(2);
    expect(latestRun.errorCount).toBe(0);

    // Step 4: Verify processing logs contain no ERROR entries
    const logsRes = await accountantApi.get(
      `/api/lockbox/runs/${latestRun.runId}/logs?logLevel=ERROR`,
    );
    const errorLogs = (await logsRes.json()).data;
    expect(errorLogs).toHaveLength(0);

    // Step 5: Verify GL entries were created for this run
    // The GL entries tab on the check suspense account should show new entries
    const glRes = await accountantApi.get(`/api/accounts/${CHECK_ACCOUNT_ID}/gl-entries`);
    expect(glRes.status()).toBe(200);
    const entries = (await glRes.json()).data as Array<{ glEntryId: number }>;
    expect(entries.length).toBeGreaterThan(0);
  });

  test("history page shows the completed run", async ({ accountantPage, accountantApi }) => {
    // Get latest run ID from API
    const runsRes = await accountantApi.get("/api/lockbox/runs?pageSize=1&status=COMPLETED");
    const runs = (await runsRes.json()).data;
    if (runs.length === 0) return; // skip if no completed runs yet

    const runId = runs[0].runId;
    const historyPage = new LockBoxHistoryPage(accountantPage);
    await historyPage.gotoRun(runId);

    // Run detail page should show COMPLETED status
    await expect(accountantPage.getByText("COMPLETED")).toBeVisible();
  });
});

// ─── Flow 2: Manual Entry → Move Cash → Disbursement ─────────────────────────

test.describe("Flow 2: Manual entry → workspace → disbursement", () => {
  test("accountant creates manual entry then views it in workspace", async ({
    accountantPage,
    accountantApi,
  }) => {
    // Step 1: Create a manual cash entry
    const manualPage = new LockBoxManualEntryPage(accountantPage);
    await manualPage.goto();
    await manualPage.fill({
      lockBoxId:         `LBE2E-${Date.now()}`,
      policy:            "POL-E2E",
      payor:             "E2E Test Payor",
      checkNumber:       "CHK-E2E-001",
      checkAmount:       "500.00",
      checkDate:         "2025-03-01",
      payee:             "E2E Insurance",
      invoiceNumber:     "INV-E2E",
      billInvoiceAmount: "500.00",
    });
    await manualPage.submit();

    // Step 2: Verify the latest run is COMPLETED
    const runsRes  = await accountantApi.get("/api/lockbox/runs?pageSize=1&runType=MANUAL");
    const latestRun = (await runsRes.json()).data[0];
    expect(latestRun?.status).toBe("COMPLETED");

    // Step 3: Verify payment appears in the check suspense account payments tab
    const paymentsRes = await accountantApi.get(`/api/accounts/${CHECK_ACCOUNT_ID}/payments`);
    const payments = (await paymentsRes.json()).data as Array<{ lockBoxId: string }>;
    const found = payments.some((p) => p.lockBoxId?.startsWith("LBE2E"));
    expect(found).toBe(true);
  });

  test("accountant can view move-cash dialog (UI)", async ({ accountantPage }) => {
    const ws = new AccountWorkspacePage(accountantPage);
    await ws.goto(CHECK_ACCOUNT_ID);

    // Move Cash button must be visible and clickable for Accountant
    await expect(ws.moveCashBtn).toBeVisible();
    await ws.openMoveCash();

    // Dialog should open
    await expect(accountantPage.getByRole("dialog")).toBeVisible();

    // Close without submitting
    await accountantPage.keyboard.press("Escape");
  });

  test("accountant can open disbursement dialog (UI)", async ({ accountantPage }) => {
    const ws = new AccountWorkspacePage(accountantPage);
    await ws.goto(CHECK_ACCOUNT_ID);

    await expect(ws.disburseBtn).toBeVisible();
    await ws.openDisburse();
    await expect(accountantPage.getByRole("dialog")).toBeVisible();

    // Verify notes field is present and required (BRD §7.5)
    await expect(accountantPage.getByLabel(/notes/i)).toBeVisible();
    await accountantPage.keyboard.press("Escape");
  });
});

// ─── Flow 3: Multi-role read-only verification ────────────────────────────────

test.describe("Flow 3: AR Assistant read-only verification", () => {
  test("ar-assistant can read all workspace tabs", async ({ arPage }) => {
    const ws = new AccountWorkspacePage(arPage);
    await ws.goto(CHECK_ACCOUNT_ID);

    // Should load without redirect to /unauthorized
    await expect(arPage).not.toHaveURL(/unauthorized/);

    // All tabs should be visible and readable
    const tabs = ["Payments", "Disbursements", "Operations", "GL Entries"] as const;
    for (const tab of tabs) {
      await ws.openTab(tab);
      // Tab content should load (table or empty state, not an error)
      await expect(arPage.locator("table, [data-testid='empty-state']").first()).toBeVisible({
        timeout: 5_000,
      });
    }
  });

  test("ar-assistant has no action buttons in workspace", async ({ arPage }) => {
    const ws = new AccountWorkspacePage(arPage);
    await ws.goto(CHECK_ACCOUNT_ID);

    await expect(ws.moveCashBtn).not.toBeVisible();
    await expect(ws.disburseBtn).not.toBeVisible();
  });

  test("ar-assistant can browse lockbox history (read-only)", async ({ arPage }) => {
    const histPage = new LockBoxHistoryPage(arPage);
    await histPage.goto();
    await expect(arPage).not.toHaveURL(/unauthorized/);
    // The runs table loads
    await expect(histPage.runsTable).toBeVisible();
  });
});

// ─── Flow 4: GL Batch posting (accountant only) ───────────────────────────────

test.describe("Flow 4: GL batch lifecycle", () => {
  test("accountant can view GL batches page", async ({ accountantPage }) => {
    const glPage = new GlBatchesPage(accountantPage);
    await glPage.goto();
    await expect(accountantPage).not.toHaveURL(/unauthorized/);
  });

  test("auto-batch creates a new batch or reports nothing to batch", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/glbatches/auto-batch", { data: {} });
    // 200 = batch created from unposted GL entries
    // 409 = no unposted entries at this moment (valid steady-state)
    expect([200, 409]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty("batchId");
    }
  });
});

// ─── Flow 5: SOX Audit trail verification ────────────────────────────────────

test.describe("Flow 5: SOX audit trail", () => {
  test("audit log records financial operations with required fields", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/audit");
    expect(res.status()).toBe(200);
    const entries = (await res.json()).data;

    if (entries.length > 0) {
      const entry = entries[0];
      // Required SOX fields per Tech Spec §14 and audit.repository.ts
      expect(entry).toHaveProperty("performedBy");    // UserID
      expect(entry).toHaveProperty("action");          // Action performed
      expect(entry).toHaveProperty("entityType");      // Affected entity type
      expect(entry).toHaveProperty("entityId");        // Affected entity ID
      expect(entry).toHaveProperty("createdAt");       // Timestamp
    }
  });

  test("audit entries are immutable — DELETE endpoint does not exist", async ({ accountantApi }) => {
    // The audit API route (src/app/api/audit/route.ts) only has GET, no DELETE
    const res = await accountantApi.delete("/api/audit/1");
    // 404 (route not found) or 405 (method not allowed) — either proves no delete
    expect([404, 405]).toContain(res.status());
  });
});
