# The Deck Commandments: Master Layout & Art Direction Guide

Adapted from *"The Art of Deck Making"* (Venables Bell & Partners / Commercial Treatment Masterclass).

This guide codifies the 10 Deck Commandments and the advanced layout geometry that separates amateur corporate slide shows from pitch-winning, cinematic director's decks.

---

## 1. The 10 Deck Commandments

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       THE 10 DECK COMMANDMENTS                              │
├────────────────────────────────┬────────────────────────────────────────────┤
│ 1. OPEN STRONG                 │ Full-bleed cinematic mood photography.     │
│ 2. USE VISUAL HIERARCHY        │ 1 visual focal point. Never crowd copy.    │
│ 3. BE PICKY WITH KEYFRAMES     │ Strict tonal continuity & shared lighting. │
│ 4. FIND HIGH-RES IMAGERY       │ Zero blur, pixelation, or low-DPI assets.  │
│ 5. VISUAL EMOTION >            │ Evoke feeling and subtext over literal/    │
│    VISUAL PRESCRIPTION         │ mechanical illustrations of the prompt.    │
│ 6. LABEL CLEARLY               │ Structured headers, metadata & breadcrumbs.│
│ 7. SWEAT THE SMALL STUFF       │ Generous margins, balanced rags, kerning.  │
│ 8. BREAK YOUR OWN RULES        │ Template serves the story, not vice versa. │
│ 9. EVERY DECK MATTERS          │ "A great deck is a love letter to ideas."  │
│ 10. KERN YOUR ART CARDS        │ Ultra-condensed display type with anchors. │
└────────────────────────────────┴────────────────────────────────────────────┘
```

---

## 2. Commandment Deep Dives & Operational Invariants

### Commandment 1: Open Strong
- **The Rule**: Slide 1 is not a title page; it is an emotional hook that establishes the world of the project.
- **The Violation**: A generic studio render, white catalog photo, or dry corporate title on blank canvas.
- **The Execution**: Full-bleed 16:9 or 2.39:1 anamorphic frame with rich ambient lighting (e.g. rain-streaked windshield at dusk with sodium vapor streetlights). Clean white branding centered, tracked uppercase subheader.

### Commandment 2: Use Visual Hierarchy
- **The Master Wireframe**:
  - **1 Visual Focal Point**: Every slide must have a single dominant hero element (whether a graphic, an image, or a massive title).
  - **Minimalist Copy**: Only include the necessary supporting copy that *cannot be voiced over*.
  - **Citation De-escalation**: Citations, data sources, and disclaimer notes must be treated as legal copy—small, muted, and pinned to the bottom margin so they never compete with the core message.
  - **Protected Margin Boundaries**: Keep an outer safe area (minimum 0.8" / 80pt) completely un-infringed.

### Commandment 3: Be Picky with Keyframes (Tonal Continuity)
- **The Rule**: When placing 2, 3, or 4 images on a single slide, they must feel like they were captured with the **same lens on the same day in the same movie**.
- **The Violation**: Mashing together a daylight stock photo of a brass doorknob, a studio packshot, a milky way night landscape, and a cold blue bedroom shot.
- **The Execution**: Enforce shared color temperature, matching grain/contrast, and logical spatial/chronological progression (e.g. blue dawn -> incandescent hallway -> torchlight -> moonlight barn).

### Commandment 4: Find 4K High-Res Imagery with Motivated Shutter Drag
- **The Rule**: High-DPI assets only (always targeting 4K UHD `3840×2160` or 4K Ultrawide `3840×1620`). Zero pixelation, digital sharpening artifacts, or compression blur.
- **The Motion Blur Invariant**: Use Scratchbox AI MCP settings (`shutter_angle: 180`, `motion_blur: 0.06`) to introduce subtle 1/48s cinema shutter micro-motion blur on camera drift and peripheral movement. This softens artificial digital edge sharpness and takes the harsh AI sheen off the frame.
- **Exclusivity**: Generated exclusively with the Google foundation model family (Nano Banana Pro / Nano Banana 2 and Google Veo).

### Commandment 5: Visual Emotion > Visual Prescription
- **The Philosophy**: Do not illustrate words literally. Illustrate the *emotional subtext* behind the words.
- **Example Comparison**:
  - *Prompt / Script Line*: `"open on a girl and her dog watching TV"`
  - *Visual Prescription (Amateur)*: A stock photo from behind a girl and a dog sitting on a couch staring directly at a television screen. Literal, flat, corporate.
  - *Visual Emotion (Master)*: An intimate, warm high-angle shot of the girl lying relaxed on a worn Persian rug beside her sleeping 100-pound dog, soft golden hour sunlight filtering through linen curtains. The television is heard off-camera; the visual captures intimacy, comfort, and peace.

### Commandment 5B: The Planned Void (Coordinating Text and Negative Space)
- **The Rule**: Never drop typography onto an arbitrary photo. The image must be intentionally staged with a **dedicated low-frequency negative space void** aligned to the text column.
  - **Left-Aligned Text**: Anchor the primary subject on the **rightmost 35-40%**, opening the left flank for the typographic monolith.
  - **Inward Eyelines**: Subject gaze and physical light vectors must point **inward toward the copy**, magnetically directing reader attention into the headline.
  - **Zero Burned-In Text**: All letters, titles, and folios belong exclusively to the vector typography layer.

### Commandment 5C: Section Relevance & Conceptual Exemplification (Visual Proof)
- **The Rule**: Images must **actively exemplify, substantiate, and elevate the specific argument or mechanism** of the section they are associated with.
- **The Violation**: Using an image as generic ambient decoration, visual filler, or an obvious stock cliché (e.g. an abstract skyscraper for finance, glowing nodes for technology, or a smiling businesswoman for teamwork).
- **The Execution**: Extract the section's core mechanism, tension, or human truth from the copy and construct its **observable physical proof**:
  - *If the section discusses high-performance computing*: Show an extreme macro of an extruded aluminum heatsink with sintered copper heatpipes undergoing thermal stress testing with faint convective air shimmer.
  - *If the section discusses artisanal bespoke luxury*: Show an artisan's calloused hands pulling waxed linen thread tight through double saddle stitching on vegetable-tanned bridle leather with bone folders on a weathered oak bench.
  - *If the section discusses brutalist architectural mass*: Show a monolithic board-formed concrete cantilever over a mirror-still dusk reflecting pool with raking interior tungsten light.
  - *If the section discusses automated warehouse robotics*: Show a low-angle shot of an AGV with scuffed bumpers accelerating through a floor matrix of high-speed tracking markers at 3:15 AM under industrial sodium lamps.

### Commandment 5D: Contemporary Editorial Font Pairings & Structural Friction
- **The Rule**: Reject obsolete 2012 corporate pairings (*Helvetica + Georgia*, *Roboto + Open Sans*, *Montserrat + Playfair*). Contemporary decks operate via **high-character structural tension** between precision-engineered Swiss grotesks and liquid, razor-sharp, or brutalist display faces.
- **The 4 Master Pairing Archetypes**:
  1. **High-Fashion & Culture**: *Bodoni Moda* (Italic, Light display) + *Plus Jakarta Sans* / *Inter* (Precision Swiss reading text).
  2. **Brutalist Scale-Contrast**: *Syne* / *Syncopate* (Monolithic architectural wide display) + *Source Serif 4* / *Playfair* (Tight scholarly body).
  3. **Intellectual / Editorial Warmth**: *DM Sans* / *Space Grotesk* (Modernist grotesque) + *Newsreader* / *Fraunces* (Lush literary serif).
  4. **Technical Vanguard**: *Instrument Sans* (Clean industrial grotesk) + *JetBrains Mono* / *Space Mono* (Precision metadata folios).
- **Micro-Typographic Invariants**:
  - **Tight Negative Display Tracking**: Headers (40pt–80pt) set with tight negative letter-spacing (`-0.03em` to `-0.05em` / `-1` to `-2pt`).
  - **Wide Positive Metadata Tracking**: Kickers, folios, and metadata set with wide letter-spacing (`+0.15em` to `+0.25em` / `+2` to `+4pt`).
  - **Treated Italics**: Treat heavy italic serifs as primary display items, not timid inline citations.

### Commandment 5E: Complex Full-Bleed Layouts & Asymmetric Scrim Architecture
- **The Rule**: Full-bleed imagery is the entire physical environment, not a framed picture in a box. Never destroy 4K dynamic range with a muddy, uniform 50% black scrim.
- **Asymmetric Directional Scrim**: Apply a 1-dimensional gradient starting at 35–45% deep brand tint only across the margin edge behind the copy, fading to 0% by the 45% mark of the slide width. 55%+ of the photograph remains completely pristine with true specular highlights and deep blacks.
- **Frosted Glassmorphic Datum Shelves**: When complex cards, tables, or multi-paragraph blocks overlay full-bleed imagery, use physical frosted planes (`rgba(15, 20, 30, 0.65)`, `backdrop-filter: blur(24px) saturate(180%)`, `border: 1px solid rgba(255, 255, 255, 0.12)`).
- **The Datum Line & Convergence**: Lock typography to an architectural horizontal or vertical datum. Converge subject gaze and light vectors inward toward the copy.

### Commandment 5F: Elimination of the Hard-Edged Geometric Cutline
- **The Rule**: Never drop a flat, solid, or semi-transparent rectangular polygon with a hard 90° boundary over an image subject. In PowerPoint / Google Slides where true CSS-style alpha gradients are not natively supported as vector primitives, a flat rectangle creates an accidental split-screen defect that cuts arbitrarily through faces and subjects.
- **The Two Approved Solutions**:
  1. *Natural Planned Void*: Direct the generative model to stage natural dark low-frequency shadows on the text side, allowing white vector typography to sit directly on the photo with zero overlay boxes.
  2. *Architectural Spatial Split*: Dock the 4K photograph to the right 50%–60% of the widescreen canvas as a clean photographic column, placing all typography on the solid canvas background to the left.

### Commandment 5G: Fluid Editorial Spreads vs. Boxy UI Dashboards
- **The Rule**: Reject the default reflex to enclose every text block and image inside a rounded floating card (`addCardContainer`, 1px borders, rounded bezels). This produces a SaaS software dashboard / web app wireframe aesthetic that destroys high-end editorial gravitas.
- **Canvas-Level Typography**: In editorial and image-forward slides, typography floats directly on the slide canvas, anchored by generous asymmetric margins (0.9" to 1.2") and typographic baseline grids—unencumbered by enclosing card boxes.
- **Borderless Image Plates**: Images should bleed edge-to-edge, dock flush to screen boundaries, or sit as pristine borderless plates without decorative container bezels.

### Commandment 5H: Zero Synthetic Boilerplate & Payload-Driven Topology
- **The Rule**: Never inject unprompted, hardcoded dummy metadata cards (e.g. "TECHNICAL PREVIS SPECIFICATIONS", fake frame rates, or fabricated rig specs) to artificially balance white space.
- **Adaptive Spatial Weight**: When a slide has only body copy and an image, scale the image up to command the full height of the viewport rather than fabricating placeholder cards to occupy space.

### Commandment 5I: Strict Chromatic Hierarchy & Two-Tone Restraint
- **The Rule**: Restrict active slide hues to a disciplined two-tone system: Canvas Base (Deep Dark or Bone White) + Monolithic Typography (Pure White / Off-Black) + **exactly ONE intentional Accent hue** (used strictly for 1 element type, e.g. kickers or folios).
- **Anti-Confetti Discipline**: Never mix competing neon and primary hues (e.g. mustard yellow kickers, lime green subtitles, and electric blue card headers on a single slide). Subtitles must use a muted tint of the primary text color (e.g., `#94A3B8` Slate-400), not an uncoordinated neon secondary accent.

