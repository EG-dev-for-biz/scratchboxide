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
   - **Inline Image Tag**: `![Cinematic visual prompt](scratchbox:21:9)` (default) or `![Prompt](scratchbox:16:9)`.
   - **HTML Comment Directive**: `<!-- scratchbox: prompt="Close-up of...", aspect="21:9" -->`.
   - **Automated Synthesis Flag**: `--scratchbox-images` automatically synthesizes contextual, photorealistic prompts from slide headers in **21:9 anamorphic format** (`hero-opener`, `art-card`, `anamorphic-letterbox`, `image-forward`).
3. **Cinematic Realism & Optical Directives**:
   - Focus exclusively on the **Google foundation model family** (**Nano Banana Pro / Nano Banana 2** for 4K stills and **Google Veo 2 / Veo 3 / Veo 3.1** for video) executed via Scratchbox AI MCP (`scratchbox.ai`).
   - Anchor prompt directives in physical cinema glass (Cooke S4/i, Panavision C-Series, ARRI Master Primes).
   - Specify film stock emulsion characteristics (Kodak Vision3 500T, Portra 400 grain, 35mm / 65mm format).
   - **Micro-Motion Blur Shutter Invariant**: Enforce 1/48s cinema shutter speed with motivated micro-motion blur (`shutter_angle: 180`, `motion_blur: 0.06`) to soften artificial digital edge sharpness and ground frames in authentic optical physics.
4. **Mandatory 21:9 4K Ultrawide Resolution & Zero-Text Invariants**:
   - **Default 21:9 4K Ultrawide Resolution**: All slide and layout imagery defaults to **4K Ultrawide (3840×1620, 21:9 anamorphic aspect ratio)** to match the ultrawide presentation canvas edge-to-edge. (Legacy 16:9 standard is available via explicit `--ratio 16:9` at `3840×2160`).
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
8. **Contemporary Editorial Font Pairings & Structural Friction**:
   - Reject obsolete 2012 corporate defaults (*Helvetica + Georgia*, *Roboto + Open Sans*, *Montserrat + Playfair*).
   - Enforce high-character structural tension between precision-engineered Swiss neo-grotesks and liquid/architectural display faces:
     - *High-Fashion & Culture*: **Bodoni Moda** (Italic, Light display) + **Plus Jakarta Sans** (Reading body).
     - *Brutalist Scale-Contrast*: **Syne** (Monolithic architectural wide display) + **Source Serif 4** (Scholarly body).
     - *Intellectual / Editorial*: **DM Sans** (Modernist grotesque) + **Newsreader** (Lush literary serif).
     - *Technical Vanguard*: **Instrument Sans** (Industrial grotesque) + **JetBrains Mono** (Precision folios).
   - **Micro-Typographic Invariants**: Tight negative tracking on display headlines (`-0.03em` to `-0.05em`), wide positive tracking on kickers/folios (`+0.15em` to `+0.25em`), and treated display italics.
9. **Complex Full-Bleed Layouts & Asymmetric Scrim Architecture**:
   - Full-bleed imagery is the entire physical environment, not a framed picture in a box.
   - **Prohibition of the Muddy Scrim**: Never drop a uniform 50% black box across a 4K photograph. It kills optical dynamic range and turns 4K optics into grey sludge.
   - **Asymmetric Directional Scrims**: Apply a 1D gradient starting at 35–45% deep brand tint only across the margin edge behind the copy, fading to 0% by the 45% mark of the slide. 55%+ of the photograph remains completely pristine with true specular highlights and deep blacks.
   - **Frosted Glassmorphic Datum Shelves**: When complex cards, tables, or multi-paragraph blocks overlay full-bleed imagery, use physical frosted planes (`rgba(15, 20, 30, 0.65)`, `backdrop-filter: blur(24px) saturate(180%)`, `border: 1px solid rgba(255, 255, 255, 0.12)`).
   - **The Datum Line & Convergence**: Lock typography to an architectural horizontal or vertical datum. Converge subject gaze and light vectors inward toward the copy.
