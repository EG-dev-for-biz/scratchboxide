# ⚠️ DEPRECATED: Eclipse Theia Application Shells

> [!WARNING]
> **Formal Deprecation Notice (ADR-008 — September 2026)**
>
> The Eclipse Theia browser (`applications/browser`) and electron (`applications/electron`) shells are **formally deprecated** and are no longer maintained as the primary runtime environment for Scratchbox IDE.

## Rationale
- **Startup Latency & Overhead**: Eclipse Theia runtime architecture imposed heavy startup latency (>4 seconds), complex dependency injection graphs, and monolithic webpack bundles exceeding 4.8MB.
- **Modern Standalone Architecture**: Scratchbox IDE has fully transitioned to the standalone Desktop Application located in [`desktop-app/`](../desktop-app/) powered by Vite 5, React 18, and Electron 38.
- **First-Party Core Library**: Core canvas features, the 7 visual primitives, 3D tiles geospatial engine, and autonomous AI agents have been packaged into our first-party library [`@scratchbox/core`](../packages/core/).

## Migration & Active Development
- **To develop Scratchbox IDE**:
  ```bash
  cd desktop-app
  npm install
  npm run dev
  ```
- **To build production desktop binaries**:
  ```bash
  cd desktop-app
  npm run build
  ```
- **To run architectural purity tests**:
  ```bash
  cd desktop-app
  npm test
  ```
