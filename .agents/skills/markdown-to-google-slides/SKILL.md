---
name: markdown-to-google-slides
description: >-
  Master Presentation Architect and Presentation Producer converting any Markdown (.md) document, director's treatment, project pitch, or creative brief into visually stunning, brand-native presentations. ACTIVATE this skill whenever the user wants to convert, export, transform, or output a Markdown file, treatment, brief, or proposal to Google Slides, PPTX, or an interactive web presentation deck. Incorporates core architectural invariants from Anthropic's PPTX skill, frontend-slides (fixed 1920x1080 stage), and presentation-creator (active assertion headlines, card container chunking, anti-prose rules). Supports dual-engine output: (1) pixel-perfect standalone 16:9 HTML presentations with keyboard navigation, and (2) native widescreen Google Slides / PPTX decks with public write access.
---

# Presentation Architecture & Google Slides Skill
### Powered by Card Container Geometry, Dual-Engine Output & Brand Color Synthesis

> *"A great slide presentation does not look like bullet points dumped on a template. It feels like an art-directed editorial magazine: every frame is anchored in authentic brand DNA, paced with cinematic rhythm, balanced with generous negative space, and structured into scannable visual cards rather than walls of prose."*

---

## 1. Core Architectural Invariants

This skill translates raw Markdown content into high-end, pitch-winning presentation decks. It resolves the classic AI presentation footguns identified across the ecosystem:

1. **Widescreen & Ultrawide Stage Formats (16:9 Default, 21:9 Preferred)**:
   - **16:9 Widescreen (Default)**: In PPTX generation, use `LAYOUT_WIDE` (`13.333" × 7.5"`), **NEVER** `LAYOUT_16x9` (which creates a compact `10.0" × 5.625"` canvas causing coordinate overflow). In HTML, use fixed `1920×1080`.
   - **21:9 Ultrawide (Preferred Cinematic)**: Set `--ratio 21:9` or frontmatter `ratio: 21:9`. In PPTX generation, defines `LAYOUT_21x9` (`17.778" × 7.5"`). In HTML, uses fixed `2560×1080` stage with auto-scaling. Provides expansive cinematic stage for asymmetric magazine layouts.
2. **The Image-Text Separation Invariant (Two Distinct Layers)**:
   - **Images are NOT where you generate words**: AI image generation (Scratchbox MCP or native) must create pure photography, 3D renders, or visual art with **ZERO burned-in text, typography, logos, or captions**.
   - **Words are laid out WITH images**: Typography lives as sharp, selectable, structured vector text in PPTX / HTML. Images and words are two separate, deliberate layers that work together through grid composition, negative space, and visual hierarchy.
3. **Card Container Architecture (The Anti-Prose Invariant)**:
   - Raw multi-paragraph prose must **NEVER** be dumped into a single giant text box.
   - Long sections must be decomposed into **2 to 3 structured visual cards** (`title`, `badge`, `takeaway`, `body`) with subtle background fills and hairline borders.
   - If content exceeds density limits, **split it across continuation slides**.
4. **Active Assertion Headlines**:
   - Every slide title must state an active assertion (the core takeaway), never a passive category noun or filename leak (`directors_treatment`).
5. **Hex Color Formatting**:
   - PptxGenJS hex colors must **NEVER** include `#` and never include alpha bytes (`"07111E"`, not `"#07111E"`).
6. **Zero Margin Text Framing**:
   - Always set `margin: 0` on text frames aligning with shapes or cards to prevent accidental coordinate drift.
7. **Dual-Engine Output**:
   - **Engine 1: Native Fixed Web Presentation** (`.html`): 16:9 (`1920×1080`) or 21:9 (`2560×1080`) zero-dependency, responsive, keyboard-navigable (`←`/`→`/Space/F).
   - **Engine 2: Native Google Slides / PPTX Deck** (`.pptx`): Editable shapes, tables, and typography uploaded to Google Drive with automated public edit permissions.

---

## 2. Mandatory Brand Color Scheme Protocol

> **CRITICAL INVARIANT**: The color scheme must be determined directly from the brand associated with the brief or project. Never use arbitrary colors.