10. **The Anti-Dashboard Mandate & Fluid Editorial Architecture**:
    - **Never Box Every Element**: Reject the reflexive urge to enclose every paragraph and image in floating rounded cards (`addCardContainer`, 1px borders, rounded bezels). This produces a SaaS software dashboard / web app wireframe aesthetic that destroys high-end editorial gravitas.
    - **Canvas-Level Typography**: In editorial and image-forward slides, typography floats directly on the slide canvas, anchored by generous asymmetric margins (0.9" to 1.2") and typographic baseline grids—unencumbered by enclosing card boxes.
    - **Borderless Image Plates**: Images should bleed edge-to-edge, dock flush to screen boundaries, or sit as pristine borderless plates without decorative container bezels.
11. **Prohibition of Hard-Edged Geometric Scrims & Clean Void Framing**:
    - **Zero Solid Box Overlays**: Never place a flat, solid, or semi-transparent rectangular polygon with a hard 90° boundary over an image subject. In PowerPoint / Google Slides where true CSS-style alpha gradients are not natively supported as vector primitives, a flat rectangle creates an accidental split-screen defect that cuts arbitrarily through faces and subjects.
    - **The Two Approved Solutions**:
      1. *Natural Planned Void*: Direct the generative model to stage natural dark low-frequency shadows on the text side, allowing white vector typography to sit directly on the photo with zero overlay boxes.
      2. *Architectural Spatial Split*: Dock the 4K photograph to the right 50%–60% of the widescreen canvas as a clean photographic column, placing all typography on the solid canvas background to the left.
12. **Zero Synthetic Boilerplate & Payload-Driven Topology**:
    - **The Elimination of Dummy Specs**: Never inject unprompted, hardcoded dummy metadata cards (e.g. "TECHNICAL PREVIS SPECIFICATIONS", fake frame rates, or fabricated rig specs) to artificially balance white space.
    - **Adaptive Spatial Weight**: When a slide has only body copy and an image, scale the image up to command the full height of the viewport rather than fabricating placeholder cards to occupy space.
13. **Strict Chromatic Hierarchy & Two-Tone Restraint**:
    - **Anti-Confetti Discipline**: Restrict active slide hues to a disciplined two-tone system: Canvas Base (Deep Dark or Bone White) + Monolithic Typography (Pure White / Off-Black) + **exactly ONE intentional Accent hue** (used strictly for 1 element type, e.g. kickers or folios).
    - **Forbidden**: Never mix competing neon and primary hues (e.g. mustard yellow kickers, lime green subtitles, and electric blue card headers on a single slide). Subtitles must use a muted tint of the primary text color (e.g., `#94A3B8` Slate-400), not an uncoordinated neon secondary accent.
14. **Dynamic Typographic Equilibrium & Asymmetric Balance**:
    - When placing multi-column content, dynamically scale column proportions and font sizes to content volume.
    - Never place a 2-line blurb in an expansive 50% width container next to a dense 10-line bullet column with 75% dead blue space. Structure columns proportionally (e.g., 35/65 split) or collapse sparse content into an asymmetric, unboxed editorial pull-quote.
15. **The Full-Bleed Photographic Slab (`image-forward`)**:
    - **Never Float Postcards**: Reject the "floating postcard" defect where a 16:9 photo floats centered with dead margins around it, marooned like a stamp.
    - **Flush Perimeter Docking**: Dock split photographic plates flush to the top, bottom, and right edges (`x: slideW * 0.44`, `w: slideW * 0.56`, `y: 0`, `h: slideH`, `sizing: { type: 'cover' }`). This allows low-frequency atmospheric voids (mist, shadow, concrete grain) to dissolve seamlessly into the canvas.
