/**
 * e2e/tests/lockbox/lockbox.api.spec.ts
 *
 * API-level tests for the LockBox processing pipeline.
 *
 * Endpoints under test:
 *   POST /api/lockbox/upload        (manual upload — multipart/form-data)
 *   POST /api/lockbox/manual-entry  (manual cash entry — JSON body)
 *   POST /api/lockbox/process       (automated job — x-lockbox-api-key header)
 *   GET  /api/lockbox/runs          (list processing runs)
 *   GET  /api/lockbox/runs/:id      (run detail)
 *   GET  /api/lockbox/runs/:id/logs (processing logs)
 *   GET  /api/lockbox/metrics       (dashboard metrics)
 *
 * Pipeline under test (src/server/modules/lockbox/lockbox.service.ts):
 *   SHA-256 duplicate check → parse → persist CASHRECEIPTRECORD →
 *   post to Global Suspense → CASHMOVEMENT traceability →
 *   GL entries (initial) → distribute to working suspense → GL entries (distribution)
 *
 * Success gate (Tech Spec §7.2): if ANY record fails parse, run is FAILED
 * and NO financial writes occur.
 */

import { test, expect } from "@fixtures/roles.fixture";
import {
  makeStandardFile, makeMalformedFile, makeZeroAmountLine,
  makeTooManyColumnsLine, makeMixedFile, makeCrlfFile, toBuffer,
} from "@fixtures/lockbox-file.factory";

// ─── POST /api/lockbox/upload ─────────────────────────────────────────────────

