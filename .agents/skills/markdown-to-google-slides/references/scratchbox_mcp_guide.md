# Scratchbox Canvas MCP Integration Guide

This guide documents the architecture, configuration, and practical usage of the **Scratchbox Canvas MCP** server hosted at `scratchbox.ai` (`https://scratchbox.ai/api/mcp/canvas`).

---

## 1. Executive Summary

Scratchbox Studio provides a centralized Model Context Protocol (MCP) server exposing **138 creative production tools** across generative AI, prompt engineering, video synthesis, 3D world creation, and presentation generation.

For presentation decks and pitch treatments created with `markdown-to-google-slides`, the Scratchbox MCP is the **exclusive, production-grade visual synthesis engine**. It powers photorealistic hero banners, anamorphic letterbox stills, 3D previs frames, and multi-image beat grids via Google Nano Banana Pro (`google/nano-banana-pro`).

---

## 2. Server Architecture & Endpoints

| Attribute | Value |
|---|---|
| **Remote MCP URL** | `https://scratchbox.ai/api/mcp/canvas` |
| **Transport** | MCP Streamable HTTP (JSON-RPC 2.0 with SSE data responses) |
| **Local Stdio Bridge** | `/Users/eligreen/.gemini/config/scripts/scratchbox_mcp_bridge.mjs` |
| **Registration** | `~/.gemini/config/mcp_config.json` under `"scratchbox"` |
| **Default Workspace** | Workspace `126` (or dynamically selected via `workspace.switch`) |
| **Asset CDN** | `https://scratchbox.ai/api/storage/serve?path=...` |

### Required HTTP Headers
```http
POST /api/mcp/canvas HTTP/1.1
Host: scratchbox.ai
Content-Type: application/json
Accept: application/json, text/event-stream
x-internal-secret: <SESSION_SECRET>
x-internal-user-id: 1
x-scratchbox-workspace-id: 126
```

---

## 3. Image Generation Workflow (`ai.generate_images`)

Generating imagery through the Scratchbox MCP follows an asynchronous, durable job architecture:

```
[Antigravity / CLI Compiler]
            │
            ▼ 1. tools/call: ai.generate_images
┌──────────────────────────────────────┐
│  Scratchbox MCP Server               │
│  (https://scratchbox.ai/api/mcp)     │
└──────────────────────────────────────┘
            │
            ├─► Enqueues durable image task in Postgres
            ├─► Dispatches to Google Nano Banana Pro
            ▼
    Returns operationId
            │
            ▼ 2. Polling loop: tools/call: operation.get { operationId }
┌──────────────────────────────────────┐
│  Phase: "running" (5%)               │
│  Phase: "saving" (5%)                │
│  Phase: "completed" (terminal: true) │
└──────────────────────────────────────┘
            │
            ▼ 3. Output Resolution
┌──────────────────────────────────────┐
│  Public CDN URL:                     │
│  https://scratchbox.ai/api/storage/..│
└──────────────────────────────────────┘
            │
            ├─► Injected into PPTX slide shape
            ├─► Injected into 1920x1080 HTML deck
            └─► Uploaded & rendered in live Google Slides
```

### Supported Aspect Ratios
- `16:9` — Standard Widescreen (Hero Opener, Split Media)
- `21:9` — Anamorphic Cinematic Letterbox (Art Cards, Cinematic Beats)
- `1:1` — Square Assets (Character Portraits, Product Grids)
- `4:3` & `3:4` — Classic Formats
- `9:16` — Vertical Social Media / Mobile Staging
- `3:2` & `2:3` — 35mm Still Photography

---

## 4. Markdown Slide Directives

The `markdown-to-slides` compiler automatically detects Scratchbox imagery tags in markdown:

### Syntax 1: Markdown Image Tag with `scratchbox:<ratio>`
```markdown
## 01. THE REVEAL
![High-end luxury electric sedan on a dark rain-slicked highway at twilight, cinematic anamorphic photograph](scratchbox:16:9)

- Next-generation Scandinavian styling
- Deep blue neon highlights across aerodynamic contours
```

### Syntax 2: HTML Comment Directive
```markdown
## 02. COCKPIT TELEMETRY
<!-- scratchbox: prompt="Close-up of minimalist electric vehicle dashboard, matte carbon fiber and glowing sapphire blue HUD display", aspect="21:9" -->

- Tactile Scandinavian walnut and recycled wool
- Projected heads-up telemetry
```

### Syntax 3: Automated Synthesis (`--scratchbox-images`)
Run the CLI compiler with `--scratchbox-images`:
```bash
node scripts/md_to_slides_compiler.mjs presentation.md --scratchbox-images --workspace 126 --html --upload-drive
```
Any visual slide archetype (`hero-opener`, `art-card`, `anamorphic-letterbox`) lacking an explicit image will automatically have an editorial prompt synthesized from its title and subtitle, dispatched to Scratchbox MCP, rendered, and inserted.

---

## 5. Verification & Invariants

1. **Public Reachability**: All generated images are stored in Google Cloud Storage and routed through the Scratchbox caching layer (`https://scratchbox.ai/api/storage/serve?...`). They are directly embeddable by Google Slides API without requiring local multipart file upload.
2. **Deterministic Workspace Anchoring**: Every generated visual is registered as a durable node on the canvas inside the selected workspace (default `126`), guaranteeing visual traceability and asset reuse.
3. **Lossless Aspect Ratios**: Aspect ratio metadata is preserved and passed to `pptxgenjs` and `html_slides_engine.mjs` ensuring zero distortion or letterbox stretching.
