/**
 * playwright.config.ts
 *
 * E2E test layer for BOA LockBox Processing & Cash Application.
 *
 * Actual stack (from source code):
 *   - Next.js 16.2.1 deployed to IIS on Windows VM via Azure Deployment Groups
 *   - Auth: NextAuth v5 — Microsoft Entra ID (prod) + Credentials (dev/test)
 *   - DB: SQL Server (MSSQL) via Prisma + @prisma/adapter-mssql
 *   - Branches: dev → DEV, UAT → UAT, main → Prod
 *
 * This config targets the running app (DEV or UAT) — NOT a local dev server.
 * Unit tests (Vitest) live in src/ and run separately via `npm run test`.
 *
 * Parallelism: financial DB state is shared — serial by default.
 * API read-only tests can run fullyParallel in their own project.
 */

import { defineConfig, devices } from "@playwright/test";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.playwright" });

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,

  reporter: [
    ["html",  { outputFolder: "playwright-report", open: "never" }],
    ["junit", { outputFile: "test-results/junit.xml" }],
    ["list"],
  ],

  use: {
    baseURL: BASE_URL,
    trace:      "on-first-retry",
    video:      "on-first-retry",
    screenshot: "only-on-failure",
    extraHTTPHeaders: { "Accept": "application/json" },
  },

  projects: [
    {
      name: "setup",
      testMatch: "**/auth.setup.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "ui:chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: ["**/*.api.spec.ts"],
    },
    {
      name: "api",
      use: { baseURL: BASE_URL },
      dependencies: ["setup"],
      testMatch: "**/*.api.spec.ts",
      fullyParallel: true,
    },
  ],
});
