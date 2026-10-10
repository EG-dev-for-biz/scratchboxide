# Process: Conceiving and Implementing Non-Derivative Layouts via Modern Art Direction

> **Recorded:** 2026-10-10  
> **Status:** Verified  
> **Tags:** `art-direction` `layout-design` `grid-systems` `editorial` `spatial-reasoning` `typographic-tension`  
> **Target Domain:** Visual Art Direction & Presentation Engineering  

---

## 1. Problem Statement & Context

* **Problem / Obstacle:**  
  Generative AI and automated design pipelines default to derivative, template-driven layouts (split-screen cards, 3-column feature grids with circular icons, centered hero text with flat dark overlays). These outputs suffer from *Semantic Literalism*, producing predictable, generic layouts that fail to embody the narrative voice or physical world of the writing.
* **Symptom / Error:**  
  - Layouts look like corporate SaaS marketing templates or canned slide themes.
  - Full-bleed text over imagery is unreadable due to placement over high-frequency details (faces, sharp edges) or looks muddy due to flat 50% dark overlays.
  - Visual hierarchy relies on timid, intermediate font scaling (1.7:1 ratio) rather than monumental editorial tension (10:1 ratio).
  - Colors, typography, and negative space feel decorative rather than causally derived from the narrative concept.
* **Root Cause Diagnosis:**  
  1. *Additive 2D Canvas Fallacy*: Treating the screen as an empty box to be filled with containers and decorative shapes rather than as a physical, atmospheric architectural room.
  2. *Single-Source Borrowing*: Copying a single website or agency portfolio wholesale rather than cross-breeding decoupled orthogonal axes.
  3. *Unfiltered Cliché Selection*: Accepting the first 3 obvious layout ideas without running the "No. That's the obvious version" rejection protocol.
* **Expected Outcome:**  
  A repeatable, non-derivative layout conception pipeline that translates narrative friction into unique spatial geometry, 4K full-bleed living scene continuation, 10:1 scalar typography tension, and disciplined directional optical scrimming.

---

## 2. Prerequisites & Environment

* **Runtimes & Toolchains:**  
  - Node.js 18+ (ESM modules for slide and web compilation).
  - PptxGenJS 3.12+ (configured for 21:9 anamorphic ultrawide layout `17.778" \times 7.5"`).
  - Python 3.10+ (for asset processing, zip packaging, and test harness execution).
* **Skills & Documentation Assets:**  
  - `modern-art-direction` (`SKILL.md` Invariants 1–31).
  - `markdown-to-google-slides` (`SKILL.md` Rules 1–30, `md_to_slides_compiler.mjs`, `html_slides_engine.mjs`).
  - Reference guides:
    - `references/how_to_conceive_unique_layouts.md`
    - `references/concept_to_form_transduction.md`
    - `references/grid_systems_and_tone_taxonomy.md`
    - `references/advanced_editorial_and_rule_breaking_grids.md`

---

## 3. Step-by-Step Resolution Procedure

### Step 1: The Subtractive Purge (Cleanse the Canvas)
Strip away all decorative digital scaffolding before placing any content:
```text
1. Delete all card containers, gray background rectangles, and rounded-corner boxes.
2. Delete all circular colored pill badges and generic vector icons.
3. Delete all horizontal hairline dividing rules between paragraphs.
4. Suppress all running chrome (headers, page numbers, folios) on cover slides.
```

### Step 2: Execute the 4 Narrative Probes
Analyze the raw text through four foundational questions:
```text
Probe 1 (Ideological Friction): What underlying conflict drives this narrative? (e.g. brutalist computational power vs. human warmth).
Probe 2 (Sensory Environment): If this text were a physical room, what does it smell like and what are the walls made of? (e.g. cold damp basalt at dusk lit by slit windows).
Probe 3 (Vocal Persona): Who is speaking? (e.g. an uncompromising architectural theorist delivering an audited monograph).
Probe 4 (Physical Matter): What real substances exist in this world? (e.g. raw titanium, weathered linen, lampblack, Swedish gold).
```

### Step 3: Select Master Grid Architecture via the 3-Axis Matrix
Map the narrative payload to one of five structural grids:
```text
• Axis 1 (Cognitive Density): Sparse (1-2 points) | Structured (3-5 points) | Dense (6+ points)
• Axis 2 (Cognitive Tempo): Slow & Contemplative (wide margins) | Fast & Forensic (tight gutters)
• Axis 3 (Institutional Posture): Sovereign / Luxury | Rationalist / Swiss | Subversive / Brutalist

Target Selection:
- Asymmetric Editorial Duo (38/62 split) for high-end strategy and industrial design.
- Monolithic Axial Void (35% column, 65% void) for philosophical manifestos.
- Swiss Compound Modular Grid (6/12 columns, hangline y=24%) for technical governance.
- High-Density Telemetry Matrix (horizontal shelves, monospace) for software architecture.
- Brutalist Dynamic Friction Grid for counter-cultural and avant-garde pitches.
```

