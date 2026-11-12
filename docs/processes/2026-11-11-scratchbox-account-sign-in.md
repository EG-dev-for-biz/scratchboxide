# Process: Sign in with scratchbox.ai, the IDE side, live in the app

> **Recorded:** 2026-11-11 (second pass the same day, on the token contract)
> **Status:** Verified in development (`npm run dev`) against a local stand-in for scratchbox.ai. Unverified: production (the web half is not deployed), and the packaged Electron build with the real OS keychain.
> **Tags:** `operate-scratchbox` `account` `oauth-pkce` `refresh-tokens` `settings` `scratchbox-ai`
> **Target Domain:** Settings / Account, server `/api/account` and `/api/studio`, the Studio MCP client

---

## 1. Session Context

* **What prompted this session:** the user asked to merge PR #219 (Sign in with scratchbox.ai, first pass: a 90-day credential) with an IDE patch prepared alongside the web half (short-lived access tokens, rotating refresh tokens, Electron `safeStorage`, a one-use loopback listener, hosted tool routes). The result keeps the patch's contract and security core and PR #219's Settings tab, and it runs under `npm run dev`.
* **Instance used:** my own `scratchbox-account-sign-in` launch entry: web `3170`, API `3171`, tools `3172`. It set `SCRATCHBOX_ACCOUNT_URL=http://127.0.0.1:3175` (the stand-in, `scripts/dev/scratchbox-ai-standin.cjs`) and `SCRATCHBOX_CREDENTIALS_FILE` (a scratch key file, so the user's own `~/.scratchbox/credentials.json` was never written). Entry removed afterwards.
* **Scope tested:** sign in (waiting state, consent, the loopback return), connected state and name, hosted tools through `/api/studio`, a server restart, a token refresh, disconnect with revoke.

---

## 2. What Was Tested & What Worked (Verified)

* **Start** — a real click on "Sign in with scratchbox.ai" put the card into "Waiting for your browser" with Cancel and an "Open the sign-in page" fallback. The consent URL's `redirect_uri` was `http://127.0.0.1:60977/auth/scratchbox/callback`: the account's own one-use listener, not the API server.
* **Consent** — the consent page opened in a normal tab; Approve took the browser to the listener's "Return to Scratchbox IDE" page. Stand-in log: `consent`, then `token-issued`.
* **Connected** — the card showed `standin-user`, the email, plan and host, and the workspace `Stand-in Studio`. The sidebar and Settings footer showed `standin-user`. The status JSON carried no token.
* **Storage** — the scratch key file was mode 0600 with no plaintext `sbdr_` or `sbmcp_`.
* **Hosted tools** — from the page, `GET /api/studio/tools` returned `auth.whoami` and `canvas.list_nodes`, and `POST /api/studio/tools/call auth.whoami` returned `{user: standin-user, workspaceId: 217}`.
* **Restart** — after a server restart the status was connected, with the name, and the stand-in logged no call; the name was restored from the saved binding.
* **Refresh** — the next tool call after the restart renewed the token (stand-in log: `refreshed`).
* **Disconnect** — a real click: the stand-in logged `revoked`, the key file emptied to `{}`, and the card read "Disconnected. This device's access was revoked on scratchbox.ai."
* **Health** — after reloading, every API request on the page load returned 200 (the one aborted request was the file-watch stream cut off by the reload). The console's connection-refused errors came from the minutes the server was stopped for the restart test.
* **Automated** (HOME emptied, credential variables unset):
  - `packages/core/test/scratchbox-desktop-account.test.ts` (38: the patch's cases ported, plus loopback origins, identity saved and restored, no stale refresh written back, the key-file vault, the vault choice, the bearer transport rules);
  - `desktop-app/test/account-routes.test.ts` (5, end to end over HTTP against the stand-in);
  - `scratchbox-studio-client.test.ts` (4) and `key-store.test.ts` (1).
  - `npm run typecheck` exits 0.
* **Proof images:** `docs/screenshots/2026-11-11-account-sign-in-v2/` (gitignored), `0-sheet.jpg` plus six states.

---

## 3. What Broke / Didn't Work

* **Fixed during the session:**
  - The identity read right after connecting was refused, because the account still counted as connecting. It now runs once the connection has settled.
  - A token the server rejected early dropped the whole connection. Now a 401 (the call did not run) renews the token once and retries that call once; only a refused renewal disconnects.
  - An identity save could have written back a refresh token that a concurrent refresh had already rotated. Saves are now ordered in one queue, and the new grant becomes current inside it.
* **Not verified here:** the packaged Electron build (`safeStorage`, keychain lock or unavailability, an app restart with the keychain), and production. The web half is not deployed, and its contract document is not on GitHub.

---

## 4. Candidate Tool/Service Ideas

* **`scripts/dev/scratchbox-ai-standin.cjs`** (added) — use it for phase B (balance) and phase C (the metered model route) checks too. Each phase extends the stand-in with the new endpoints.
* **A `SCRATCHBOX_CREDENTIALS_FILE` line in operate-scratchbox's launch template**, so isolated instances never share the user's keys or connection.
* **A "verify packaged build" checklist** for account work: the real keychain, lock and unlock, restart, revoke. It can't be automated from the browser pane.