16. **Purge the Decorative Underline "Toothpick"**:
    - **Zero Dated PowerPoint Decorators**: Never place 0.8" colored rectangle lines (`0.035"` height) beneath subtitles or titles. High-end art direction relies on pure whitespace, font weight contrast, and baseline alignment—not colored line widgets.
17. **Strict Monochromatic Subtitle Discipline (Neon Elimination)**:
    - **Neutral Titanium/Slate Invariant**: Subtitle colors must never be derived from chromatic wheel offsets (such as split-complementary +30° shifts that mutate Swedish gold into neon lime-green). Subtitles must always remain neutral Slate-400 (`#94A3B8`) or Slate-500 (`#64748B`).
18. **Isolated Canvas Folio Boundary (Zero Photo Collision)**:
    - **Cover Slide Suppression**: Never render running footers or page numbers on the `hero-opener` cover slide.
    - **Column-Confined Folio**: On split layouts (`image-forward`), confine the running footer strictly to the left typography column (`x: padIn`, `w: leftColW`, `align: left`). A running folio must NEVER print across or stamp numbers over photography.
19. **Monumental Pull-Quote Manifesto & Structured Datum Shelves (`cards-executive`)**:
    - **Command the Cavern**: When a slide pairs a single core concept sentence on the left with bullet points on the right, scale the sentence from 13.5pt to a **22pt–26pt monumental display pull-quote** (in italic serif) to anchor the column and eliminate the 8-inch cavern of dead space.
    - **Numbered Datum Shelves**: Structure dense execution points with uppercase sequence tags (`01 // CORE CONCEPT`, `02 // THE PLANNED VOID`) rather than loose generic bullets.
20. **Orthogonal Reference Decoupling (The Anti-Cloning Engine)**:
    - **Anti-Template Invariant**: Never borrow an entire website or deck template's personality. Decompose visual taste into 4 independent axes: `[Spatial Layout] × [Typographic Tension] × [Material Chromatics] × [Micro-Interaction Craft]`.
    - **Cross-Domain Cross-Breeding**: Synthesize original visual languages by sampling distinct domains (e.g., Swiss architectural spatial grids from *Siteinspire*, editorial serif friction from *Fonts in Use*, physical material palettes from *Picular*, and datum telemetry shelves from *Mobbin*).
21. **Role-Based Chromatic Staging (The 60-30-8-2 Invariant)**:
    - **Spatial Color Discipline**: Allocate palette colors strictly by surface ratio: **60% Canvas Base** (Deep Carbon Obsidian `#07090E` or Warm Bone Paper `#F6F4EE`), **30% Primary Specular Typography** (Pure White `#FFFFFF` or Deep Sumi Ink `#181C24`), **8% Neutral Titanium/Slate** (`#94A3B8` Slate-400 / `#64748B` Slate-500 for subtitles and borders), and **2% Singular Motivated Accent** (Swedish Gold `#E5A93C`, Cobalt `#002FA7`, or Signal Red `#FF3B30` for micro-kickers and datum lines).
22. **Polar Tracking Calibration & Mathematical Modular Scales**:
    - **Optical Mass Balance**: Large display headers ($\ge 40\text{pt}$) require tight negative tracking (`-0.03em` to `-0.05em`); micro-metadata ($\le 10\text{pt}$) requires wide positive tracking (`+0.15em` to `+0.25em`).
    - **Modular Scale Discipline**: Anchor font sizes to mathematical scales (Major Third $1.250$ or Perfect Fourth $1.333$): $10\text{px} \rightarrow 13\text{px} \rightarrow 17\text{px} \rightarrow 22\text{px} \rightarrow 28\text{px} \rightarrow 36\text{px} \rightarrow 48\text{px} \rightarrow 64\text{px}$.
