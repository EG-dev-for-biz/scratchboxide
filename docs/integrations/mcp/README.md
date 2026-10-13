# Scratchbox Canvas MCP — Integration Guide

This is the external contract for other apps and agents that want to call into Scratchbox Studio: the hosted **Scratchbox Canvas MCP** server at `scratchbox.ai`. It's the counterpart to [docs/CODEBASE_API_LEDGER.md](../../CODEBASE_API_LEDGER.md), which documents this repo's *internal* services and in-app Gemini agent tool registry. Nothing here is implemented in this repo — the client here only *consumes* MCP servers (see `McpHubPrimitive` in `packages/core/src/browser/generative-canvas/primitives/`). This guide documents the contract of the server other apps call.

The full tool catalog lives in generated per-category files — start at **[index.md](./index.md)**. Those files are build artifacts; never hand-edit them. This README covers everything the generated catalog can't: how to connect, how auth works, and the async job pattern almost every write tool follows.

## Keeping the catalog current

The catalog is generated from a live `tools/list` response, not typed by hand — see [tools-snapshot.json](./tools-snapshot.json) for the captured snapshot and its `capturedAt`/`source` fields.

```bash
# Regenerate docs/integrations/mcp/*.md from the committed snapshot
node scripts/generate_mcp_docs.mjs

# Refresh the snapshot from the live server first (needs credentials below), then regenerate
node scripts/generate_mcp_docs.mjs --live

# CI drift gate: fails if committed docs don't match what the snapshot would generate
node scripts/generate_mcp_docs.mjs --check
```

If you add, rename, or change the schema of a tool on the server, run `--live` and commit the diff. Don't edit the category files directly — they'll be overwritten.

## 1. Server architecture & endpoints

| Attribute | Value |
|---|---|
| **Remote MCP URL** | `https://scratchbox.ai/api/mcp/canvas` |
| **Transport** | MCP Streamable HTTP (JSON-RPC 2.0, `Accept: application/json, text/event-stream`) |
| **Workspace model** | Every call is scoped to one workspace; switch with `workspace.switch` or the `x-scratchbox-workspace-id` header |
| **Asset CDN** | `https://scratchbox.ai/api/storage/serve?path=...` — generated media is public-readable at this URL, no auth needed to fetch it |

### Required HTTP headers

```http
POST /api/mcp/canvas HTTP/1.1
Host: scratchbox.ai
Content-Type: application/json
Accept: application/json, text/event-stream
x-internal-secret: <SESSION_SECRET>
x-internal-user-id: <USER_ID>
x-scratchbox-workspace-id: <WORKSPACE_ID>
```

- `x-internal-secret` / `x-internal-user-id` authenticate the caller. Treat the secret like any other bearer credential — don't commit it, don't log it.
- `x-scratchbox-workspace-id` sets the active workspace for that request. Over the stdio transport, `workspace.switch` persists for the process lifetime; over HTTP, the client must resend the header on every call (or every reconnect) for it to stick — `workspace.switch` alone does not persist across HTTP reconnects.
- Call `auth.whoami` first to confirm the session is valid (authenticated user, current workspace, tier) before calling any write tool.

### Local stdio bridge

For local/CLI integration there's also a stdio transport wired through a bridge script, registered the same way any MCP server is registered with a CLI tool's `mcp_config.json`. The JSON-RPC method surface (`tools/list`, `tools/call`) is identical between transports; only the connection and session-persistence details above differ.

## 2. The async job pattern

Most tools that generate media (`ai_generate_images`, `video_generate`, `audio_synthesize_*`, `character_image_to_3d`, `writer_deep_write`, ...) follow the same durable job shape — don't expect a synchronous result:

```
1. tools/call: ai_generate_images { prompt, idempotencyKey, ... }
       → enqueues a durable job, returns an operationId
         (ai_generate_images itself defaults to polling for you and
          returning the public CDN URL — see "waitForCompletion" below)

2. tools/call: operation_get { operationId }   — poll until terminal
       → { status: "running" | "saving" | "completed" | "failed", ... }

3. On "completed": the output is a public CDN URL under
   https://scratchbox.ai/api/storage/serve?... and a new node is
   durably attached to the active canvas.
```

Key invariants, true across the whole catalog:

- **`idempotencyKey` is required on every billed/durable call.** Reuse the same key only to retry the *exact same* request — a new attempt needs a new key. Several tools (`ai_video_restyle`, `storyboard_process_frame`, `prompt_studio_run_saved_recipe`, ...) explicitly document that retries with a stale key against a changed request will be rejected.
- **`maxEstimatedCost` is an optional spend guard**, not a billing report — pass it to refuse enqueueing if the current cost estimate exceeds it.
- **Jobs are cancellable (mostly) via `operation_cancel`**, except where a tool's own description says otherwise (e.g. `ai_upscale_image` — its provider call can't be safely aborted once started).
- **Everything billed is bound to a workspace-owned canvas node.** Tools take a `nodeId` (or `sceneNodeId`, `characterNodeId`, ...) referencing an existing node, not raw bytes or arbitrary URLs — media has to already be durably stored in the workspace (via `library_search`, `canvas_get_node`, etc.) before most generation/edit tools can act on it.
- **Some tools are headless no-ops by design**, not bugs: a handful (`ai_video_compose`, `writer_transform_selected_text`, `recipe_run`) explicitly refuse to execute and say so in their description — they depend on a live browser session the MCP transport doesn't have. Don't retry these; use the interactive app instead.

## 3. Minimal working example

```http
POST /api/mcp/canvas
x-internal-secret: ...
x-internal-user-id: 42
x-scratchbox-workspace-id: 126

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"ai_generate_images",
  "arguments":{
    "prompt":"anamorphic photograph of a rain-slicked highway at twilight",
    "aspectRatio":"21:9",
    "idempotencyKey":"deck-hero-001"
  }
}}
```

With `waitForCompletion` left at its default (`true`), the response resolves directly to the finished job's public CDN URL. Set it to `false` and poll `operation_get` yourself if you're orchestrating many jobs in parallel and don't want to hold the connection open.

## 4. Where to go next

- **Full tool catalog, by category**: [index.md](./index.md)
- **Internal services and in-app tool registry** (for working *in* this repo, not calling the hosted server): [docs/CODEBASE_API_LEDGER.md](../../CODEBASE_API_LEDGER.md)