Scour the input document, creative brief, or project description using this 3-tier cascade (see [Brand Palette Extraction Guide](./references/brand_palette_guide.md)):

```
┌────────────────────────────────────────────────────────┐
│ Tier 1: Explicit Codes in Creative Brief / Frontmatter │
│ • Extract exact HEX / Pantone values declared          │
└──────────────────────────┬─────────────────────────────┘
                           │ (if absent)
                           ▼
┌────────────────────────────────────────────────────────┐
│ Tier 2: Named Commercial Brand Knowledge               │
│ • Apply canonical identity (Chase, Knicks, Apple, Nike)│
└──────────────────────────┬─────────────────────────────┘
                           │ (if fictional / unlisted)
                           ▼
┌────────────────────────────────────────────────────────┐
│ Tier 3: Category Psychological Archetype               │
│ • Synthesize cohesive palette from brand ethos/tone    │
└────────────────────────────────────────────────────────┘
```

### The 6 Required Brand Tokens:
- `slideBg`: Canvas base color (Dark Slate variant for cinema/pitches, Crisp Light variant for business reviews).
- `cardBg`: Elevated card container fill (8–12% lighter than `slideBg`).
- `cardBorder`: Subtle container stroke (`1E293B` or 15% white).
- `titleColor`: High-contrast headline color (`4.5:1` min contrast).
- `subtitleColor`: Secondary brand tint or 60% muted tone.
- `textColor`: Body readability color (`7:1` min contrast against `slideBg`).
- `accentColor`: Primary brand hero punch color (used for accent bars, callout kickers).
- `secondaryAccent`: Sub-brand color (used for badges, category pills).

---

## 3. Mandatory Imagery Synthesis Protocol (Scratchbox Canvas MCP)

> **CRITICAL INVARIANT**: To create imagery for presentations, treatments, and pitch decks, you must use the **Scratchbox Canvas MCP** from `scratchbox.ai` (`https://scratchbox.ai/api/mcp/canvas`).

All photorealistic hero openers, cinematic anamorphic letterbox stills, previs frames, and moodboard assets are generated by delegating to the Scratchbox Canvas MCP server via Google Nano Banana Pro (`google/nano-banana-pro`):

1. **MCP Server Integration**:
   - Registered in `~/.gemini/config/mcp_config.json` under `"scratchbox"`.
   - Bridges to `https://scratchbox.ai/api/mcp/canvas` via `/Users/eligreen/.gemini/config/scripts/scratchbox_mcp_bridge.mjs`.
   - Durable asynchronous jobs are enqueued (`ai.generate_images`), polled via `operation.get`, and resolved to live, publicly accessible CDN assets (`https://scratchbox.ai/api/storage/serve?path=...`).
2. **Markdown Directives**:
   - **Inline Image Tag**: `![Cinematic visual prompt](scratchbox:16:9)` or `![Prompt](scratchbox:21:9)`.
   - **HTML Comment Directive**: `<!-- scratchbox: prompt="Close-up of...", aspect="21:9" -->`.
   - **Automated Synthesis Flag**: `--scratchbox-images` automatically synthesizes contextual, photorealistic prompts from slide headers for visual archetypes (`hero-opener`, `art-card`, `anamorphic-letterbox`, `image-forward`).
3. **Cinematic Realism & Optical Directives**:
   - Focus exclusively on the **Google foundation model family** (**Nano Banana Pro / Nano Banana 2** for 4K stills and **Google Veo 2 / Veo 3 / Veo 3.1** for video) executed via Scratchbox AI MCP (`scratchbox.ai`).
   - Anchor prompt directives in physical cinema glass (Cooke S4/i, Panavision C-Series, ARRI Master Primes).
   - Specify film stock emulsion characteristics (Kodak Vision3 500T, Portra 400 grain, 35mm / 65mm format).
   - **Micro-Motion Blur Shutter Invariant**: Enforce 1/48s cinema shutter speed with motivated micro-motion blur (`shutter_angle: 180`, `motion_blur: 0.06`) to soften artificial digital edge sharpness and ground frames in authentic optical physics.
