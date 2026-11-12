# Sign in with scratchbox.ai: one account for the IDE and the web (phase A)

Date: 2026-11-11. Status: plan, questions answered (section 9), not started. Spans two repositories: this one (Scratchbox IDE) and
`EG-dev-for-biz/SCRATCHBOX-STUDIO-CANVAS` (scratchbox.ai).

## 1. Decisions taken

- **One account, the web's.** A Scratchbox IDE user is a scratchbox.ai user; the IDE keeps no accounts of its own.
- **Who pays (user decision, 2026-11-11): credits and own keys.** The IDE charges the user's scratchbox.ai credits by
  default, and any provider can be switched to the user's own key instead. That is phases B and C; this phase is
  identity only.
- **No passwords in the IDE.** Sign-in happens in the system browser, on scratchbox.ai, with whatever it already asks
  for. The extension's username/password route (`/api/auth/extension/login`) is not used.

## 2. What exists

| | IDE | scratchbox.ai |
|---|---|---|
| Accounts | None: one local user, display name from `localStorage` (`getActiveUserName`), local API behind a launch token | Users with a tier, cookie sessions (`frontend/app/lib/auth.ts`) |
| Credential for an app | — | `canvas_mcp_credentials` (`shared/schema/_root.ts:188`): `sbmcp_` + 43 chars, stored as a hash, one workspace, 1-90 days, revocable; created by `POST /api/account/mcp-credentials` from a browser session only; accepted as `Bearer` by `/api/mcp/canvas` |
| Where a secret is kept | `KeyStore` (`packages/core/src/node/key-store.ts`): encrypted `~/.scratchbox/credentials.json`, an Electron `safeStorage` cipher can plug in; PR #217 keeps provider keys there | — |
| The link today | `studio-mcp-client.ts` sends `x-internal-secret` with a fixed user and workspace id from `secrets.json` | The MCP route trusts that secret for any user id |

The internal secret lets its holder act as any user. It is acceptable on a developer's own machine and must never be in
a released build. Replacing it is the first purpose of this phase.

## 3. The flow (OAuth 2.0 authorization code with PKCE and a loopback redirect, RFC 8252)

1. **Start (IDE server).** `POST /auth/scratchbox/start` makes a random `state` and `code_verifier`, keeps them in memory
   for 10 minutes, and returns the URL to open:
   `https://scratchbox.ai/connect/desktop?client_id=scratchbox-ide&redirect_uri=http://127.0.0.1:<api port>/auth/scratchbox/callback&state=…&code_challenge=S256(verifier)&code_challenge_method=S256&device=<hostname>`.
   The Electron shell opens it with `shell.openExternal`; the web build opens it in a new tab. The callback is the IDE's
   own API server, which is already listening on loopback, so no extra listener is needed.
2. **Approve (scratchbox.ai).** `/connect/desktop` needs a browser session (it sends the user through the normal sign-in
   if there is none), shows "Allow Scratchbox IDE on <device> to act for you in workspace [picker] for 90 days", and on
   Allow calls `POST /api/auth/desktop/authorize`. That stores a one-time code (its hash, the user, the workspace, the
   code challenge, the redirect URI, the device name, 5 minutes) and redirects the browser to
   `redirect_uri?code=…&state=…`. The redirect URI is accepted only as `http://127.0.0.1:<port>/auth/scratchbox/callback`
   or `http://localhost:<port>/…` (any port, per RFC 8252).
3. **Exchange (IDE server → scratchbox.ai).** The callback checks `state`, then posts
   `{ code, code_verifier, redirect_uri }` to `POST /api/auth/desktop/token`. scratchbox.ai checks that the code exists,
   is unused and unexpired, that `S256(code_verifier)` equals its challenge and that the redirect URI matches; it marks
   the code used and calls the existing `createCanvasMcpCredential(userId, workspaceId, "Scratchbox IDE · <device>", 90)`,
   returning `{ credential, expiresAt, user: { id, username, email, tier }, workspace: { id, name } }`.
4. **Keep (IDE).** The credential goes into the `KeyStore` (service `scratchbox.ai`, account `credential`); the user,
   workspace and expiry go into the workspace config. The browser UI never sees the credential: it reads
   `GET /auth/scratchbox/status` (`signedIn`, `username`, `workspaceName`, `tier`, `expiresAt`). The callback page tells the
   user they can close the tab.

## 4. Using the credential

- `studio-mcp-client.ts` sends `Authorization: Bearer <credential>` (and the workspace id header it is bound to) in place of
  the internal secret. `studioMcpConfigFromEnv` gives way to a resolver that reads the store; the `SCRATCHBOX_MCP_SECRET`
  path is removed from the app (a developer signs in like anyone else).
