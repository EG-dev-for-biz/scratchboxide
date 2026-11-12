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

## 3. The flow (as built, 2026-11-11: the token contract)

The contract follows the IDE patch prepared with the web half (`scratchbox-ide-patch`, against main `d7a8d522`; its web
side is documented as `docs/desktop-account-connection.md` in SCRATCHBOX-STUDIO-CANVAS, not yet pushed). It replaces the
90-day `sbmcp_` credential this plan first described with short-lived access tokens and rotating refresh tokens.

1. **Start (IDE server).** `POST /api/account/sign-in` starts `DesktopAccount.connect()`
   (`packages/core/src/node/scratchbox-account/desktop-account.ts`). It opens a one-use listener on an ephemeral port on
   127.0.0.1 and answers the consent URL, which the UI opens (Electron routes `window.open` to the system browser):
   `/connect/desktop?client_id=scratchbox-ide&redirect_uri=http://127.0.0.1:<ephemeral>/auth/scratchbox/callback&state&code_challenge&code_challenge_method=S256&device`.
2. **Approve (scratchbox.ai).** The user picks one workspace they can edit (scope `workspace:read workspace:write`) and
   approves; the browser returns to the listener with a one-time code (`sbdc_`). The listener checks the exact Host and
   path and the state (constant time), refuses a request with a browser Origin, a duplicate state or a second use, and
   times out after 5 minutes; a request with the wrong state does not use up the attempt.
3. **Exchange.** `POST /api/auth/desktop/token` `{client_id, grant_type: authorization_code, code, redirect_uri,
   code_verifier}` answers `{access_token (sbmcp_, ≤ 900 s), refresh_token (sbdr_), token_type: Bearer, expires_in,
   scope, workspace_id, connection_id, mcp_path: /api/mcp/canvas}`; every field is checked. No redirect is followed and
   answers are read to at most 64 KB.
4. **Keep.** Only the refresh token and the binding (origin, workspace, connection, and the display identity) are
   stored, in a vault (`desktop-vault.ts`): in the app, Electron `safeStorage` (the OS keychain) in a private file under
   the user-data directory, replaced atomically, with no plaintext fallback (Linux `basic_text` and a locked keychain
   refused); in development (`npm run dev`, where the server runs outside Electron), the key store's encrypted file
   (`~/.scratchbox/credentials.json`, or `SCRATCHBOX_CREDENTIALS_FILE`). Inside Electron without `safeStorage`
   nothing is stored. Access tokens live in memory only. The UI sees `GET /api/account/status`: connected, connecting,
   workspace, connection, identity, and why it is signed out.

## 4. Using the connection

- `studio-mcp-client.ts` asks the account for a token per call (`getAccessToken`) and sends `Authorization: Bearer`
  only to `/api/mcp/canvas` over HTTPS (plain HTTP only on loopback). Calls are never replayed after a transport failure;
  a 401 (the call did not run) renews the token once and retries that call once, and when the renewal is refused too
  (revoked from the web) the connection is forgotten with the reason.
- Refreshes are serialized; each rotates the refresh token. A refresh whose answer is uncertain (lost, malformed, another
  workspace, an unchanged token) is never replayed: the connection is cleared and the user reconnects. An epoch fences
  late answers, so a cancelled or disconnected sign-in is never restored.
- Workspace media: `GET /api/auth/desktop/media?path=` signs a workspace storage path; the signed URL is fetched with no
  account header. Already-public provider media is used as given; foreign API proxies are refused.
- The hosted tools for the agent and UI: `/api/studio/{status,identity,tools,tools/call,media}`, behind the launch token.
- Identity for display: `GET /api/auth/desktop/me`, read once after connecting and saved with the binding, so a restart
  shows the name without a network call.
- The `SCRATCHBOX_MCP_*` internal secret stays only as a development fallback while nothing is connected (it comes from a
  developer's own `secrets.json` and is never in a release); it goes when the web half is live.

## 5. Lifecycle

- **Expiry:** access tokens last at most 15 minutes and renew on demand; the connection lasts until it is disconnected,
  revoked, or a refresh is refused.
- **Disconnect:** `DELETE /api/auth/desktop/me` with the current access token revokes this device only; the IDE forgets
  its copy whatever the answer and says when the revoke was not confirmed.
- **Revoke from the web:** the next call's 401 and refused renewal sign the IDE out with the reason.

## 6. Security

- PKCE (S256) and a one-use state on every connect; the callback on its own ephemeral loopback port, not the API server.
- No token reaches the renderer or a URL; the server holds them, and errors shown to the user are fixed messages, never
  a server's answer or a request URL.
- In the app the refresh token is in the OS keychain; the development key file's machine-derived AES key is obfuscation,
  not secrecy, and is used only outside Electron.
- No password, cookie or session of scratchbox.ai is handled by the IDE.

## 7. Changes (IDE, as built)

- `packages/core/src/node/scratchbox-account/`: `desktop-account.ts` (the flow, tokens, refresh, media, revoke),
  `desktop-vault.ts` (keychain vault, development key-file vault, the choice), `account-service.ts` (the server's one
  account, configured by the embedding app).
- `desktop-app/server/routes/accountRoutes.ts`: `/api/account/{sign-in,cancel,status,sign-out}` and
  `/api/studio/{status,identity,tools,tools/call,media}`; `app.ts` configures the account with the storage Electron passes
  (`accountEncryption: safeStorage`, `accountDataDir`); `electron/main.ts` passes them and stops a pending sign-in on quit.
- `studio-mcp-client.ts` on the account's bearer provider (development secret fallback kept, see 4).
- Settings → Account (sign in, waiting with cancel, who, workspace, disconnect), the sidebar and Settings footer name.
- `scripts/dev/scratchbox-ai-standin.cjs`: a local stand-in for the contract, for tests and live checks.

The patch's native "Scratchbox Account" menu is not included: the Settings tab is the one UI, and works in development too.

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
   *Superseded by the token contract (section 3, user decision 2026-11-11 to merge with the web half's patch): access
   tokens last at most 15 minutes and renew from a rotating refresh token, so there is no fixed 90-day end; the
   connection lasts until disconnected, revoked, or a renewal is refused. Still one workspace per connection.*
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
