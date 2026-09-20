# Architectural Debt Ledger

This file tracks high-friction architectural boundaries in Scratchbox IDE. Do not refactor items proactively; wait until a user prompt naturally touches the specified systems.

---

## Active Debt Items

### [DEBT-001] Large Visual Primitive Component Sizes (Scene3DPrimitive & LiveCodeSandboxPrimitive)

- **Evidence**:
  - `packages/core/src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx` (~221 KB, ~3,500 lines)
  - `packages/core/src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx` (~179 KB, ~3,000 lines)
  - `packages/core/src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx` (~181 KB, ~3,100 lines)
- **Impact**: Medium. Primitives encapsulate extensive interactive logic (3D gizmo controls, camera choreography, ESM sandboxing, AST markdown parsing). While test coverage is comprehensive (227 test suites, 1,043 tests in `packages/core/test`), file sizes make single-module navigation dense.
- **Suggested Direction**:
  - Lazily load heavyweight dependencies (Three.js post-processing passes, Monaco Editor workers, Pyodide WASM runtime) via dynamic `React.lazy()` / `import()`.
  - Extract sub-controllers into dedicated hook modules (e.g., `useScene3DLighting()`, `useSandboxCompiler()`).
- **Do Not Refactor Until**: Performance profiling shows client bundle size or initial primitive mount latency becoming a bottleneck on lower-end devices.

---

### [DEBT-002] Standalone Express Server Network Binding & Port Isolation

- **Evidence**:
  - `desktop-app/server/app.ts` & `desktop-app/server/index.ts`
  - Express API gateway binds to `127.0.0.1:3001` with token authentication (`SCRATCHBOX_LAUNCH_TOKEN`).
- **Impact**: Low. Token authentication, origin validation, and CSP sandboxing are strictly enforced. In sandboxed runner environments, socket connection permissions (`connect EPERM`) require bypass flags for integration test suites.
- **Suggested Direction**: Provide an in-memory `supertest` mock harness for test suites that bypasses physical TCP socket binding entirely.
- **Do Not Refactor Until**: Next test infrastructure overhaul.

---

## Resolved Debt Items

- **[RESOLVED 2026-09-18]** Adaptive Domain Architecture & Zero Presets — deprecated static `DOMAIN_PROFILES` (~460 lines) and closed domain enums in favor of model-as-domain-engine latent space and AST-grounded document projection (ADR-010).
- **[RESOLVED 2026-09-14]** C/C++ First 3D Spatial Engine Directive — unified 54 native header-only C++20 modules in `packages/core/src/native/3d-engine/include/` with Apple Clang compilation and streaming binary glTF 2.0 (ADR-009).
- **[RESOLVED 2026-09-07]** Standalone Clean Vite + React + Electron Architecture — completely removed Theia shell runtime, creating `desktop-app` and first-party `@scratchbox/core` (ADR-007, ADR-008).
- **[RESOLVED 2026-09-05]** GenerativeCanvasStudio Monolithic Decomposition — reduced from ~4,200 lines to ~1,648 lines by extracting `<ContextMentionAutocompletePopover />`, `useStudioModals()`, and `useArtifactVersionHistory()`.
- **[RESOLVED 2026-09-05]** Core Primitives Drag-and-Drop & Metric Export — enhanced `KanbanBoardPrimitive` with HTML5 native drag-and-drop & sprint metrics; reactive time-range filtering and CSV/JSON export in `MetricCardsPrimitive`.

- **[RESOLVED 2026-09-02]** Workspace Vendoring for Eclipse Theia dependencies (`vendor/packages/@theia/*` and `scripts/vendor-theia.ts`) — automated local package imports and integrity verification without npm publishing.
- **[RESOLVED 2026-09-04]** Cursor-Style Settings Page refactored into clean typography-only no-icon sidebar, Customize banner, and grouped settings cards with Apple-green toggles.
- **[RESOLVED 2026-09-05]** Google Models Backend Privacy & Exclusivity — abstracted model slugs behind user-facing capability tiers (`High Reasoning Engine`, `Fast Intelligence`) while ensuring backend strictly targets Gemini models.
- **[RESOLVED 2026-09-05]** Streamlined Landing Dashboard & KPI Primitive — 2x2 categorized starter grid, quick capability mode strip, 7D/30D/90D/YTD time-range filters, and area/line/bar charts.
- **[RESOLVED 2026-09-05]** Full 12-Tab Cursor Settings Suite — Profile, Appearance (with live diff preview and font steppers), Plan & Usage, Agents, Git & PRs, Worktrees, Browser & Network, Tab Autocomplete, Code Intelligence, and Beta.
- **[RESOLVED 2026-09-05]** Autocomplete & Modal Micro-Refactoring — extracted `<ContextMentionAutocompletePopover />`, `useStudioModals()`, and `useArtifactVersionHistory()`.
- **[RESOLVED 2026-09-05]** Core Primitives Audit & Capability Polish — enhanced `KanbanBoardPrimitive` with HTML5 native drag-and-drop & sprint progress metrics; reactive time-range filtering (7D/30D/90D/YTD) and CSV/JSON export in `MetricCardsPrimitive`; eliminated dead modal triggers and standalone `ProjectsModal` overlay in favor of direct sidebar workspace navigation.