### Step 4: Direct Photographic Scene Continuation
Direct the visual foundation in native 21:9 anamorphic format ($3840 \times 1620$):
```text
Prompt Directive:
"21:9 ultrawide anamorphic photography. The primary physical subject is strictly anchored on the right 35% flank. The entire left 65% is an unbusy, continuous, living physical environment of soft atmospheric dusk mist, wet ground, and shallow depth-of-field background blur. No text. 5 optical imperfections: subtle 1/48s motion blur, tiny desaturation, subtle lens barrel aberration, lifted muddy blacks with authentic optical toe, and fine silver halide film grain."
```

### Step 5: Deploy Asymmetric Directional Optical Scrim & Polar Typography
Overlay typography directly over the low-frequency photographic continuation:
```javascript
// Non-linear cubic optical scrim falloff (WCAG AAA legibility + unshadowed subject)
const scrimParams = {
  width: "62%",
  coreOpacity: 0.94,
  coreStop: 0.26,
  cutoffStop: 0.62,
  gamma: 1.8
};

// 3-Layer Acoustic Typographic Casting
const typeHierarchy = {
  layer1_display: { font: "Bodoni Moda", style: "italic", size: "36pt", tracking: "-0.035em", leading: 1.06 },
  layer2_reading: { font: "Plus Jakarta Sans", size: "12pt", leading: 1.45 },
  layer3_datum: { font: "JetBrains Mono", size: "8.5pt", tracking: "+0.22em", transform: "uppercase" }
};
```

### Step 6: Senior Art Director Self-Critique Gate (17 Questions)
Subject the completed layout to the 17-gate audit, specifically verifying:
- *Could one strong decision replace five weaker decisions?*
- *What can be removed right now?*
- *Is the negative space an organic physical continuation rather than a digital black void?*

---

## 4. Verification & Validation

* **Compiler & Verification Commands:**
```bash
# 1. Compile 21:9 presentation with native full-bleed directional scrimming
node /Users/eligreen/.gemini/config/skills/markdown-to-google-slides/scripts/md_to_slides_compiler.mjs \
  --input /Users/eligreen/antigravity/scratch/new_editorial_code_test.md \
  --ratio 21:9

# 2. Inspect generated HTML and PPTX decks
open /Users/eligreen/antigravity/scratch/new_editorial_code_test.html
```
* **Success Criteria & Invariants:**
  - [x] Canvas format is native 21:9 ($17.778" \times 7.5"$ in PPTX, $2560\times1080$ in HTML).
  - [x] Intended full-bleed imagery spans edge-to-edge ($3840\times1620$) with zero split-box clipping.
  - [x] Asymmetric directional scrim provides 100% copy legibility on the left while leaving $>60\%$ of the photograph completely unshadowed.
  - [x] Extreme scalar tension ($10:1$ ratio) between display headlines ($40\text{pt}+$) and metadata ($8.5\text{pt}$).
  - [x] Zero decorative card containers, gray boxes, or circular icon badges.

---

## 5. Pitfalls, Edge Cases & Rollback

* **Known Pitfalls:**
  - *The Crushed Black Trap*: Never use pure digital `#000000` for negative space. Always lift shadows with atmospheric haze and subtle silver halide grain.
  - *The High-Frequency Collision*: Placing typography over high-frequency edges (car wheels, building mullions, human eyes) causes severe cognitive friction. Always verify that text sits entirely within the low-frequency atmospheric envelope.
  - *Multiple Rupture Chaos*: In rule-breaking layouts, never execute more than **one** deliberate rupture per spread. Breaking multiple rules simultaneously produces amateur clutter.
* **Rollback Plan:**
  If an image lacks sufficient low-frequency negative space on the left, fall back to an Asymmetric Editorial Duo layout with an explicit solid material column base (e.g. Deep Carbon Slate `#0E1012`) rather than dropping text over complex imagery.

---

## 6. Automation & Operational Acceleration

* **Automated Compiler Script:**  
  `md_to_slides_compiler.mjs` automatically generates directional scrim PNGs, parses structured datum shelves (`01 //`), enforces polar tracking, and builds PPTX and HTML outputs.
* **Skill Integration:**  
  Codified in `modern-art-direction` (Invariants 28–31) and `markdown-to-google-slides` (Rules 27–30).
