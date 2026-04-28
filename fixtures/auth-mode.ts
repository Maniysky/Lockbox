/**
 * fixtures/auth-mode.ts
 *
 * PLAYWRIGHT_AUTH_MODE=credentials | sso
 *   credentials — email/password fields on /login (NextAuth Credentials provider)
 *   sso         — Microsoft Entra via button on /login, then Entra-hosted pages
 */

export type PlaywrightAuthMode = "credentials" | "sso";

export function getPlaywrightAuthMode(): PlaywrightAuthMode {
  const raw = (process.env.PLAYWRIGHT_AUTH_MODE ?? "credentials").toLowerCase();
  if (raw === "sso" || raw === "azure" || raw === "entra" || raw === "microsoft") {
    return "sso";
  }
  return "credentials";
}
