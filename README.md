<br/>
<div id="scratchbox-logo" align="center">
    <br />
    <h1>Scratchbox IDE</h1>
    <p><strong>Autonomous AI Generative Canvas Studio, Visual Primitives & 3D Geospatial Engine</strong></p>
</div>

---

> [!NOTE]
> **Architecture Update (ADR-008)**:
> The legacy Eclipse Theia shell (`applications/browser`, `applications/electron`) has been **formally deprecated**. Scratchbox IDE is now powered by the modern standalone React 18 + Vite 5 + Electron 38 desktop workspace (`desktop-app/`) and the first-party core library `@scratchbox/core` (`packages/core/`).

---

## 🚀 Quick Start

### Prerequisites
- Node.js >= 20.0.0
- npm >= 10.0.0

### Run the Standalone Desktop Application (Dev Mode)

```bash
# From the root directory:
npm run dev

# Or directly in desktop-app:
cd desktop-app
npm run dev
```
This concurrently starts:
1. **Local Express AI Backend**: `http://localhost:3001` (Gemini Flash/Pro, Imagen 3, 3D tile auth, deep write planners)
2. **Vite Frontend**: `http://localhost:3000` with hot-module reloading and sub-second startup

### Production Build

```bash
# Build core library and standalone desktop application
npm run build
```

### Run Tests

```bash
# Run architecture & standalone purity tests
npm test
```

---

## 📦 Monorepo Architecture

```
scratchbox-ide/
├── desktop-app/              # Standalone Desktop & Web Application (Vite 5 + React 18 + Electron 38)
│   ├── src/                  # React UI entry point, Canvas mount, and client scene
│   ├── server/               # Express backend API for AI, artifacts, and asset storage
│   ├── electron/             # Native Electron 38 container and window lifecycle
│   └── test/                 # Standalone architecture, server, and chat resilience tests
│
├── packages/
│   └── core/                 # First-party @scratchbox/core library
│       ├── src/index.ts      # Canvas studio, 7 visual primitives, and error boundary
│       ├── src/browser.ts    # Google 3D Tiles layer, terrain manager, diurnal atmosphere, mesh sculpting
│       ├── src/node.ts       # Gemini service, DeepWrite autonomous planners, artifact stores
│       └── src/common.ts     # GeoFrame, LocalTangentPlane, RPC protocols
│
├── extensions/
│   └── product/              # Core domain services and React canvas components
│
└── applications/             # ⚠️ DEPRECATED (Eclipse Theia browser/electron shells)
```

---

## 🧩 First-Party Library: `@scratchbox/core`

The core capabilities of Scratchbox are packaged as an independent library:

```typescript
// Generative Canvas Studio & Visual Primitives
import { GenerativeCanvasStudio, CanvasErrorBoundary } from '@scratchbox/core';
import '@scratchbox/core/style.css';

// 3D Geospatial Engine & Atmospheric Lighting
import { GooglePhotorealistic3DTilesLayer, createAtmosphericSkyDome } from '@scratchbox/core/browser';

// AI Intelligence & Autonomous DeepWrite Planners
import { GeminiService, DynamicDagPlanner, DeepWriteService } from '@scratchbox/core/node';

// Local Tangent Plane Coordinates & Graph Protocols
import { LocalTangentPlane, GeoFrame } from '@scratchbox/core/common';
```

---

## 🛡️ Security Best Practices

- Never commit `.env` or production API credentials. All secrets should be set via environment variables:
  - `GOOGLE_GENAI_API_KEY`: API key for Gemini 2.5 Flash / Pro and Imagen 3.
  - `GOOGLE_MAPS_API_KEY`: API key for Google Photorealistic 3D Tiles.
- Run `npm test` before submitting changes to verify architectural purity and zero-Theia dependency constraints.

---

## License
MIT License. Copyright (C) 2026 Scratchbox IDE.