- On sign-in and at start-up the IDE calls the MCP `auth.whoami` tool: a 401 marks it signed out and says why.
- The sidebar's user chip and `getActiveUserName` show the signed-in username; signed out, "Scratchbox User" as now.
- **Workspace:** a credential is bound to one workspace (`allowedWorkspaceId`). Switching workspace means connecting again
  for the other one (phase A); a user-wide credential is an open question (section 9).

## 5. Lifecycle

- **Expiry:** at most 90 days (the route's limit). Seven days before, the IDE shows "Reconnect to scratchbox.ai"; after,
  it is signed out.
- **Sign out:** the IDE deletes its copy and calls a new `POST /api/auth/desktop/revoke` that accepts the credential as
  `Bearer` and revokes only itself (the existing `DELETE /api/account/mcp-credentials` needs a browser session).
- **Revoke from the web:** the account page already lists and revokes credentials (`frontend/app/account/CanvasMcpCredentials.tsx`);
  the IDE's next call gets 401 and signs out.

## 6. Security

- PKCE (S256) and `state` on every connect; one-time codes stored as hashes, five minutes, single use; the token endpoint
  rate-limited per IP and per code.
- The credential never reaches the browser UI or a URL; it travels only IDE server ↔ scratchbox.ai over HTTPS.
- In the Electron build the `KeyStore` uses `safeStorage` (the OS keychain). The file store's machine-derived AES key
  (`LocalAesCipher`) is obfuscation, not secrecy, and stays the fallback for the plain Node server only.
- No password, cookie or session token of scratchbox.ai is ever handled by the IDE.

## 7. Changes

**scratchbox.ai** (`SCRATCHBOX-STUDIO-CANVAS`):
- a migration for `desktop_auth_codes` (code hash, user, workspace, challenge, redirect URI, device, expires, used);
- `frontend/app/connect/desktop/page.tsx` (consent and workspace picker);
- `frontend/app/api/auth/desktop/{authorize,token,revoke}/route.ts` and `frontend/app/lib/desktop-auth.ts`;
- the account page labels IDE credentials by device.

**Scratchbox IDE** (this repository):
- `packages/core/src/node/scratchbox-account/`: PKCE, the flow's state, the exchange, the store and the status;
- `desktop-app/server` routes `/auth/scratchbox/{start,callback,status,signout}`; the Electron `openExternal` hook and the
  `safeStorage` cipher;
- `studio-mcp-client.ts` on the bearer credential, the internal-secret path removed;
- Settings → Account (connect, who, workspace, expiry, sign out), the sidebar user chip.

## 8. Order, tests and checks

1. scratchbox.ai first, merged and deployed to production with the flag off, since the IDE cannot sign in without it.
2. The IDE, then the flag turned on for the live test.

Tests (none bill, no real accounts): PKCE pairs; code single use and expiry; redirect URI acceptance and refusal; the token
exchange end to end on each side against the other side's real handlers run locally; a 401 from `auth.whoami` signs out.
Live: with the flag on, connect the IDE to www.scratchbox.ai with a test account, call `auth.whoami`, revoke from the
web and see the IDE sign out, with a labelled proof sheet.

## 9. Answered (user decisions, 2026-11-11)

1. **One credential per workspace**, as scratchbox.ai issues them now: a leaked credential reaches one workspace, and
   switching workspace in the IDE means connecting again for the other one.
2. **90 days**, the existing limit: the IDE warns seven days before and the user reconnects in the browser; revocable from
   the web at any time.
3. **Built and tested against production** (www.scratchbox.ai), behind a feature flag on scratchbox.ai
   (`DESKTOP_CONNECT_ENABLED`, off by default): with it off, `/connect/desktop` answers 404 and the three
   `/api/auth/desktop/*` routes refuse, so nothing is reachable until the flag is turned on for testing. The IDE points at
   `SCRATCHBOX_ACCOUNT_URL` (default `https://www.scratchbox.ai`). The live test uses a test account of the user's own on
   production; the code and token routes are rate-limited before the flag is ever on.

## 10. After this phase

- **B:** the billing routes accept the credential (the `withAuthFromRequest` middleware already does Bearer), and the IDE
  shows the balance and opens the top-up page when a call cannot be paid.
- **C:** a metered model route on scratchbox.ai, using the billing service's reserve, commit and roll back with the IDE's
  turn and call ids as idempotency keys; the IDE's providers (PR #217) gain "Scratchbox credits" beside "my own key".
- **D:** shared workspaces and assets through the canvas MCP tools.