4. **Mandatory 4K Resolution & Zero-Text Invariants**:
   - **Always 4K Resolution**: All slide and layout imagery must be produced in 4K UHD (`3840×2160` for 16:9, or `3840×1620` for 21:9 ultrawide) to guarantee razor-sharp optical clarity on Retina displays, 4K monitors, and presentation screens.
   - **Never Feature Text**: Generated imagery must **NEVER** contain rendered words, typography, letters, alphabet glyphs, brand names, or watermarks. Diffusion models hallucinate distorted characters; words are strictly reserved for the selectable vector typography layer.
5. **Negative Space & Typographic Coordination (The Planned Void)**:
   - All layout imagery must be staged in dialogue with the typographic column:
     - For left-column text (default 21:9 split): Subject is anchored on the **rightmost 35-40%**, leaving the left two-thirds as an expansive low-frequency void (quiet plaster, dark shadow pool, smooth misty water) for text breathing room.
     - For right-column text: Subject is anchored on the **leftmost 35-40%**, opening the void on the right.
     - **Inward Convergence**: Subject eyelines, body orientation, and architectural vanishing lines must point **INWARD towards the typography**, pulling the viewer's eye into the headline.
6. **Mandatory Section Relevance & Conceptual Exemplification (Visual Proof Over Ambient Wallpaper)**:
   - Images generated for any slide must **NEVER** be generic ambient wallpaper, decorative stock filler, or lazy category tropes (e.g., generic smiling businesspeople, glowing digital globe nodes, or random concrete blocks).
   - The visual must **actively exemplify, substantiate, and elevate the specific thesis or physical mechanism** argued in that exact section.
   - Ground the visual in **tangible physical evidence**: if discussing extreme thermal cycling, show a macro of heat pipes and micro-fin cooling under laser measurement; if discussing artisanal leather, show hand-stitched bridle leather with bone folders and awl marks; if discussing real-time rendering, show a color-calibrated studio monitor displaying wireframe density with zero motion drag.
7. **Public CDN Ingestion**:
   - The resolved CDN URLs are directly ingested by the Google Slides API (`addImage({ path: url })`) and the 1920×1080 / 2560×1080 HTML presentation engine without requiring local file upload steps.

---

## 4. Structural Parsing & Semantic Chunking

When ingesting a `.md` file:

1. **Slide Separation**:
   - Segments divided by `---` map to individual slides.
2. **Heading & Title Extraction**:
   - Lines with `#`, `##`, `###`, or `####` map to slide titles and subtitles.
   - If a slide lacks an explicit title, synthesize an active assertion headline from the opening sentence or bullet point.
   - **Forbidden**: Never use the document's filename (`directors_treatment`) as a slide title.
3. **Card Decomposition**:
   - Text-heavy sections without images are classified as `cards-executive`. Paragraphs are mapped to 2 or 3 distinct side-by-side cards (`THE ATMOSPHERE`, `THE CELEBRATION`, `THE PAYOFF`).
4. **Speaker Notes**:
   - HTML comments (`<!-- ... -->`) are parsed and assigned to `slide.addNotes()`.

---

## 5. The 12 Layout Archetypes

Match each slide to the optimal archetype from [Layout Templates](./references/layout_templates.md) and [The Deck Commandments](./references/deck_commandments_layout_guide.md):