### Commandment 5J: Dynamic Typographic Equilibrium & Asymmetric Balance
- **The Rule**: When placing multi-column content, dynamically scale column proportions and font sizes to content volume.
- **The Void Trap**: Never place a 2-line blurb in an expansive 50% width container next to a dense 10-line bullet column with 75% dead space. Structure columns proportionally (e.g., 35/65 split) or collapse sparse content into an asymmetric, unboxed editorial pull-quote.

### Commandment 5K: Full-Bleed Photographic Slabs vs. Floating Postcards
- **The Defect**: Centering a 16:9 photo in a half-screen box surrounded by 1.5" dead black margins isolates the visual as an amateur thumbnail or stamp.
- **The Standard**: Dock split photography flush to top, bottom, and right canvas perimeters (`x: 44%`, `w: 56%`, `y: 0`, `h: 100%`, `sizing: { type: 'cover' }`). Atmospheric shadows and environmental mist must bleed seamlessly into the dark presentation canvas.

### Commandment 5L: Purge the Decorative Underline "Toothpick"
- **The Defect**: Arbitrary 0.8" colored rectangle lines (`0.035"` height) placed beneath headers or subtitles act as dated 1990s PowerPoint clutter.
- **The Standard**: Elite art direction uses pure typographic contrast, baseline rhythm, and generous whitespace. Delete all underline toothpick bars.

### Commandment 5M: Monochromatic Neutral Subtitles (Zero Neon Bleed)
- **The Defect**: Deriving subtitle colors from chromatic color wheel algorithms (e.g. split-complementary +30° offsets) turns warm gold into toxic neon lime-green.
- **The Standard**: Subtitles must permanently remain neutral Titanium/Slate tints (`#94A3B8` Slate-400 or `#64748B` Slate-500). Maintain strict two-tone discipline across all slides.

