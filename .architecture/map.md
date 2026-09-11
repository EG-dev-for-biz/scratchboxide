# Architecture Map

## Overview
Scratchbox IDE is a modern, extensible AI-first cloud and desktop development environment built on the Eclipse Theia platform, React 19, TypeScript, and Google Gemini models (Gemini 3.7 Flash & Subagents), styled with a minimalist Cursor-grade interface and Apple Liquid Glass design language.

---

## Domains & Boundaries

### 1. Presentation & Surface Orchestration (Frontend UI)
React components, viewports, stage layout coordinators, and design system primitives.
- **Location**: `extensions/product/src/browser/`
- **Key Modules**:
  - `generative-canvas/GenerativeCanvasStudio.tsx`: Primary visual viewport & workspace surface orchestrator.
  - `generative-canvas/VibecodeAiSideChat.tsx`: Unified Cursor-style side chat with Agent/Ask/Plan mode selector and tool execution step badges.
  - `generative-canvas/BentoStageLayout.tsx`: Multi-surface stage coordinator (single, dual-split, tri-pane-bento).
  - `generative-canvas/SettingsModal.tsx`: Typography-first, no-icon desktop settings window matching Cursor Desktop.
  - `generative-canvas/SpotlightLauncherModal.tsx`: Cmd+K companion command launcher.
  - `generative-canvas/ProjectsModal.tsx`: Workspace switcher and starter template hub.
  - `generative-canvas/AutomationsModal.tsx`: Visual workflow and n8n-style automation canvas hub.
  - `style/unified-ui.css` & `style/index.css`: Single source of truth for design tokens, typography, and micro-interactions.

### 2. Generative Visual Primitives
Self-contained, interactive artifacts rendered inside canvas surfaces with natural-language bidirectional mutation.
- **Location**: `extensions/product/src/browser/generative-canvas/primitives/`
- **Primitives**:
  - `LiveCodeSandboxPrimitive.tsx`: Multi-tab hot-reloading code editor (React 19 / Tailwind / Pyodide WASM) with console bridge.
  - `MarkdownDocumentPrimitive.tsx`: Spec & Notion-style document editor with diff markers, tables, and callouts.
  - `KanbanBoardPrimitive.tsx`: Agile delivery board with movable priority cards and stage progress tracking.
  - `NodeGraphPrimitive.tsx`: Bi-directional bezier node flow & logic builder with parameter inspection.
  - `MetricCardsPrimitive.tsx`: Streamlined executive KPI dashboard with time-range filters (7D/30D/90D/YTD) and area/line/bar charts.
  - `InteractiveFormPrimitive.tsx`, `ChecklistPrimitive.tsx`, `MindMapPrimitive.tsx`, `SkillsManagerPrimitive.tsx`, `McpHubPrimitive.tsx`.

### 3. Client Engines & Cross-Surface State
Headless browser-side state machines and deterministic data processors.
- **Location**: `extensions/product/src/browser/generative-canvas/`
- **Key Engines**:
  - `project-artifact-controller.ts`: Canonical project graph command client, legacy session projector, typed relationship projection, and durable persistence coordinator.
  - `project-artifact-adapter.ts`: Backward-compatible `CanvasArtifact` ↔ graph node/revision adapter with stable identity normalization.
  - `primitive-transformer-engine.ts`: 1-Click polymorphic morphing between primitives (e.g. Spec Checklist → Kanban → Sandbox).
  - `dirty-state-manager.ts`: Granular tab dirty state tracking, SHA-256 baseline hashing, and debounced auto-saving.
  - `context-mention-engine.ts`: Inline `@` trigger parser resolving `@file`, `@folder`, `@git`, `@terminal`, `@web`, `@docs`, `@mcp`.
  - `multi-file-diff-engine.ts`: Multi-file code additions/deletions calculator and selective batch patch applier.
  - `terminal-debug-bridge.ts`: Terminal stack trace diagnostics extractor and self-healing prompt synthesizer.
  - `guardrails-service.ts`: Tool execution classifier (safe read-only vs mutating confirmation vs destructive blocker).