| Archetype | Layout Geometry | Ideal Content |
| :--- | :--- | :--- |
| **`hero-opener`** | Full-bleed 16:9 hero image + dark gradient scrim + bold title/subtitle + agency metadata | Title decks, keynote openers, high-impact hooks |
| **`section-divider`** | Minimalist dark canvas + brand accent bar + large tracked uppercase headline | Chapter breaks, act pivots, category transitions |
| **`art-card`** | Full obsidian negative space + massive ultra-condensed title (48–64pt) + anchor underline | Single-minded axioms, bold commandments, "VS." comparison cards |
| **`quote-centered`** | Giant decorative quotation marks (`“` `”`) + centered geometric sans quote + attribution | Foundational philosophy, client quotes, director beliefs |
| **`anamorphic-letterbox`** | 2.39:1 scope frame centered on 16:9 canvas with black letterbox bands + uppercase pull quote | Filmic mood statements, atmospheric keyframes |
| **`recap-card-grid`** | Symmetrical grid of clean, solid white container cards on obsidian canvas + bold uppercase copy | Rule summaries, deck commandments, executive synthesis |
| **`cards-executive`** | Section kicker + assertion title + 2 or 3 side-by-side elevated visual cards | Narrative prose, director's statements, strategy briefs |
| **`image-forward`** | Left card column (title + bullets) + right dominant framed image card | Core narrative beats, animatics, product highlights |
| **`text-left-images-right`**| Left card column + right 2-up or 4-up companion grid in rounded frames | Kinematic viewports, multi-shot breakdowns |
| **`curated-grid`** | 2×2 or 1×2 image moodboard with uniform gutters and captions | Storyboard progressions, texture spreads |
| **`composite`** | Balanced split with native editable table or structured deliverables | Timing tables, budget tables, technical specs |
| **`full-bleed-text-overlay`**| Full-bleed cinematic photo + subtle bottom scrim + bold pull quote | Emotional punchlines, closing quotes |

---

## 6. Dual-Engine Generation & Delivery

### Option A: Live Google Slides Presentation (Automated Drive Conversion)
```bash
node /Users/eligreen/.gemini/config/skills/markdown-to-google-slides/scripts/md_to_slides_compiler.mjs <input.md> --brand "<BrandName>" --chrome --scratchbox-images --upload-drive
```
1. Builds widescreen PPTX using `LAYOUT_WIDE` and card container geometry.
2. Supports `--scratchbox-images` to automatically synthesize and resolve photorealistic imagery via Scratchbox MCP (`scratchbox.ai`).
3. Supports `--chrome` for the Signature Editorial Chrome (top-left category eyebrow and bottom-right spelled-out page numbers: `ONE`, `TWO`, `TWENTY-FOUR`).
4. Uploads via Google Drive multipart API with `mimeType: application/vnd.google-apps.presentation`.
5. Sets public write permissions (`role: 'writer', type: 'anyone'`).
6. Outputs the live editable URL: `https://docs.google.com/presentation/d/{presentationId}/edit`.

### Option B: Interactive 1920×1080 HTML Web Presentation
```bash
node /Users/eligreen/.gemini/config/skills/markdown-to-google-slides/scripts/md_to_slides_compiler.mjs <input.md> --brand "<BrandName>" --scratchbox-images --html
```
1. Generates a standalone, zero-dependency `presentation.html` with full 16:9 stage scaling.
2. Includes floating navigation pill (`◀`, `▶`, `1/20`, `⛶`), keyboard listeners (`ArrowRight`, `Space`, `F`), and print-to-PDF styles.
3. Automatically embeds GIFs, animations, and high-res imagery.

---

## 7. References & Tooling

- [`references/scratchbox_mcp_guide.md`](./references/scratchbox_mcp_guide.md) — Scratchbox Canvas MCP architecture, tools, and endpoints.
- [`references/deck_commandments_layout_guide.md`](./references/deck_commandments_layout_guide.md) — The 10 Deck Commandments from *The Art of Deck Making*.
- [`references/pptx_engine_invariants.md`](./references/pptx_engine_invariants.md) — Technical footguns and OOXML rules.
- [`references/content_density_and_story_spine.md`](./references/content_density_and_story_spine.md) — Active assertion headlines and card chunking.
- [`references/brand_palette_guide.md`](./references/brand_palette_guide.md) — Brand identity extraction guide.
- [`references/layout_templates.md`](./references/layout_templates.md) — Visual geometry tokens.
- [`scripts/md_to_slides_compiler.mjs`](./scripts/md_to_slides_compiler.mjs) — Complete compiler CLI.
- [`scripts/html_slides_engine.mjs`](./scripts/html_slides_engine.mjs) — Fixed-stage HTML engine.
- [`/Users/eligreen/.gemini/config/scripts/scratchbox_mcp_bridge.mjs`](/Users/eligreen/.gemini/config/scripts/scratchbox_mcp_bridge.mjs) — Antigravity stdio MCP bridge to `scratchbox.ai`.