### Commandment 5N: Isolated Canvas Folio Boundary (Zero Imagery Collision)
- **The Defect**: Running footers printed across the bottom right of the canvas collide with and print over 4K photography, model wardrobes, and architectural voids.
- **The Standard**: Never print running footers on the `hero-opener` cover slide. On split photographic slides, anchor the running footer strictly to the left typography column (`x: padIn`, `w: leftColW`, `align: left`).

### Commandment 5O: Monumental Pull-Quote Manifesto & Structured Datum Shelves
- **The Defect**: Pairing a 2-sentence manifesto paragraph at 13.5pt body size with 6 dense bullets leaves an 8-inch cavern of dead space on the left.
- **The Standard**: Scale the single core statement into a **22pt–26pt monumental display pull-quote** (in italic display serif) that commands vertical space. Format bullet points as structured numbered datum shelves (`01 // CORE CONCEPT`, `02 // THE PLANNED VOID`).

### Commandment 5P: Orthogonal Reference Decoupling (The Anti-Cloning Engine)
- **The Defect**: Cloning or borrowing an entire website's visual identity or corporate slide template wholesale, inheriting all its clichés and compromises.
- **The Standard**: Decompose references into 4 independent, orthogonal axes: `[Spatial Layout] × [Typographic Tension] × [Material Chromatics] × [Micro-Interaction Craft]`. Cross-breed across domains (e.g., Swiss architectural spatial grids + editorial serif tension + physical raw metal chromatics + aerospace telemetry shelves).

