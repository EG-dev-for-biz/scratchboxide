# Architectural Debt Ledger

This file tracks high-friction architectural boundaries in Scratchbox IDE. Do not refactor items proactively; wait until a user prompt naturally touches the specified systems.

---

## Active Debt Items

### [DEBT-001] GenerativeCanvasStudio.tsx Monolithic Component Size

- **Evidence**:
  - `extensions/product/src/browser/generative-canvas/GenerativeCanvasStudio.tsx` (~4,200 lines)
  - Coordinates layout modes, chat history, prompt enhancement, voice dictation, modal states, token budget HUD popover, artifact version rollbacks, and composer input rendering all in a single React component state tree.
- **Impact**: Medium. Reading or modifying studio-level logic requires traversing a large file. However, component state encapsulation is currently working cleanly, and 24 comprehensive test suites guarantee its runtime correctness.
- **Suggested Direction**:
  - Extract sub-controllers into dedicated custom hooks when touching specific subsystems:
    - `useStudioModals()` for Spotlight, Settings, Projects, and Automations modal state management.
    - `useStudioComposer()` for autocomplete, voice dictation, and drag-and-drop file attachment.
    - `useStudioArtifactVersionHistory()` for version stepping and rollback actions.
- **Do Not Refactor Until**: A user request asks to add a new top-level modal workflow or significantly expand the composer dock capabilities.

---

### [DEBT-002] Duplicated Autocomplete Menus in SideChat and Main Studio

- **Evidence**:
  - `extensions/product/src/browser/generative-canvas/GenerativeCanvasStudio.tsx` (`renderComposerInput`)
  - `extensions/product/src/browser/generative-canvas/VibecodeAiSideChat.tsx` (`handleTextChange` & mention menu)
- **Impact**: Low. Context mention (@file, @git, etc.) and superpower (/) trigger matching logic is shared through `context-mention-engine.ts`, but the popover JSX structure is instantiated in both places.
- **Suggested Direction**: Extract a reusable `<ContextMentionAutocompletePopover />` component that accepts `activeCategory`, `query`, `onSelect`, and `position`.
- **Do Not Refactor Until**: The user requests a new context mention category (e.g. `@database` or `@logs`) or changes the visual design of autocomplete popovers.

---

### [DEBT-003] Backend Gemini Client Initialization Path Probing

- **Evidence**:
  - `extensions/product/src/node/gemini-service.ts` (`initAuth`)
  - Scans 10 candidate filesystem paths synchronously on initialization to locate service account credentials.
- **Impact**: Low. Works reliably across dev environments, but path resolution could be consolidated behind `WorkspaceConfigService`.
- **Suggested Direction**: Delegate credential file location discovery to `WorkspaceConfigService.resolveCredentialsPath()`.
- **Do Not Refactor Until**: Multi-user cloud container auth or dynamic OAuth2 tokens are requested for Google Cloud backend connections.

---

## Resolved Debt Items

- **[RESOLVED 2026-09-02]** Workspace Vendoring for Eclipse Theia dependencies (`vendor/packages/@theia/*` and `scripts/vendor-theia.ts`) — automated local package imports and integrity verification without npm publishing.
- **[RESOLVED 2026-09-04]** Cursor-Style Settings Page refactored into clean typography-only no-icon sidebar, Customize banner, and grouped settings cards with Apple-green toggles.
- **[RESOLVED 2026-09-05]** Google Models Backend Privacy & Exclusivity — abstracted model slugs behind user-facing capability tiers (`High Reasoning Engine`, `Fast Intelligence`) while ensuring backend strictly targets Gemini models.
- **[RESOLVED 2026-09-05]** Streamlined Landing Dashboard & KPI Primitive — 2x2 categorized starter grid, quick capability mode strip, 7D/30D/90D/YTD time-range filters, and area/line/bar charts.
- **[RESOLVED 2026-09-05]** Full 12-Tab Cursor Settings Suite — Profile, Appearance (with live diff preview and font steppers), Plan & Usage, Agents, Git & PRs, Worktrees, Browser & Network, Tab Autocomplete, Code Intelligence, and Beta.
- **[RESOLVED 2026-09-05]** Autocomplete & Modal Micro-Refactoring — extracted `<ContextMentionAutocompletePopover />`, `useStudioModals()`, and `useArtifactVersionHistory()`.
- **[RESOLVED 2026-09-05]** Core Primitives Audit & Capability Polish — enhanced `KanbanBoardPrimitive` with HTML5 native drag-and-drop & sprint progress metrics; reactive time-range filtering (7D/30D/90D/YTD) and CSV/JSON export in `MetricCardsPrimitive`; eliminated dead modal triggers and standalone `ProjectsModal` overlay in favor of direct sidebar workspace navigation.
