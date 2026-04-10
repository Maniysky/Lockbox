# BOA LockBox — Playwright E2E Framework

Playwright E2E test layer for **BOA LockBox Processing & Cash Application**.
Sits on top of the existing **Vitest unit tests** already in `src/`.

## Test layers

| Layer | Tool | Location | What it tests |
|---|---|---|---|
| Unit | Vitest | `src/**/*.test.ts` | Services, repositories, middleware, parser — mocked DB |
| **E2E / API** | **Playwright** | `e2e/tests/**` | Real running app + real SQL Server DB |

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.playwright.example .env.playwright
# Edit .env.playwright — set PLAYWRIGHT_BASE_URL and test credentials

npx playwright test --project=setup        # authenticate all roles
npx playwright test --project=api          # API tests (fast, no browser)
npx playwright test --project=ui:chromium  # UI tests
npx playwright test                        # everything
npx playwright show-report                 # open HTML report
```

## Structure

```
e2e/
├── fixtures/
│   ├── auth.setup.ts            Signs in as all 4 roles, saves storageState
│   ├── roles.fixture.ts         Per-role Page + APIRequestContext fixtures
│   └── lockbox-file.factory.ts  Pipe-delimited file generator
├── pages/index.ts               Page Object Models for all app routes
└── tests/
    ├── rbac/        permissions.api.spec.ts  rbac.ui.spec.ts
    ├── lockbox/     lockbox.api.spec.ts
    ├── accounts/    accounts.api.spec.ts
    ├── gl/          glbatches.api.spec.ts
    ├── admin/       users-roles.api.spec.ts
    └── e2e/         business-flows.spec.ts
```

## Database seeds required

Run against DEV/UAT before tests:
1. `scripts/add-permission-tables.sql`
2. `scripts/20260402_roles_accountant_ar_assistant.sql`
3. `scripts/20260402_suspense_accounts_seed.sql`
4. `scripts/20260402_lockbox_permissions_seed.sql`
5. Create 4 test users (accountant, ar-assistant, security-admin, app-admin)
   with `AuthSource = 'credentials'` and assign correct roles.

## CI/CD

Add `azure-pipelines-e2e.yml` as a stage after the existing Deploy stage.
Set `RUN_E2E_TESTS = 'true'` in each variable group to enable.
Playwright traces are published as pipeline artifacts for SOX evidence retention.
