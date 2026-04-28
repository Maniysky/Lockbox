/**
 * pages/index.ts
 *
 * Page Object Models for BOA LockBox Processing & Cash Application.
 *
 * Route map from actual src/app/ directory:
 *   /login                       src/app/(auth)/login/page.tsx
 *   /dashboard                   src/app/(dashboard)/dashboard/page.tsx
 *   /lockbox                     src/app/(dashboard)/lockbox/page.tsx
 *   /lockbox/upload              src/app/(dashboard)/lockbox/upload/page.tsx
 *   /lockbox/manual-entry        src/app/(dashboard)/lockbox/manual-entry/page.tsx
 *   /lockbox/history             src/app/(dashboard)/lockbox/history/page.tsx
 *   /lockbox/history/:id         src/app/(dashboard)/lockbox/history/[id]/page.tsx
 *   /accounts/workspace/:id      src/app/(dashboard)/accounts/workspace/[id]/page.tsx
 *   /accounts/inquiry            src/app/(dashboard)/accounts/inquiry/page.tsx
 *   /glbatches                   src/app/(dashboard)/glbatches/page.tsx
 *   /glbatches/:id               src/app/(dashboard)/glbatches/[id]/page.tsx
 *   /audit                       src/app/(dashboard)/audit/page.tsx
 *   /users                       src/app/users/page.tsx
 *   /roles                       src/app/roles/page.tsx
 *
 * Components used (for locator reasoning):
 *   src/components/lockbox/LockBoxUploadForm.tsx
 *   src/components/lockbox/ManualCashEntryForm.tsx
 *   src/components/lockbox/ProcessingRunsTable.tsx
 *   src/components/lockbox/RunDetailClient.tsx
 *   src/components/accounts/workspace/AccountWorkspaceClient.tsx
 *   src/components/accounts/workspace/MoveCashDialog.tsx
 *   src/components/accounts/workspace/DisburseCashDialog.tsx
 *   src/components/users/UserForm.tsx / UsersTable.tsx
 *   src/components/roles/RoleForm.tsx / RolesTable.tsx
 */

import type { Page, Locator } from "@playwright/test";

// ─── LockBox Upload ───────────────────────────────────────────────────────────

export class LockBoxUploadPage {
  constructor(readonly page: Page) {}

  async goto() { await this.page.goto("/lockbox/upload"); }

  get fileInput()  { return this.page.locator('input[type="file"]'); }
  get submitBtn()  { return this.page.getByRole("button", { name: /process|submit|upload/i }); }
  get successAlert() { return this.page.locator(".ant-alert-success, [data-testid='upload-success']"); }
  get errorAlert()   { return this.page.locator(".ant-alert-error, [data-testid='upload-error']"); }

  async uploadAndProcess(buf: { name: string; mimeType: string; buffer: Buffer }) {
    await this.fileInput.setInputFiles(buf);
    await this.submitBtn.click();
  }
}

// ─── LockBox Manual Entry ─────────────────────────────────────────────────────
// Schema: src/server/modules/lockbox/lockbox.schema.ts  manualCashEntrySchema

export class LockBoxManualEntryPage {
  constructor(readonly page: Page) {}

  async goto() { await this.page.goto("/lockbox/manual-entry"); }

  async fill(data: {
    lockBoxId: string; policy: string; payor: string;
    checkAmount: string; checkDate: string; payee: string;
    checkNumber?: string; invoiceNumber?: string; billInvoiceAmount?: string;
  }) {
    await this.page.getByLabel(/lockbox id/i).fill(data.lockBoxId);
    await this.page.getByLabel(/policy/i).fill(data.policy);
    await this.page.getByLabel(/payor/i).fill(data.payor);
    if (data.checkNumber)      await this.page.getByLabel(/check number/i).fill(data.checkNumber);
    await this.page.getByLabel(/check amount/i).fill(data.checkAmount);
    await this.page.getByLabel(/check date/i).fill(data.checkDate);
    await this.page.getByLabel(/payee/i).fill(data.payee);
    if (data.invoiceNumber)     await this.page.getByLabel(/invoice number/i).fill(data.invoiceNumber);
    if (data.billInvoiceAmount) await this.page.getByLabel(/bill invoice amount/i).fill(data.billInvoiceAmount);
  }

  async submit() {
    await this.page.getByRole("button", { name: /submit|save|create/i }).click();
  }
}

// ─── LockBox History / Run Detail ─────────────────────────────────────────────

export class LockBoxHistoryPage {
  constructor(readonly page: Page) {}

