<div id="scratchbox-logo" align="center">
    <br />
    <img src="./ScratchboxIDE%20logo/ScratchboxIDE.png" alt="Scratchbox IDE Logo" width="120" />
    <h1>Scratchbox IDE</h1>
    <p><strong>Autonomous AI Generative Canvas Studio, Visual Primitives & 3D Geospatial Engine</strong></p>
    <p>
        <a href="#intellectual-property--patents"><img src="https://img.shields.io/badge/USPTO-Patent%20Pending-blue.svg" alt="USPTO Patent Pending" /></a>
        <a href="#intellectual-property--patents"><img src="https://img.shields.io/badge/Application-64%2F168%2C583-informational.svg" alt="U.S. Application 64/168,583" /></a>
    </p>
</div>

---

Scratchbox IDE is a standalone React 18 + Vite 5 + Electron 38 workspace backed by a
local Express API. All product code lives in two npm workspaces: the first-party
library `@scratchbox/core` (`packages/core/`) and the desktop/web shell (`desktop-app/`).

## Quick start

Prerequisites: Node.js >= 20, npm >= 10.

```bash
npm install
npm run dev        # Vite renderer on http://127.0.0.1:3000 + API on http://127.0.0.1:3001
```

`npm run dev` (see `desktop-app/scripts/dev.js`) generates a per-launch bearer token,
starts the Express API (`desktop-app/server/index.ts`, via ts-node) and the isolated
tools origin on port 3002, then starts Vite. The first API boot takes ~1 minute under
ts-node; the compiled server (below) starts in a few seconds.

### Python 3D engine

The agent's Python 3D scripting (`import scratchbox as sb`) runs on a native C++ module
(`scratchbox_native`) that is **built from source, not committed**. It needs a C++20 compiler
and a repo-local virtualenv on Python >= 3.10 (required by nanobind); `requirements.txt` also
installs CMake into the venv, so no system CMake is needed:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The first Python 3D run (or `npm test`) builds the module into
`packages/core/src/native/3d-engine/build_py/` (a few minutes cold). It rebuilds automatically
whenever the engine headers, bindings or `CMakeLists.txt` change; set `SCRATCHBOX_PYTHON` to use
a different interpreter.

### Production build

```bash
npm run build      # tsc (core) -> tsc + vite build + tsc -p tsconfig.electron.json (desktop-app)
npm start          # electron desktop-app  (loads desktop-app/dist)
```

Browser mode without Electron:

```bash
node desktop-app/dist-electron/desktop-app/server/index.js
# serves desktop-app/dist on http://127.0.0.1:3001 (set SCRATCHBOX_PRINT_LAUNCH_TOKEN=1 to print the token)
```

### Docker

**Standalone Web App (Production Hardened)**:
```bash
docker build -t scratchbox-ide .
docker run -p 3001:3001 -e GEMINI_API_KEY=... -v "$PWD/workspace:/workspace" scratchbox-ide
```

The image runs the compiled server as a non-root user, binds `0.0.0.0` inside the
container and exposes `/health`. Mount a read-only `secrets.json` at
`/home/scratchbox/.scratchbox/secrets.json` instead of baking credentials into the image.

**Inference Sidecar (GeoBox & DepthBox 6-DOF)**:
```bash
docker build -f Dockerfile.inference -t scratchbox-inference .
docker run -p 8080:8080 scratchbox-inference
```

Multi-runtime container providing Python 3, PyTorch, OpenCV, Clang C++20 toolchains, and `/api/geobox/health` endpoint.

### Quality gates

```bash
npm run typecheck  # strict TypeScript for packages/core, desktop-app, desktop-app/electron
npm run lint       # ESLint 9 flat config (eslint.config.js)
npm test           # vitest: packages/core/test/**  +  desktop-app/test/**
```

`npm run test:core` / `npm run test:desktop` run one workspace; `npm run test:watch` watches.
CI (`.github/workflows/ci.yml`) runs all four plus a no-push Docker build.

#### Test prerequisites

A clean checkout runs the suite with no failures caused by the machine: anything a test needs that is not in git
makes that test **skip with a reason** instead of failing. The reason is appended to the test title as
`[skipped: ...]` (see `packages/core/test/helpers/requirements.ts`), so `npx vitest run --reporter=verbose`
or `--reporter=json` lists exactly what is missing and how to get it.