### 4. Backend AI Intelligence & Reasoning Services (Node.js)
Server-side orchestration of Google Gemini models, autonomous agent loops, context graphs, and local sandboxes.
- **Location**: `extensions/product/src/node/`
- **Key Services**:
  - `gemini-service.ts`: Google Gemini 3.7 Flash & Subagent (3.5 Flash Lite) streaming, thinking disclosure, and Google Cloud service account IAM auth.
  - `long-running-agent-service.ts`: Autonomous agent state machine with deterministic checkpoints, rollback, execution budgets, and runaway cycle pivoting.
  - `project-context-graph-service.ts`: Cross-surface entity indexing, topological relevance slicing, and Multi-Head Latent Attention (MLA) context compression.
  - `self-improvement-service.ts`: Grounded TDD feedback loop indexing error traces against learned memories.
  - `container-sandbox-service.ts`: Localized container execution environment with command isolation and resource bounds.
  - `agent-context-compactor.ts`: 3-tier Titans neural memory (Core, Contextual with associative decay, Persistent) & Multi-Token Prediction (MTP).
  - `workspace-file-watcher-service.ts`: Bidirectional filesystem watcher with hash-based loopback suppression.

### 5. Inter-Process Communication & Protocols
Shared typed RPC contracts and payload definitions connecting Frontend to Node.js Backend.
- **Location**: `extensions/product/src/common/`
- **Protocols**: `project-artifact-graph-protocol.ts`, `gemini-protocol.ts`, `context-graph-protocol.ts`, `agent-checkpoint-protocol.ts`, `container-sandbox-protocol.ts`, `self-improvement-protocol.ts`, `workspace-sync-protocol.ts`.
- **Canonical state invariant**: Project artifact identity, immutable revisions, typed edges, selection, and permissions belong to `ProjectArtifactGraph`; primitive and session objects are compatibility projections.

### 6. Packaging, Shell & Workspace Vendoring Infrastructure
Target applications, launchers, updaters, and custom local Theia build management.
- **Location**: `applications/`, `extensions/launcher/`, `extensions/updater/`, `vendor/`, `scripts/`
- **Responsibilities**: Electron desktop wrapper, browser bundle, Yarn workspace vendoring (`scripts/vendor-theia.ts`).

---

## Dependency Flow Direction

```text
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend UI Presentation                     │
│  (GenerativeCanvasStudio, VibecodeAiSideChat, SettingsModal)    │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Generative Primitives & Engines               │
│ (Sandbox, Spec, Kanban, NodeGraph, Transformer, ContextMention) │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Common Protocols & DTOs                       │
│ (gemini-protocol, context-graph-protocol, checkpoint-protocol)  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Backend Node.js Services                      │
│ (GeminiService, LongRunningAgent, ContextGraph, SandboxService) │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│             Theia Platform & External Infrastructure            │
│  (Google Cloud Vertex AI / Gemini API, Docker/Pty, Local FS)    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Dependency Invariants

1. **Model Privacy & Exclusivity**: Backend strictly targets Google models (`gemini-3.7-flash`, `gemini-3.5-flash-lite`, `gemini-2.5-pro`); frontend components abstract model identity behind user-friendly capability tiers without leaking model slugs.
2. **Strict Protocol Separation**: Frontend modules communicate with backend node services exclusively through typed protocols (`src/common/*`) and HTTP/SSE endpoints.
3. **Change Locality in Primitives**: Each visual primitive (`LiveCodeSandboxPrimitive`, `MarkdownDocumentPrimitive`, `KanbanBoardPrimitive`, `NodeGraphPrimitive`, `MetricCardsPrimitive`) is self-contained with its own data contract and rendering logic.
4. **Change Locality in Design Tokens**: All visual styling, buttons, modals, and switches draw from `unified-ui.css` variables without inline ad-hoc color codes.
5. **No Regressions on Core Features**: When adopting Cursor-style UI patterns (side chat, mode pills, typography settings, tool steps), all existing Scratchbox capabilities (multi-surface primitives, automations hub, context mentions, TDD loops) remain 100% active and test-verified.