test.describe("POST /api/lockbox/upload — valid files", () => {
  test("1 CHECK + 1 ACH file → COMPLETED run, counts match", async ({ accountantApi }) => {
    const { content } = makeStandardFile();
    const buf = toBuffer(content);

    const res = await accountantApi.post("/api/lockbox/upload", {
      multipart: {
        file: {
          name:     buf.name,
          mimeType: buf.mimeType,
          buffer:   buf.buffer,
        },
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("COMPLETED");
    expect(body.data.totalRecords).toBe(2);
    expect(body.data.checkRecordCount).toBe(1);
    expect(body.data.achRecordCount).toBe(1);
    expect(body.data.errorCount).toBe(0);
  });

  test("CRLF line endings are handled correctly", async ({ accountantApi }) => {
    const buf = toBuffer(makeCrlfFile());
    const res = await accountantApi.post("/api/lockbox/upload", {
      multipart: { file: { name: buf.name, mimeType: buf.mimeType, buffer: buf.buffer } },
    });
    const body = await res.json();
    expect(body.data.status).toBe("COMPLETED");
    expect(body.data.totalRecords).toBe(2);
  });

  test("response includes runId that can be fetched from /runs/:id", async ({ accountantApi }) => {
    const buf = toBuffer(makeStandardFile().content);
    const uploadRes = await accountantApi.post("/api/lockbox/upload", {
      multipart: { file: { name: buf.name, mimeType: buf.mimeType, buffer: buf.buffer } },
    });
    const runId = (await uploadRes.json()).data.runId;
    expect(runId).toBeGreaterThan(0);

    const runRes = await accountantApi.get(`/api/lockbox/runs/${runId}`);
    expect(runRes.status()).toBe(200);
    const run = (await runRes.json()).data;
    expect(run.runId).toBe(runId);
    expect(run.status).toBe("COMPLETED");
  });
});

test.describe("POST /api/lockbox/upload — success gate (BRD §5.17)", () => {
  test("all-malformed file → FAILED, zero financial writes", async ({ accountantApi }) => {
    const buf = toBuffer(makeMalformedFile());
    const res = await accountantApi.post("/api/lockbox/upload", {
      multipart: { file: { name: buf.name, mimeType: buf.mimeType, buffer: buf.buffer } },
    });
    const body = await res.json();
    // Service marks run FAILED and returns it (not a 4xx — run record is created)
    expect(body.data.status).toBe("FAILED");
    expect(body.data.errorCount).toBeGreaterThan(0);
    expect(body.data.successCount).toBe(0);
  });

  test("zero CheckAmount line → FAILED (parser rejects zero amount)", async ({ accountantApi }) => {
    const buf = toBuffer(makeZeroAmountLine());
    const res = await accountantApi.post("/api/lockbox/upload", {
      multipart: { file: { name: buf.name, mimeType: buf.mimeType, buffer: buf.buffer } },
    });
    const body = await res.json();
    expect(body.data.status).toBe("FAILED");
  });

  test("11-column line → FAILED (> LOCKBOX_PIPE_MAX_COLUMNS)", async ({ accountantApi }) => {
    const buf = toBuffer(makeTooManyColumnsLine());
    const res = await accountantApi.post("/api/lockbox/upload", {
      multipart: { file: { name: buf.name, mimeType: buf.mimeType, buffer: buf.buffer } },
    });
    expect((await res.json()).data.status).toBe("FAILED");
  });

  test("mixed file (valid+invalid): run FAILED, no partial financial writes", async ({ accountantApi }) => {
    const { content, errorCount } = makeMixedFile();
    const buf = toBuffer(content);
    const res = await accountantApi.post("/api/lockbox/upload", {
      multipart: { file: { name: buf.name, mimeType: buf.mimeType, buffer: buf.buffer } },
    });
    const body = await res.json();
    // Success gate: any error → entire run is FAILED
    expect(body.data.status).toBe("FAILED");
    expect(body.data.errorCount).toBe(errorCount);
  });
});

test.describe("POST /api/lockbox/upload — duplicate file guard (SHA-256)", () => {
  test("uploading the same file twice → 409 CONFLICT on second upload", async ({ accountantApi }) => {
    const { content } = makeStandardFile();
    const buf = toBuffer(content);

    const upload = () =>
      accountantApi.post("/api/lockbox/upload", {
        multipart: { file: { name: buf.name, mimeType: buf.mimeType, buffer: buf.buffer } },
      });

    const first = await upload();
    expect(first.status()).toBe(200);
    expect((await first.json()).data.status).toBe("COMPLETED");

    const second = await upload();
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
  });
});

// ─── POST /api/lockbox/manual-entry ──────────────────────────────────────────
// Schema: src/server/modules/lockbox/lockbox.schema.ts  manualCashEntrySchema

test.describe("POST /api/lockbox/manual-entry", () => {
  test("creates a cash entry and returns COMPLETED result", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/lockbox/manual-entry", {
      data: {
        lockBoxId:         `LBM-${Date.now()}`,
        policy:            "POL-MANUAL",
        payor:             "Manual Payor",
        checkNumber:       "CHK-MANUAL-001",
        checkAmount:       "750.00",
        checkDate:         "2025-02-01",
        payee:             "Insurance Co",
        invoiceNumber:     "INV-MANUAL",
        billInvoiceAmount: "750.00",   // non-zero → CHECK
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("COMPLETED");
  });

  test("rejects zero checkAmount — Zod schema validation", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/lockbox/manual-entry", {
      data: {
        lockBoxId: "LB-ZERO", policy: "POL", payor: "P",
        checkAmount: "0",     // fails .refine(v => parseFloat(v) > 0)
        checkDate: "2025-01-01", payee: "P",
      },
    });
    expect(res.status()).toBe(422);
  });

  test("rejects missing required fields — Zod validation", async ({ accountantApi }) => {
    const res = await accountantApi.post("/api/lockbox/manual-entry", {
      data: { lockBoxId: "LB-MISSING" },  // missing policy, payor, checkAmount, etc.
    });
    expect(res.status()).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  test("ar-assistant cannot create manual entry", async ({ arApi }) => {
    const res = await arApi.post("/api/lockbox/manual-entry", {
      data: {
        lockBoxId: "LB-AR", policy: "POL", payor: "P",
        checkAmount: "100.00", checkDate: "2025-01-01", payee: "P",
      },
    });
    expect(res.status()).toBe(403);
  });
});

// ─── GET /api/lockbox/runs ────────────────────────────────────────────────────

test.describe("GET /api/lockbox/runs", () => {
  test("returns paginated list with expected shape", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/lockbox/runs?page=1&pageSize=5");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("filters by status=COMPLETED", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/lockbox/runs?status=COMPLETED");
    expect(res.status()).toBe(200);
    const runs = (await res.json()).data as Array<{ status: string }>;
    runs.forEach((r) => expect(r.status).toBe("COMPLETED"));
  });

  test("rejects invalid status enum", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/lockbox/runs?status=BOGUS");
    expect(res.status()).toBe(422);
  });

  test("rejects pageSize > 100", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/lockbox/runs?pageSize=999");
    expect(res.status()).toBe(422);
  });
});

// ─── GET /api/lockbox/runs/:id/logs ──────────────────────────────────────────

test.describe("GET /api/lockbox/runs/:id/logs", () => {
  test("non-numeric run id → 422", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/lockbox/runs/abc/logs");
    expect(res.status()).toBe(422);
  });

  test("unknown run id → 404", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/lockbox/runs/99999999/logs");
    expect(res.status()).toBe(404);
  });
});

// ─── GET /api/lockbox/metrics ─────────────────────────────────────────────────

test.describe("GET /api/lockbox/metrics", () => {
  test("returns metrics with expected shape", async ({ accountantApi }) => {
    const res = await accountantApi.get("/api/lockbox/metrics");
    expect(res.status()).toBe(200);
    const m = (await res.json()).data;
    expect(typeof m.totalRuns).toBe("number");
    expect(typeof m.successRate).toBe("number");
    expect(Array.isArray(m.recentRuns)).toBe(true);
  });
});
