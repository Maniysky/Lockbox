/**
 * e2e/fixtures/lockbox-file.factory.ts
 *
 * Generates pipe-delimited LockBox test files matching the exact BRD §5.12.2
 * column spec enforced by src/lib/lockboxPipeColumns.ts:
 *
 *   LockBoxID | Policy | Payor | CheckNumber | CheckAmount | CheckDate |
 *   Payee | InvoiceNumber | BillInvoiceAmount [| Notes]
 *
 *   LOCKBOX_PIPE_CORE_COLUMNS = 9  (required)
 *   LOCKBOX_PIPE_MAX_COLUMNS  = 10 (optional Notes column)
 *
 * Classification from src/server/modules/lockbox/lockbox.parser.ts §5.13:
 *   BillInvoiceAmount != 0  → CHECK
 *   BillInvoiceAmount == "" or "0" → ACH
 *
 * Important: processLockBoxFile() does a SHA-256 duplicate-file check.
 * Every factory call uses random IDs so each file produces a unique hash.
 */

import { randomBytes } from "crypto";

export interface LockBoxLineInput {
  lockBoxId?:         string;
  policy?:            string;
  payor?:             string;
  checkNumber?:       string;
  checkAmount?:       string;
  checkDate?:         string;
  payee?:             string;
  invoiceNumber?:     string;
  billInvoiceAmount?: string;
  notes?:             string;
}

// ─── Single line builders ─────────────────────────────────────────────────────

/** One valid CHECK line (BillInvoiceAmount != 0). */
export function makeCheckLine(o: LockBoxLineInput = {}): string {
  const core = [
    o.lockBoxId         ?? `LB${uid()}`,
    o.policy            ?? `POL-${uid()}`,
    o.payor             ?? "ACME Corp",
    o.checkNumber       ?? `CHK-${uid()}`,
    o.checkAmount       ?? "1234.56",
    o.checkDate         ?? "2025-01-15",
    o.payee             ?? "Insurance Co",
    o.invoiceNumber     ?? `INV-${uid()}`,
    o.billInvoiceAmount ?? "500.00",         // non-zero → CHECK
  ].join("|");
  return o.notes !== undefined ? `${core}|${o.notes}` : core;
}

/** One valid ACH line (BillInvoiceAmount = "" → empty → ACH). */
export function makeAchLine(o: LockBoxLineInput = {}): string {
  return makeCheckLine({
    checkNumber:       o.checkNumber       ?? `ACH-${uid()}`,
    billInvoiceAmount: o.billInvoiceAmount ?? "",   // empty → ACH
    ...o,
  });
}

// ─── File builders ────────────────────────────────────────────────────────────

/** Standard 2-record file: 1 CHECK + 1 ACH. Returns content + IDs for assertions. */
export function makeStandardFile(): {
  content: string;
  checkLockBoxId: string;
  achLockBoxId:   string;
} {
  const checkLockBoxId = `LB${uid()}`;
  const achLockBoxId   = `LB${uid()}`;
  return {
    content: [
      makeCheckLine({ lockBoxId: checkLockBoxId }),
      makeAchLine({   lockBoxId: achLockBoxId }),
    ].join("\n"),
    checkLockBoxId,
    achLockBoxId,
  };
}

/** N-record CHECK-only file (for distribution / round-robin tests). */
export function makeMultiCheckFile(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    makeCheckLine({
      lockBoxId:    `LB${String(i + 1).padStart(4, "0")}${uid()}`,
      checkNumber:  `CHK-${i + 1}`,
      checkAmount:  "100.00",
    }),
  ).join("\n");
}

/** File with only malformed lines — parser must fail all (success gate test). */
export function makeMalformedFile(): string {
  return ["ONLY_ONE_COL", "A|B|C"].join("\n");
}

/** File with a zero CheckAmount — parser must reject (§5.12 constraint). */
export function makeZeroAmountLine(): string {
  return makeCheckLine({ checkAmount: "0.00", lockBoxId: `LB-ZERO-${uid()}` });
}

/** File with 11 pipe columns — exceeds LOCKBOX_PIPE_MAX_COLUMNS=10, must reject. */
export function makeTooManyColumnsLine(): string {
  return makeCheckLine() + "|extra-note|overflow";
}

/** Mixed file: 1 valid CHECK, 1 bad line, 1 valid ACH — for partial-parse log checks. */
export function makeMixedFile(): {
  content: string;
  validCount: number;
  errorCount: number;
} {
  return {
    content: [
      makeCheckLine(),
      "INVALID_ONLY_ONE_COLUMN",
      makeAchLine(),
    ].join("\n"),
    validCount: 2,
    errorCount: 1,
  };
}

/** CRLF line endings — parser must handle (cross-platform bank exports). */
export function makeCrlfFile(): string {
  return [makeCheckLine(), makeAchLine()].join("\r\n");
}

// ─── Playwright file upload helper ───────────────────────────────────────────

/**
 * Wraps a content string into the shape Playwright's setInputFiles() expects.
 * Used with:  await page.locator('input[type="file"]').setInputFiles(toBuffer(content))
 */
export function toBuffer(content: string, name?: string): {
  name:     string;
  mimeType: string;
  buffer:   Buffer;
} {
  return {
    name:     name ?? `lockbox-test-${uid()}.txt`,
    mimeType: "text/plain",
    buffer:   Buffer.from(content, "utf-8"),
  };
}

// ─── Internal ────────────────────────────────────────────────────────────────

function uid(): string {
  return randomBytes(2).toString("hex").toUpperCase();
}
