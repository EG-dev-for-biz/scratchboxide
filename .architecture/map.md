# Architecture Map

## Overview
Scratchbox IDE is a modern, extensible AI-first spatial and desktop development environment built on React 18, TypeScript, Google Gemini models (Gemini 3.7 Flash, 3.5 Flash Lite, 2.5 Pro), a native C++20 procedural 3D engine, and Google Photorealistic 3D Tiles, styled with a minimalist Cursor-grade interface and Apple Liquid Glass design language.

The repository is structured as a high-efficiency monorepo:
- **`packages/core`**: First-party core library (`@scratchbox/core`) exporting browser canvas, visual primitives, native 3D engine, atmospheric scattering, UTDRA/ULDRA tile rectification, and backend AI intelligence services.
- **`packages/cli`**: The `sbox` spatial version control CLI (`@scratchbox/cli`) providing geodetic spatial branching, commits, and diffing ("Git for the physical world").
- **`desktop-app`**: Standalone Vite 5 + React 18 + Electron 38 desktop workspace with an Express API Gateway.

---

## Domains & Boundaries

### 1. Presentation & Surface Orchestration (Frontend UI)
React components, viewports, stage layout coordinators, and design system primitives.
- **Location**: `packages/core/src/browser/` & `desktop-app/src/`
- **Key Modules**:
  - `generative-canvas/GenerativeCanvasStudio.tsx`: Primary visual viewport & workspace surface orchestrator.
  - `generative-canvas/VibecodeAiSideChat.tsx`: Unified Cursor-style side chat with Agent/Ask/Plan mode selector and tool execution step badges.
  - `generative-canvas/BentoStageLayout.tsx`: Multi-surface stage coordinator (single, dual-split, tri-pane-bento).
  - `generative-canvas/SettingsModal.tsx`: Typography-first, no-icon desktop settings window matching Cursor Desktop.
  - `generative-canvas/SpotlightLauncherModal.tsx`: Cmd+K companion command launcher.
  - `generative-canvas/ProjectsModal.tsx`: Workspace switcher and starter template hub.
  - `generative-canvas/AutomationsModal.tsx`: Visual workflow and n8n-style automation canvas hub.
  - `style/unified-ui.css` & `style/index.css`: Single source of truth for design tokens, typography, and micro-interactions.

### 2. Generative Visual Primitives & Adaptive Domain Architecture
Self-contained, interactive artifacts rendered inside canvas surfaces with natural-language bidirectional mutation and zero closed domain presets.
- **Location**: `packages/core/src/browser/generative-canvas/primitives/`
- **Primitives**:
  - `Scene3DPrimitive.tsx`: 3D procedural viewport streaming native C++20 GLB meshes and Google Photorealistic 3D Tiles with real-time camera controls.
  - `LiveCodeSandboxPrimitive.tsx`: Multi-tab hot-reloading code editor (React 18 / Tailwind / Pyodide WASM) with console bridge.
  - `MarkdownDocumentPrimitive.tsx`: Spec & Notion-style document editor with diff markers, tables, and callouts.
  - `KanbanBoardPrimitive.tsx`: Agile delivery board with movable priority cards and stage progress tracking.
  - `NodeGraphPrimitive.tsx`: Bi-directional bezier node flow & logic builder with parameter inspection.
  - `MetricCardsPrimitive.tsx`: Streamlined executive KPI dashboard with time-range filters (7D/30D/90D/YTD) and area/line/bar charts.
  - `VideoTimelinePrimitive.tsx`, `InteractiveBrowserPrimitive.tsx`, `InteractiveFormPrimitive.tsx`, `ChecklistPrimitive.tsx`, `MindMapPrimitive.tsx`, `SkillsManagerPrimitive.tsx`, `McpHubPrimitive.tsx`.
- **Domain Engine**: `adaptive-domain-engine.ts` enforces the Antigravity paradigm ("The LLM is the domain engine") with zero closed domain enums and AST-grounded document projection.

### 3. Native C++20 Spatial Engine & Geospatial Pipeline
High-performance procedural 3D generation, SIMD vector math, Marching Cubes SDF polygonization, and photogrammetric rectification.
- **Location**: `packages/core/src/native/3d-engine/`
- **Key Modules**:
  - `include/scratchbox_engine.hpp`: Unified C++20 engine header.
  - `include/scratchbox_math.hpp` & `scratchbox_geometry.hpp`: SIMD vector mathematics and half-edge topological representations.
  - `include/scratchbox_sdf.hpp` & `scratchbox_shaper.hpp`: Procedural signed distance fields and Marching Cubes polygonization.
  - `include/scratchbox_utdra.hpp`: Universal Tile Decomposition & Rectification Algorithm (UTDRA / ULDRA) for bridge void carving and facade rectification.
  - `include/scratchbox_ephemeris.hpp` & `scratchbox_lighting.hpp`: NOAA geodetic solar ephemeris and Rayleigh/Mie atmospheric scattering.
  - `include/scratchbox_io.hpp`: Binary glTF 2.0 (`.glb`) streaming packer directly consumed by Three.js.