23. **Organic Low-Frequency Continuation Over Pure Black Voids**:
    - **No Digital Cutoff Voids**: Negative space in a photograph must NEVER be an artificial pure black (`#000000`) or flat graphic crop box. Pure black blocks look like graphical masks rather than authentic photography.
    - **Living Scene Continuity**: Negative space must be a calm, unbusy continuation of the physical scene—e.g. atmospheric mist, soft out-of-focus wet pavement, shallow depth-of-field background blur, or concrete walls rolling off into soft shadow.
24. **Tactile Optical Realism (The 5 Imperfections Engine)**:
    - Eliminate sterile AI plastic sheen by intentionally directing 5 physical optical phenomena:
      1. **Subtle Motion Blur**: Minute shutter drag (1/48s cinematic motion blur) softening sharp digital edges.
      2. **Tiniest Desaturation**: Pull back synthetic, hyper-vibrant saturation into natural film stock hues.
      3. **Chromatic Lens Distortion**: Subtle peripheral optical aberration and barrel softness characteristic of vintage cinema glass.
      4. **Muddy / Lifted Blacks**: Real optical toe with atmospheric flare and tactile charcoal/slate values (never digital crushed #000000).
      5. **Authentic Silver Halide Grain**: Fine physical film grain across the frame to establish organic material familiarity.
25. **Default 21:9 Ultrawide Scope & True Full-Bleed Spatial Canvas Invariant**:
    - **Default 21:9 Ultrawide Architecture**: Presentations default to **21:9 Ultrawide Scope** (`17.778" \times 7.5"` in PPTX, `2560\times1080` in HTML).
    - **21:9 Native Full-Bleed Imagery**: All intended full-bleed imagery must be synthesized and rendered in native **21:9 anamorphic format (3840×1620)** so it spans the canvas edge-to-edge (`x: 0, y: 0, w: 100%, h: 100%`) without letterboxing, vertical clipping, or distortion. Never slice photography into artificial split boxes with flat digital voids.
    - **Directional Optical Scrim**: Laying out text directly over full bleed requires a soft, non-linear directional scrim (e.g. 94% opacity falloff to 0% across 62% width on 21:9). This guarantees 100% WCAG AAA copy legibility without crushing the focal subject or creating artificial graphic dividers.
    - **Zero Synthetic Hairlines**: Ban artificial vertical dividing lines (`width: 1`) cutting between text and photography.
26. **Optical Typography Craft Engine: Kerning, Tracking, Vertical Leading & Purity**:
    - **Architectural Kicker-to-Title Gap**: Maintain an intentional 0.16"–0.24" (12pt–17pt) vertical buffer between the kicker and the headline. Ascenders must never touch or crowd the kicker.
    - **Sculptural Display Tracking & Leading**: Display headlines ($\ge 24\text{pt}$, especially Bodoni Moda italic) require tight negative tracking (`-1.0` to `-1.5pt` / `-0.025em` to `-0.04em`) to condense optical mass, paired with tight, sculptural leading (`lineSpacingMultiple: 1.05`–`1.08`).
    - **Immediate Subtitle Harmonic Proximity**: Anchor subtitles 0.14"–0.24" below the title, with line length constrained to $\le 55$ characters per line (`w: 5.5"`) and relaxed reading leading (`1.35`–`1.40`).
    - **Subtraction of Decorative Clutter**: Purge all decorative underline rectangles beneath eyebrows and page numbers. Metadata footers must be formatted as single unbroken horizontal lines with spaced bullets (` • `) and wide tracking, with zero horizontal hairline rules. Suppress all chrome on cover slides.
27. **Concept-Driven Visual Derivation Invariant (The Anti-Literalism Engine)**:
    - Never select colors, fonts, or layouts via semantic literalism (e.g. finance = blue, sustainability = green, luxury = gold).
    - Always execute the 4 Narrative Probes before designing: (1) Ideological & emotional friction, (2) Physical sensory environment under light, (3) Vocal acoustic persona, and (4) Physical subject matter materials.
    - Colors must be extracted from physical substances (60-30-8-2 rule) existing in that sensory world. Typography must be cast like actors across a 3-layer model (Display Persona + Invisible Reading Grotesk + Monospace Architectural Datum). Negative space must be directed as an organic scene continuation rather than an artificial graphical mask.
28. **Grid System Selection & Typographic Tone Taxonomy Invariant**:
    - Layout mathematics must embody the narrative's psychological posture. Evaluate the 3 axes: Cognitive Density (sparse vs. dense), Cognitive Tempo (slow/cinematic vs. fast/forensic), and Institutional Posture (sovereign, rational, or subversive).
    - Map directly to the 5 Master Grid Architectures: Monolithic Axial Void ($M_p \ge 10\%-14\%$), Asymmetric Editorial Duo ($38/62$ split), Swiss Compound Modular (6/12 columns with universal hangline $y = 24\%$), High-Density Telemetry Matrix (8/16 columns with horizontal monospace datum shelves), or Brutalist Collision (deliberate scale rupture).
29. **Spatial Frequency Occlusion, Magazine Editorial Dynamics & Controlled Rule-Breaking Invariant**:
    - *Spatial Frequency Decoupling*: Direct photography so high-frequency focal subjects anchor strictly on the right 35% flank, reserving the left 65% for calm low-frequency atmosphere.
    - *Directional Optical Scrim*: Protect typography with an asymmetric cubic falloff scrim ($mid_1 = 0.26, cutoff = 0.62$, 94% opacity falloff), leaving $>60\%$ of the photograph unshadowed and pristine.
    - *Magazine Editorial Tension*: Enforce a 10:1 scalar ratio between monumental display headlines ($48\text{pt}–80\text{pt}$, negative tracking) and micro-metadata ($8\text{pt}–9\text{pt}$, wide positive tracking). Purge bullet points for structured datum shelves (`01 //`, `02 //`).
    - *Controlled Rule-Breaking*: Allow exactly one calculated rupture per spread (Margin Overflow, Scale Collision, 90° Rotated Vertical Spine, or Depth-Layer Occlusion) while keeping 85% of the layout locked to the underlying grid.
30. **The 6-Step Unique Layout Conception Methodology**:
    - Reject the first three layout ideas ("No. That's the obvious version").
    - Execute the 6 steps sequentially: (1) Subtractive Purge of cards/boxes/icons, (2) 3 Lateral Probes, (3) Master Grid Selection, (4) Living Photographic Continuation with the 5 optical imperfections, (5) Directional Scrim & Polar Typography, and (6) The 17-Gate Art Director Critique.
31. **Master Creative Combinations: Typography, Material Chromatics & Editorial Topologies Invariant**:
    - Deeply study and apply the comprehensive taxonomy codified in [`references/creative_palette_study_text_color_layout.md`](./references/creative_palette_study_text_color_layout.md).
    - **13 Master Typographic Pairings**: Never default lazily to a generic corporate sans. Select explicitly from the 13 codified pairings: `high-fashion` (Bodoni Moda italic + Plus Jakarta Sans + JetBrains Mono), `brutalist-scale` (Syne 900 + Source Serif 4 + Space Mono), `intellectual-editorial` (Newsreader + Plus Jakarta Sans + JetBrains Mono), `swiss-rationalist` (Instrument Sans + Instrument Sans + JetBrains Mono), `aerospace-telemetry` (Chakra Petch + Plus Jakarta Sans + JetBrains Mono), `compressed-poster` (Oswald + Plus Jakarta Sans + Space Mono), `neoclassical-monumental` (Cinzel + EB Garamond + JetBrains Mono), `contemporary-humanist` (Fraunces + Albert Sans + JetBrains Mono), `retro-futurist-slab` (BioRhyme + Work Sans + JetBrains Mono), `avant-garde-liquid` (Clash Display + Plus Jakarta Sans + JetBrains Mono), `forensic-dispatch` (Source Serif 4 + Plus Jakarta Sans + JetBrains Mono), `architectural-reduction` (Shippori Mincho + Plus Jakarta Sans Light + Space Mono), or `modern-grotesk`.
    - **12 Master Material Color Worlds (60-30-8-2 Rule)**: Ground colors in physical matter under lighting rather than synthetic web pickers: `nordic-amber` (basalt & amber), `kyoto-moss` (peat & smoked bronze), `cadmium-bone` (lacquer & plaster), `raw-linen` (unbleached rag & lampblack), `electric-cobalt` (carbon & laser blue), `scandi-celadon` (peat & eucalyptus), `travertine-sun` (limestone & terracotta), `berlin-sulfur` (bruised violet & zinc), `liquid-mercury` (titanium & mach cyan), `sonoran-dune` (creosote & adobe), `prussian-chalk` (archival rag & indigo), and `forge-iron` (iron scale & molten weld).
    - **10 Master Layout Archetypes**: Break monotonic rhythms by sequencing slides across dynamic topologies: Hero Void $\rightarrow$ Asymmetric Duo $\rightarrow$ Telemetry Matrix $\rightarrow$ Scale-Collision Rupture $\rightarrow$ Gallery Triptych $\rightarrow$ Sovereign Void $\rightarrow$ Bento Grid $\rightarrow$ Documentarian Contact Sheet $\rightarrow$ Diagonal Slit $\rightarrow$ Catalog Table.

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
| **`hero-opener`** | Full-bleed 21:9 ultrawide hero image + left directional optical scrim + bold title/subtitle + agency metadata | Title decks, keynote openers, high-impact hooks |
| **`section-divider`** | Minimalist dark canvas + brand accent bar + large tracked uppercase headline | Chapter breaks, act pivots, category transitions |
| **`art-card`** | Full obsidian negative space + massive ultra-condensed title (48–64pt) + anchor underline | Single-minded axioms, bold commandments, "VS." comparison cards |
| **`quote-centered`** | Giant decorative quotation marks (`“` `”`) + centered geometric sans quote + attribution | Foundational philosophy, client quotes, director beliefs |
| **`anamorphic-letterbox`** | 2.39:1 scope frame centered on 21:9 canvas with edge-to-edge cinematic presence + uppercase pull quote | Filmic mood statements, atmospheric keyframes |
| **`recap-card-grid`** | Symmetrical grid of clean, solid white container cards on obsidian canvas + bold uppercase copy | Rule summaries, deck commandments, executive synthesis |
| **`cards-executive`** | Section kicker + assertion title + 2 or 3 side-by-side elevated visual cards | Narrative prose, director's statements, strategy briefs |
| **`image-forward`** | Left text zone over low-frequency negative space (directional scrim) + right unshadowed photographic flank | Core narrative beats, animatics, product highlights |
| **`text-left-images-right`**| Left card column + right 2-up or 4-up companion grid in rounded frames | Kinematic viewports, multi-shot breakdowns |
| **`curated-grid`** | 2×2 or 1×2 image moodboard with uniform gutters and captions | Storyboard progressions, texture spreads |
| **`composite`** | Balanced split with native editable table or structured deliverables | Timing tables, budget tables, technical specs |
| **`full-bleed-text-overlay`**| Full-bleed 21:9 photo + subtle directional scrim + bold pull quote | Emotional punchlines, closing quotes |

---

## 6. Dual-Engine Generation & Delivery

### Option A: Live Google Slides Presentation (Automated Drive Conversion)
```bash
node /Users/eligreen/.gemini/config/skills/markdown-to-google-slides/scripts/md_to_slides_compiler.mjs <input.md> --brand "<BrandName>" --chrome --scratchbox-images --upload-drive
```
1. Builds 21:9 ultrawide PPTX using `LAYOUT_21x9` (`17.778" × 7.5"`), directional optical scrimming, and card container geometry. (Override with `--ratio 16:9` if 16:9 is specifically requested).
2. Supports `--scratchbox-images` to automatically synthesize and resolve 21:9 anamorphic 4K photorealistic imagery via Scratchbox MCP (`scratchbox.ai`).
3. Supports `--chrome` for the Signature Editorial Chrome (top-left category eyebrow and bottom-right spelled-out page numbers: `ONE`, `TWO`, `TWENTY-FOUR`).
4. Uploads via Google Drive multipart API with `mimeType: application/vnd.google-apps.presentation`.
5. Sets public write permissions (`role: 'writer', type: 'anyone'`).
6. Outputs the live editable URL: `https://docs.google.com/presentation/d/{presentationId}/edit`.

### Option B: Interactive 21:9 (2560×1080) HTML Web Presentation
```bash
node /Users/eligreen/.gemini/config/skills/markdown-to-google-slides/scripts/md_to_slides_compiler.mjs <input.md> --brand "<BrandName>" --scratchbox-images --html
```
1. Generates a standalone, zero-dependency `presentation.html` with fixed 21:9 stage scaling (`2560 × 1080`).
2. Includes floating navigation pill (`◀`, `▶`, `1/20`, `⛶`), keyboard listeners (`ArrowRight`, `Space`, `F`), and print-to-PDF styles.
3. Automatically embeds GIFs, animations, and high-res imagery.

---

## 7. References & Tooling

- [`references/how_to_conceive_unique_layouts.md`](./references/how_to_conceive_unique_layouts.md) — The 6-step operator's manual for conceiving and implementing truly unique, non-derivative layouts.
- [`references/creative_palette_study_text_color_layout.md`](./references/creative_palette_study_text_color_layout.md) — Comprehensive master study of 13 typographic pairings, 12 material color worlds, 10 advanced editorial topologies, and 3-axis synthesis matrix.
- [`references/concept_to_form_transduction.md`](./references/concept_to_form_transduction.md) — Deriving unique colors, typography, and spatial style from narrative friction and sensory worlds.
- [`references/grid_systems_and_tone_taxonomy.md`](./references/grid_systems_and_tone_taxonomy.md) — Grid system selection, cognitive density matching, universal hanglines, and tone taxonomy.
- [`references/advanced_editorial_and_rule_breaking_grids.md`](./references/advanced_editorial_and_rule_breaking_grids.md) — Spatial frequency occlusion mapping, high-fashion editorial dynamics, and controlled rule-breaking.
- [`references/scratchbox_mcp_guide.md`](./references/scratchbox_mcp_guide.md) — Scratchbox Canvas MCP architecture, tools, and endpoints.
- [`references/deck_commandments_layout_guide.md`](./references/deck_commandments_layout_guide.md) — The 10 Deck Commandments from *The Art of Deck Making*.
- [`references/orthogonal_design_synthesis_guide.md`](./references/orthogonal_design_synthesis_guide.md) — Orthogonal reference curation, cult layout heuristics, and the 4-axis synthesis matrix.
- [`references/pptx_engine_invariants.md`](./references/pptx_engine_invariants.md) — Technical footguns and OOXML rules.
- [`references/content_density_and_story_spine.md`](./references/content_density_and_story_spine.md) — Active assertion headlines and card chunking.
- [`references/brand_palette_guide.md`](./references/brand_palette_guide.md) — Brand identity extraction guide.
- [`references/layout_templates.md`](./references/layout_templates.md) — Visual geometry tokens.
- [`scripts/md_to_slides_compiler.mjs`](./scripts/md_to_slides_compiler.mjs) — Complete compiler CLI.
- [`scripts/html_slides_engine.mjs`](./scripts/html_slides_engine.mjs) — Fixed-stage HTML engine.
- [`/Users/eligreen/.gemini/config/scripts/scratchbox_mcp_bridge.mjs`](/Users/eligreen/.gemini/config/scripts/scratchbox_mcp_bridge.mjs) — Antigravity stdio MCP bridge to `scratchbox.ai`.
