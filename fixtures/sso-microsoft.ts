/**
 * fixtures/sso-microsoft.ts
 *
 * Completes the Microsoft Entra ID (Azure AD) browser login after the app
 * redirects to login.microsoftonline.com. Intended for NextAuth "Sign in with
 * Microsoft" flows.
 *
 * Does not handle MFA/TOTP or device-code prompts — use a test tenant policy
 * that allows password-only for automation accounts, or run setup manually.
 */

import type { Page } from "@playwright/test";

export interface MicrosoftEntraSignInOptions {
  email: string;
  password: string;
  /** Wait until the app URL matches this (default: /dashboard). */
  successUrl?: RegExp;
}

const DEFAULT_SUCCESS = /\/dashboard/;

/**
 * Clicks the SSO entry point on the app login page, then finishes the
 * Microsoft-hosted steps (email → password → optional "Stay signed in?").
 */
export async function signInFromAppLoginPage(
  page: Page,
  opts: { buttonLabel?: string } = {},
): Promise<void> {
  const label = opts.buttonLabel ?? process.env.PLAYWRIGHT_SSO_BUTTON_LABEL;
  const pattern =
    label != null && label.length > 0
      ? new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      : /microsoft|azure|entra|work or school|sign in with/i;

  const button = page.getByRole("button", { name: pattern }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    return;
  }
  const link = page.getByRole("link", { name: pattern }).first();
  if (await link.isVisible().catch(() => false)) {
    await link.click();
    return;
  }
  throw new Error(
    `SSO: no login button/link matched ${pattern}. Set PLAYWRIGHT_SSO_BUTTON_LABEL to your provider label.`,
  );
}

export async function completeMicrosoftEntraSignIn(
  page: Page,
  options: MicrosoftEntraSignInOptions,
): Promise<void> {
  const success = options.successUrl ?? DEFAULT_SUCCESS;

  await page.waitForURL(/login\.microsoftonline\.com|login\.live\.com|microsoft\.com\/oauth2/i, {
    timeout: 120_000,
  });

  const emailSel = 'input[name="loginfmt"], input#i0116, input[type="email"]';
  const emailBox = page.locator(emailSel).first();
  await emailBox.waitFor({ state: "visible", timeout: 60_000 });
  await emailBox.fill(options.email);
  await page.getByRole("button", { name: /^next$/i }).click();

  const passBox = page.locator('input[name="passwd"], input#i0118').first();
  await passBox.waitFor({ state: "visible", timeout: 60_000 });
  await passBox.fill(options.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  const yes = page.getByRole("button", { name: /^yes$/i });
  try {
    await yes.waitFor({ state: "visible", timeout: 8_000 });
    await yes.click();
  } catch {
    /* "Stay signed in?" not shown */
  }

  await page.waitForURL(success, { timeout: 120_000 });
}

export async function signInWithSso(
  page: Page,
  email: string,
  password: string,
  successUrl?: RegExp,
): Promise<void> {
  await signInFromAppLoginPage(page, {});
  await completeMicrosoftEntraSignIn(page, {
    email,
    password,
    successUrl,
  });
}