### 4. Client Engines & Cross-Surface State
Headless browser-side state machines and deterministic data processors.
- **Location**: `packages/core/src/browser/generative-canvas/`
- **Key Engines**:
  - `project-artifact-controller.ts`: Canonical project graph command client, legacy session projector, typed relationship projection, and durable persistence coordinator.
  - `project-artifact-adapter.ts`: Backward-compatible `CanvasArtifact` ↔ graph node/revision adapter with stable identity normalization.
  - `primitive-transformer-engine.ts`: 1-Click polymorphic morphing between primitives (e.g. Spec Checklist → Kanban → Sandbox).
  - `dirty-state-manager.ts`: Granular tab dirty state tracking, SHA-256 baseline hashing, and debounced auto-saving.
  - `context-mention-engine.ts`: Inline `@` trigger parser resolving `@file`, `@folder`, `@git`, `@terminal`, `@web`, `@docs`, `@mcp`.
  - `multi-file-diff-engine.ts`: Multi-file code additions/deletions calculator and selective batch patch applier.
  - `terminal-debug-bridge.ts`: Terminal stack trace diagnostics extractor and self-healing prompt synthesizer.
  - `guardrails-service.ts`: Tool execution classifier (safe read-only vs mutating confirmation vs destructive blocker).

### 5. Backend AI Intelligence & Reasoning Services (Node.js)
Server-side orchestration of Google Gemini models, autonomous agent loops, context graphs, and local sandboxes.
- **Location**: `packages/core/src/node/` & `desktop-app/server/`
- **Key Services**:
  - `gemini-service.ts`: Google Gemini 3.7 Flash & Subagent (3.5 Flash Lite) streaming, thinking disclosure, and Google Cloud service account IAM auth.
  - `long-running-agent-service.ts`: Autonomous agent state machine with deterministic checkpoints, rollback, execution budgets, and runaway cycle pivoting.
  - `project-context-graph-service.ts`: Cross-surface entity indexing, topological relevance slicing, and Multi-Head Latent Attention (MLA) context compression.
  - `self-improvement-service.ts`: Grounded TDD feedback loop indexing error traces against learned memories.
  - `container-sandbox-service.ts`: Localized container execution environment with command isolation and resource bounds.
  - `agent-context-compactor.ts`: 3-tier Titans neural memory (Core, Contextual with associative decay, Persistent) & Multi-Token Prediction (MTP).
  - `workspace-file-watcher-service.ts`: Bidirectional filesystem watcher with hash-based loopback suppression.

### 6. Inter-Process Communication & Protocols
Shared typed RPC contracts and payload definitions connecting Frontend to Node.js Backend.
- **Location**: `packages/core/src/common/`
- **Protocols**: `project-artifact-graph-protocol.ts`, `gemini-protocol.ts`, `context-graph-protocol.ts`, `agent-checkpoint-protocol.ts`, `container-sandbox-protocol.ts`, `self-improvement-protocol.ts`, `workspace-sync-protocol.ts`.
- **Canonical state invariant**: Project artifact identity, immutable revisions, typed edges, selection, and permissions belong to `ProjectArtifactGraph`; primitive and session objects are compatibility projections.

### 7. Spatial Version Control CLI (`sbox`)
Branching, committing, staging, and diffing geodetic anchors and procedural 3D scenes.
- **Location**: `packages/cli/`
- **Commands**: `init`, `status`, `branch`, `commit`, `diff`, `attach`, `bake`, `generate`, `matchmove`, `qa`, `splat`.

---

## Dependency Flow Direction

```text
┌─────────────────────────────────────────────────────────────────┐
│                     Desktop Presentation (Vite)                 │
│              (desktop-app/src: App.tsx, main.tsx)               │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                     @scratchbox/core (Browser)                  │
│  (GenerativeCanvasStudio, VibecodeAiSideChat, SettingsModal)    │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Generative Primitives & Engines               │
│ (Scene3D, Sandbox, Spec, Kanban, NodeGraph, Adaptive Domain)    │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Common Protocols & DTOs                       │
│ (gemini-protocol, context-graph-protocol, checkpoint-protocol)  │
└────────────────┬───────────────────────────────┬────────────────┘
                 │                               │
                 ▼                               ▼
┌─────────────────────────────────┐ ┌─────────────────────────────┐
│    Backend Node.js Services     │ │   Native C++20 3D Engine    │
│  (GeminiService, AgentService,  │ │ (scratchbox_engine.hpp,     │
│   desktop-app/server Gateway)   │ │  SIMD, Marching Cubes, GLB) │
└─────────────────────────────────┘ └─────────────────────────────┘
```

---

## Dependency Invariants

1. **Model Privacy & Exclusivity**: Backend strictly targets Google models (`gemini-3.7-flash`, `gemini-3.5-flash-lite`, `gemini-2.5-pro`); frontend components abstract model identity behind user-friendly capability tiers without leaking model slugs.
2. **Strict Protocol Separation**: Frontend modules communicate with backend node services exclusively through typed protocols (`src/common/*`) and HTTP/SSE endpoints.
3. **Change Locality in Primitives**: Each visual primitive (`LiveCodeSandboxPrimitive`, `MarkdownDocumentPrimitive`, `KanbanBoardPrimitive`, `NodeGraphPrimitive`, `MetricCardsPrimitive`) is self-contained with its own data contract and rendering logic.
4. **Change Locality in Design Tokens**: All visual styling, buttons, modals, and switches draw from `unified-ui.css` variables without inline ad-hoc color codes.
5. **No Regressions on Core Features**: When adopting Cursor-style UI patterns (side chat, mode pills, typography settings, tool steps), all existing Scratchbox capabilities (multi-surface primitives, automations hub, context mentions, TDD loops) remain 100% active and test-verified.