### Commandment 5Q: Role-Based Chromatic Staging (The 60-30-8-2 Invariant)
- **The Defect**: Picking 5 bright colors in isolation and spraying them equally across slides, cards, subtitles, and badges like confetti.
- **The Standard**: Enforce strict spatial surface distribution: **60% Canvas Base** (Deep Carbon Obsidian `#07090E` or Warm Bone Paper `#F6F4EE`), **30% Primary Specular Typography** (Pure White `#FFFFFF` or Deep Sumi Ink `#181C24`), **8% Structural Subtitles & Borders** (Neutral Titanium/Slate `#94A3B8` Slate-400), and **2% Singular Motivated Accent** (Swedish Gold `#E5A93C`, Cobalt `#002FA7`, or Signal Red `#FF3B30`).

### Commandment 5R: Polar Tracking Calibration & Mathematical Modular Scales
- **The Defect**: Loose, disconnected headlines and cramped metadata caused by uniform tracking and arbitrary font sizes.
- **The Standard**: As font scale expands ($\ge 40\text{pt}$), tracking must contract (`-0.03em` to `-0.05em`); as scale shrinks ($\le 10\text{pt}$ metadata), tracking must expand (`+0.15em` to `+0.25em`). Font sizes must anchor strictly to a defined mathematical modular scale (Major Third $1.250$ or Perfect Fourth $1.333$).