  async goto()               { await this.page.goto("/lockbox/history"); }
  async gotoRun(id: number)  { await this.page.goto(`/lockbox/history/${id}`); }

  get runsTable() { return this.page.locator("table").first(); }
  get firstRow()  { return this.runsTable.locator("tbody tr").first(); }
}

// ─── Account Workspace ────────────────────────────────────────────────────────
// Component: src/components/accounts/workspace/AccountWorkspaceClient.tsx
// Tabs: Payments | Disbursements | Operations | GL Entries

export class AccountWorkspacePage {
  constructor(readonly page: Page) {}

  async goto(accountId: number) {
    await this.page.goto(`/accounts/workspace/${accountId}`);
  }

  // Tab navigation
  async openTab(name: "Payments" | "Disbursements" | "Operations" | "GL Entries") {
    await this.page.getByRole("tab", { name }).click();
  }

  // Header summary fields
  get suspenseAmount() { return this.page.locator("[data-testid='suspense-amount'], text=/suspense/i").first(); }
  get balanceAmount()  { return this.page.locator("[data-testid='balance-amount'], text=/balance/i").first(); }

  // Action buttons (visible only for Accountant role)
  get moveCashBtn()  { return this.page.getByRole("button", { name: /move cash/i }); }
  get disburseBtn()  { return this.page.getByRole("button", { name: /disburse/i }); }

  // MoveCashDialog.tsx
  async openMoveCash() { await this.moveCashBtn.click(); }

  async fillMoveCashDialog(amount: string) {
    await this.page.getByLabel(/amount/i).fill(amount);
  }

  async confirmMoveCash() {
    await this.page.getByRole("button", { name: /confirm|move|ok/i }).click();
  }

  // DisburseCashDialog.tsx — notes are mandatory (BRD §7)
  async openDisburse() { await this.disburseBtn.click(); }

  async fillDisbursementDialog(amount: string, notes: string) {
    await this.page.getByLabel(/amount/i).fill(amount);
    await this.page.getByLabel(/notes/i).fill(notes);
  }

  async confirmDisbursement() {
    await this.page.getByRole("button", { name: /confirm|disburse|ok/i }).click();
  }
}

// ─── GL Batches ───────────────────────────────────────────────────────────────

export class GlBatchesPage {
  constructor(readonly page: Page) {}

  async goto()              { await this.page.goto("/glbatches"); }
  async gotoBatch(id: number) { await this.page.goto(`/glbatches/${id}`); }

  get postBtn() { return this.page.getByRole("button", { name: /post/i }); }
}

// ─── Users Page (Security Admin) ─────────────────────────────────────────────
// Component: src/components/users/UsersTable.tsx + UserForm.tsx

export class UsersPage {
  constructor(readonly page: Page) {}

  async goto()                { await this.page.goto("/users"); }
  async gotoNew()             { await this.page.goto("/users/new"); }
  async gotoEdit(id: string)  { await this.page.goto(`/users/${id}/edit`); }

  async fillUserForm(data: { name: string; email: string; role?: string }) {
    await this.page.getByLabel(/name/i).fill(data.name);
    await this.page.getByLabel(/email/i).fill(data.email);
    if (data.role) {
      // Ant Design Select
      await this.page.getByLabel(/role/i).click();
      await this.page.getByText(data.role, { exact: true }).click();
    }
  }

  async submitForm() {
    await this.page.getByRole("button", { name: /save|create|submit/i }).click();
  }

  get usersTable() { return this.page.locator("table").first(); }
}

// ─── Roles Page (App Admin) ───────────────────────────────────────────────────
// Component: src/components/roles/RolesTable.tsx + RoleForm.tsx

export class RolesPage {
  constructor(readonly page: Page) {}

  async goto()                { await this.page.goto("/roles"); }
  async gotoNew()             { await this.page.goto("/roles/new"); }
  async gotoEdit(id: string)  { await this.page.goto(`/roles/${id}/edit`); }

  async fillRoleForm(data: { roleCode: string; roleName: string; description?: string }) {
    await this.page.getByLabel(/role code/i).fill(data.roleCode);
    await this.page.getByLabel(/role name/i).fill(data.roleName);
    if (data.description) await this.page.getByLabel(/description/i).fill(data.description);
  }

  async submitForm() {
    await this.page.getByRole("button", { name: /save|create|submit/i }).click();
  }

  get rolesTable() { return this.page.locator("table").first(); }
}

// ─── Audit Log Page ───────────────────────────────────────────────────────────

export class AuditPage {
  constructor(readonly page: Page) {}
  async goto() { await this.page.goto("/audit"); }
  get auditTable() { return this.page.locator("table").first(); }
}
