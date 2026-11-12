# Process: Sign in with scratchbox.ai, the IDE side, live in the app

> **Recorded:** 2026-11-11
> **Status:** Verified (IDE side, against a local stand-in for scratchbox.ai). Unverified against production: its web half is not built yet.
> **Tags:** `operate-scratchbox` `account` `oauth-pkce` `settings` `scratchbox-ai`
> **Target Domain:** Settings / Account, server `/api/account`, the Studio MCP client

---

## 1. Session Context

* **What prompted this session:** phase A of docs/research/2026-11-11-scratchbox-account-sign-in-plan.md: the IDE signs in to scratchbox.ai in the system browser (authorization code with PKCE, loopback redirect) and keeps a per-workspace `sbmcp_` credential for 90 days, replacing the internal-secret link.
* **Instance used:** my own `scratchbox-account-sign-in` launch entry: web `3170`, API `3171`, tools `3172`, with `SCRATCHBOX_ACCOUNT_URL=http://127.0.0.1:3175` (a local stand-in) and `SCRATCHBOX_CREDENTIALS_FILE` pointing at a scratch file, so the user's own `~/.scratchbox/credentials.json` was never written. Entry removed afterwards.
* **Scope tested:** Settings > Account (signed out, waiting, signed in, signed out), the sidebar and Settings footer names, the callback page, sign-out with revoke.

---

## 2. What Was Tested & What Worked (Verified)

* **Start** — clicked "Sign in with scratchbox.ai" → the consent page opened at `/connect/desktop?client_id=scratchbox-ide&redirect_uri=http://127.0.0.1:3171/auth/scratchbox/callback&state=…&code_challenge=…&code_challenge_method=S256&device=…`. The callback is on the API port (the server reads its own port from the socket).
* **Exchange** — the stand-in approved and redirected back. Its log: `token issued (PKCE verified)`. `GET /api/account/status` then answered `signedIn: true`, user `standin-user`, workspace `Stand-in Studio`, access until 2027-02-10 (90 days), with no credential in the body.
* **Storage** — the scratch credentials file was mode 0600 with no plaintext `sbmcp_`. The user's own store was untouched.
* **UI** — the Account card shows the user, plan, host, workspace and expiry. The sidebar and Settings footer show `standin-user` instead of "Scratchbox User".
* **Sign out** — clicked Sign out → stand-in log `revoke ok`, the store emptied to `{}`, the card back to "Not signed in" with "Signed out. The IDE's access was revoked on scratchbox.ai."
* **Health** — `read_console_messages(onlyErrors)`: none. `/api/account/*`: all 200.
* **Automated:** `packages/core/test/scratchbox-account.test.ts` (13), `desktop-app/test/account-routes.test.ts` (2) and `scratchbox-studio-client.test.ts` (4) pass with HOME emptied and credential variables unset. `npm run typecheck` exits 0.
* **Proof images:** `docs/screenshots/2026-11-11-account-sign-in/` (gitignored): `0-sheet.jpg` plus the four states.

---

## 3. What Broke / Didn't Work

* **Production** — clicking Sign in against the default `https://www.scratchbox.ai` opens `/connect/desktop`, which answers 404 ("Not Found"). This is expected: the web half (consent page, `/api/auth/desktop/token`, `/revoke`, behind `DESKTOP_CONNECT_ENABLED`) has not been built.
* **Browser pane quirk** — the success page closes itself after 1.5 s when the browser allows it. In the Browser pane the popup took over the pane, so closing it closed the pane. In Electron the page opens in the system browser, where this does not happen; in a normal browser tab it closes only that tab.
* Fixed during the session:
  - the "Open the sign-in page" fallback rendered as an unstyled white button (now `sb-cursor-row-btn`);
  - the Settings footer still read "Scratchbox User" while signed in.

---

## 4. Candidate Tool/Service Ideas

* **A scratchbox.ai stand-in fixture for live checks:** a small `scripts/dev/scratchbox-ai-standin.cjs` implementing the desktop sign-in contract (consent page with an explicit click, token, revoke, an MCP route that 401s a revoked credential). It would let later account work (balance in phase B, the metered model route in phase C) be checked live without production.
* **A `SCRATCHBOX_CREDENTIALS_FILE` line in operate-scratchbox's launch template**, so isolated instances never share the user's keys or sign-in.