| Prerequisite | Needed by | Without it |
|---|---|---|
| Node 22+ and `npm install` | everything | — |
| Python 3.10+ venv: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` (nanobind + cmake) | Python 3D engine tests; `vitest.global-setup.ts` builds `scratchbox_native` from `.venv` on the first run | those tests fail |
| `clang++` with C++20 (Xcode CLT / `apt install clang`), `zlib` | native C++ engine tests | those tests fail |
| `ffmpeg` (`brew install ffmpeg` / `apt install ffmpeg`; `FFMPEG_PATH` is honoured where the code honours it) | JPEG/video encode, Street View, texture fusion, media pipelines | skipped |
| `cwebp` (`brew install webp` / `apt install webp`; or `SCRATCHBOX_CWEBP_PATH`) | WebP texture compression | skipped |
| `numpy` on the `python3` in PATH | NumPy skinning-parity test (`scripts/sbx_skinning.py`) | skipped |
| `torch`, `numpy`, `Pillow` (`tools/depth/requirements.txt`) | panorama depth / walkable world | skipped |
| Google Chrome / Chromium | headless screenshot tests | skipped |
| `GOOGLE_MAPS_API_KEY` or `MAP_TILES_API_KEY`; Vertex AI credentials | live Google 3D Tiles ingestion, Vertex image generation | skipped |
| Gitignored binary assets (`public/models/*.glb`, `models/performer_4dgs/**`, `*.sbhuman`, video plates, ...) | asset-backed integration tests | skipped, naming the file and its producer script; `npm run hydrate` downloads the ones in `manifests/demos_asset_manifest.json` when a mirror is reachable (its offline placeholders count as missing) |

CI installs the Python venv, `numpy`, `ffmpeg` and `webp`, so only asset-, credential- and torch-backed tests skip there.
Tests write their outputs to `os.tmpdir()` (or the gitignored `test-results/`, `build/`, `.scratchbox/`) and must never
overwrite tracked files: after `npm test`, `git status` should be clean.

## Repository layout

```
scratchbox-ide/
├── package.json              # npm workspaces: packages/*, desktop-app; root scripts
├── vitest.config.ts          # single test runner for both workspaces
├── eslint.config.js          # ESLint 9 flat config
├── Dockerfile / .dockerignore
├── .github/workflows/ci.yml
│
├── packages/core/            # @scratchbox/core (consumed from source via path aliases)
│   ├── src/browser/          # React UI: generative-canvas studio, primitives, 3D layers, styles
│   │   └── generative-canvas/
│   │       ├── GenerativeCanvasStudio.tsx   # shell; state in state/, hooks in hooks/
│   │       ├── state/        # chatStore, StudioContext
│   │       ├── hooks/        # useSendMessage, useMediaJobPolling, useWorkspaceFiles, ...
│   │       ├── chat/         # MessageList, MessageItem, Composer
│   │       ├── studio/       # WorkspaceSidebar, StudioTopBar, ArtifactStage, AgentDashboard
│   │       ├── settings/     # SettingsModal context/reducer/tabs
│   │       └── primitives/   # Scene3D, MarkdownDocument, LiveCodeSandbox, McpHub, ...
│   ├── src/node/             # Gemini service (gemini/ modules), DeepWrite planners,
│   │                         # artifact stores, key-store.ts, security/ (path-guard, sandbox-policy)
│   ├── src/common/           # GeoFrame, LocalTangentPlane, RPC protocol types
│   ├── src/core/             # framework-free utilities (events, disposables)
│   └── test/                 # vitest suites (architecture guards, services, primitives)
│
└── desktop-app/
    ├── src/                  # renderer entry (mounts GenerativeCanvasStudio)
    ├── server/               # Express API: app.ts (routes, auth, CORS), index.ts (bootstrap),
    │                         # renderer-dist.ts (locates the Vite build)
    ├── electron/             # main.ts (window + embedded server), preload.ts (IPC allowlist)
    ├── scripts/dev.js        # dev orchestrator
    └── test/                 # server auth, standalone app, chat resilience, renderer-dist
```

`@scratchbox/core` is resolved to `packages/core/src` through path aliases in
`vitest.config.ts`, `desktop-app/vite.config.ts` and the tsconfigs. Node-side code in
`desktop-app/server` and `desktop-app/electron` imports core with relative paths so the
emitted JavaScript under `desktop-app/dist-electron/` runs without any alias loader.

```typescript
import { GenerativeCanvasStudio, CanvasErrorBoundary } from '@scratchbox/core';
import '@scratchbox/core/style.css';
import { GooglePhotorealistic3DTilesLayer } from '@scratchbox/core/browser';
import { GeminiService, DynamicDagPlanner } from '@scratchbox/core/node';
import { LocalTangentPlane, GeoFrame } from '@scratchbox/core/common';
```

## Configuration

### Credentials

Credentials are read from the environment first. If a key is missing, the server loads
`~/.scratchbox/secrets.json` (preferred), falling back to a repo-root `secrets.json`
or `.env` with a warning. Only keys on `SERVER_SECRET_ALLOWLIST`
(`desktop-app/server/app.ts`) are imported from those files.

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini text, image, video and grounding calls |
| `GOOGLE_MAPS_API_KEY` / `MAP_TILES_API_KEY` | Google Photorealistic 3D Tiles |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_SERVICE_ACCOUNT_PATH` | Service-account auth for Vertex / Drive |
| `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | Vertex AI project + region |

User-entered credentials (Settings modal) are stored encrypted in
`~/.scratchbox/credentials.json` (mode 0600) by `packages/core/src/node/key-store.ts`;
Electron swaps in `safeStorage` through the `KeyStoreCipher` hook.

Never commit `secrets.json`, `service-account.json` or `.env`; they are ignored by
`.gitignore` and `.dockerignore`.

### Runtime

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API bind address (Docker sets `0.0.0.0`) |
| `PORT` / `SCRATCHBOX_API_PORT` | `3001` | API port |
| `SCRATCHBOX_TOOLS_PORT` | `3002` | Isolated origin serving user-exported tools |
| `SCRATCHBOX_LAUNCH_TOKEN` | generated | Per-launch bearer token required on every `/api/*` route |
| `SCRATCHBOX_PRINT_LAUNCH_TOKEN` | unset | `1` prints the token at boot (browser mode) |
| `SCRATCHBOX_ALLOWED_ORIGINS` | dev/electron origins | Comma-separated CORS allowlist |
| `SCRATCHBOX_WORKSPACE_ROOTS` | `~`, `~/Documents` | Comma/colon-separated roots the file APIs may touch |
| `SCRATCHBOX_STATIC_DIR` | auto-detected | Overrides where the built renderer is served from |
| `SCRATCHBOX_PROXY_ALLOW_PRIVATE` | unset | `1` lets the browser proxy reach private/loopback addresses |
| `SCRATCHBOX_SANDBOX_ENV_ALLOWLIST` | unset | Extra env vars forwarded to sandboxed commands |

## Security model

- **Authentication**: every API and SSE route requires `Authorization: Bearer <launch token>`;
  static assets are the only unauthenticated content. The token is minted once per launch
  and handed to the renderer via Vite define (dev) or the Electron preload (packaged).
- **CORS**: explicit origin allowlist; packaged Electron adds the `null` origin for `file://`.
- **Filesystem confinement**: `packages/core/src/node/security/path-guard.ts` resolves every
  user path inside an allowed workspace root and rejects traversal and symlink escapes.
- **Tool isolation**: user-generated tools are served from a separate origin
  (`SCRATCHBOX_TOOLS_PORT`) so they never share the app's origin, token or storage.
- **Sandboxed commands**: `security/sandbox-policy.ts` enforces a command allowlist, a
  hard denylist, and a scrubbed environment (`SANDBOX_ENV_ALLOWLIST` + `SANDBOX_SECRET_ENV_PATTERN`).
  Non-allowlisted commands need an explicit `confirmedByUser` flag from the UI.
- **Browser proxy**: private, loopback and link-local destinations are denied by default;
  DNS is resolved once and the connection is pinned to that IP to prevent rebinding.
- **Electron**: `sandbox: true`, `contextIsolation`, a strict CSP, and an IPC channel allowlist in `preload.ts`.
- **Errors**: API handlers return generic messages to clients and log details server-side;
  `unhandledRejection` / `uncaughtException` terminate the process instead of continuing half-initialised.

## Intellectual property & patents

The core 3D photogrammetric mesh decomposition, void excision, and non-destructive elevation slicing algorithms in Scratchbox IDE (UTDRA / ULDRA) are proprietary and patent pending under United States patent law:
- **U.S. Patent Application No. 64/168,583 (Patent Pending)**.
- Title: *SYSTEM, METHOD, AND NON-TRANSITORY COMPUTER-READABLE MEDIUM FOR UNSUPERVISED MACRO-GEOGRAPHIC TELEMETRY PROBING, TOPOLOGICAL VOID EXCISION, AND NON-DESTRUCTIVE ELEVATION SLICING IN PHOTOGRAMMETRIC THREE-DIMENSIONAL MESHES*.
- For licensing inquiries, contact Elias John Green (`ejohngreen@gmail.com`).

## License

Commercial License. Copyright (C) 2026 Scratchbox LLC. All rights reserved.
See [LICENSE](file:///Users/eligreen/dev/scratchbox-ide-master/LICENSE) for commercial licensing terms.