### Commandment 5S: Organic Low-Frequency Continuation Over Pure Black Voids
- **The Defect**: Generating artificial pure black (`#000000`) or flat graphic crop blocks for negative space. A flat black box is not photography; it reads as an artificial graphical border and ruins realism.
- **The Standard**: Negative space in a photograph must be a calm, unbusy **continuation of the physical photograph**—e.g., gentle atmospheric mist, soft out-of-focus wet asphalt, shallow depth-of-field background blur, or concrete walls rolling off into soft shadow.

### Commandment 5T: Tactile Optical Realism (The 5 Imperfections Engine)
- **The Defect**: Smooth, sterile, hyper-vibrant AI plastic sheen that feels synthetic and artificial.
- **The Standard**: Ground all visual production in physical optical character:
  1. *Subtle Motion Blur*: Minute shutter drag / camera motion to take the digital edge off.
  2. *Tiniest Desaturation*: Ground hyper-vibrant primaries into authentic film stock palettes.
  3. *Subtle Chromatic Lens Distortion*: Optical aberration and edge softening from real cinema glass.
  4. *Muddy / Lifted Blacks*: Optical flare toe and atmospheric bounce in shadows (never crushed #000000).
  5. *Authentic Film Grain*: Organic silver halide grain to give tactile familiarity to the viewer.

### Commandment 5U: Default 21:9 Ultrawide Scope & True Full-Bleed Spatial Canvas Invariant
- **The Defect**: Chopping a cinematic photograph into an artificial 50/50 split column and filling the other half with a flat digital `#070B14` box, or rendering 16:9 images on a 21:9 canvas resulting in letterboxing or vertical head-chopping.
- **The Standard**: The presentation canvas defaults to **21:9 Ultrawide** (17.778" × 7.5" in PPTX, 2560×1080 in HTML). All intended full-bleed imagery must be generated in native **21:9 anamorphic format (3840×1620)**. Photographic assets must span 100% of the canvas edge-to-edge (`w: 100%, h: 100%`). Copy is laid out directly over the image's low-frequency negative space using an invisible directional optical scrim (94% opacity rolling down to 0% across 62% width on 21:9). Zero vertical dividing lines.

### Commandment 5V: Optical Typography Craft Engine (Kerning, Tracking, Vertical Leading & Purity)
- **The Defect**: Cluttered decorative underline bars, kickers colliding into display headlines with only 3pt gaps, loose display leading that breaks optical word shapes, and awkward multi-line metadata footers.
- **The Standard**:
  1. *Architectural Kicker Gap*: Maintain 0.16"–0.24" (12pt–17pt) intentional vertical buffer between kicker and headline so ascenders never collide.
  2. *Sculptural Display Tracking*: Apply tight negative tracking (`-1.0` to `-1.5pt` / `-0.025em` to `-0.04em`) and compact leading (`1.05`–`1.08`) to monumental serif headlines to condense optical mass.
  3. *Subtitle Harmonic Proximity*: Anchor subtitles 0.14"–0.24" below the title with line length constrained to $\le 55$ characters per line (`w: 5.5"`).
  4. *Zero Decorative Scaffolding*: Purge all decorative underline rectangles. Format metadata footers as single unbroken lines with spaced bullets (` • `) and wide tracking. Suppress all chrome on cover slides.

### Commandment 6: Label Clearly
- **The Rule**: Maintain clear orientation markers without cluttering the canvas.
- **Structure**:
  - Top-Left: Scene slugline or section identifier (`SCRIPT NAME :30`, `THE APPROACH`).
  - Bottom-Left: Campaign name or project title (`SUPER BOWL 2020`).
  - Bottom-Right: Agency / Client metadata with pipe divider (`VENABLES BELL & PARTNERS | AUDI 25`).

### Commandment 7: Sweat the Small Stuff
- **Margins & Breathing Room**: Never push text blocks to slide edges. Minimum 0.8" to 1.0" perimeter padding.
- **Column Rags**: Balance paragraph rags to eliminate awkward single-word widows or hyphens.
- **Line Heights**: Body copy at 1.4× to 1.5× line spacing; headings at 1.05× to 1.1× to prevent loose, disconnected titles.

### Commandment 8: Break Your Own Rules
- **The Philosophy**: *"Your deck template is meant to be a design guideline, not a hindrance."*
- If an element or layout works on one page but constrains another, change the layout.
- Always choose **visual enhancement over template dedication**. All that matters is how good of a story you tell.
- Feel empowered to switch between full-bleed imagery, anamorphic letterboxes, 2-column script layouts, and single-line art cards as the dramatic pacing requires.

### Commandment 9: Every Deck Matters
- *"A great deck is a love letter to your clients. Hell, it's a love letter to your ideas."*
- Treat every slide with dedicated craft, regardless of how brief or administrative the content is.

### Commandment 10: Kern Your Art Cards
- **The Typography**: Ultra-condensed display headlines (`Impact`, `Bebas Neue`, `Tungsten`, `Knockout`, `Oswald`) set in ALL CAPS.
- **The Optical Balance**: Ultra-condensed typography requires strict tracking and kerning calibration. Letters must not collide, nor feel irregularly spaced.
- **Anchor Underline**: Ground large art cards or key category words with a bold 3pt horizontal anchor bar beneath the active term.

---

## 3. The Signature Editorial Chrome System

"The Art of Deck Making" deck utilizes a sophisticated, ultra-clean chrome system that frames the slides:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ THE ART                                                                     │
│ ─────── (1pt anchor line)                                                   │
│                                                                             │
│                                                                             │
│                             SLIDE CONTENT AREA                              │
│                                                                             │
│                                                                             │
│                                                                   FORTY-ONE │
│                                                                   ───────── │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Top-Left Eyebrow**:
   - Deck / Section Title (e.g. `THE ART` or `PROJECT HORIZON`) set in small uppercase tracked text (9–10pt, `charSpacing: 2`).
   - Anchored with a subtle 1pt horizontal line directly beneath.
2. **Bottom-Right Spelled-Out Page Numbers**:
   - Rather than boring digits (`01`, `02`), page numbers are spelled out in uppercase: `ONE`, `TWO`, `THREE`, `TEN`, `TWENTY-FOUR`, `THIRTY-NINE`.
   - Anchored with a matching 1pt horizontal line underneath.
   - Adds an unmistakably bespoke editorial finish.

---

## 4. Advanced Layout Archetypes (New Patterns)

### Archetype A: The "Art Card" (Power Title / Interstitial)
- **Use Case**: Core thesis statements, single-minded propositions, bold chapter pivots, "VS." comparison breakers.
- **Geometry**:
  - Full obsidian canvas (`#0D0D0E` or `#121214`).
  - Ultra-condensed display font (`font-stretch: ultra-condensed`, 54–72pt), bold, centered.
  - Optional 3pt horizontal underline bar under the key anchor word.

### Archetype B: Anamorphic Letterbox Staging (2.39:1)
- **Use Case**: Cinematic scene descriptions, director pull-quotes, atmospheric keyframe presentations.
- **Geometry**:
  - 16:9 canvas with deep obsidian letterbox bands at top and bottom (representing a 2.39:1 scope frame).
  - High-res cinematic photography placed inside the horizontal viewport.
  - Centered uppercase tracked text (13–15pt, `charSpacing: 3`) floating over the middle with subtle contrast scrim.

### Archetype C: Script Page (2-Column Dialogue + 2-Up Keyframe Stack)
- **Use Case**: Commercial script :30/:60 readouts, dialogue scenes, storyboard pairings.
- **Geometry**:
  - **Left Area (58% width)**:
    - Top slugline (`SCRIPT NAME :30`, bold 16pt).
    - 2-column screenplay text flow with bold uppercase character names (`HERO:`, `CLARICE:`) and indented dialogue.
  - **Right Area (38% width)**:
    - 2 stacked widescreen (16:9 or 2.39:1) keyframe stills showing the visual beats of the script.
  - **Bottom Footer**:
    - Left: Campaign Name / Section.
    - Right: Agency / Client name (`AGENCY | CLIENT 25`).

### Archetype D: 10-Card Recap Grid
- **Use Case**: Synthesis slides, rule summaries, key takeaway checklists.
- **Geometry**:
  - Dark canvas.
  - Symmetrical grid of clean, solid white container cards (e.g. 3 columns × 3 rows or 4 columns × 2 rows).
  - High-contrast bold uppercase typography inside each card (`10–11pt`), perfectly centered with comfortable internal padding.
