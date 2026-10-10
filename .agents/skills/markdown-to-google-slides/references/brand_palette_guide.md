# Brand Palette Extraction & Token Mapping Guide

This guide governs how the **markdown-to-google-slides** skill determines, extracts, and injects brand color schemes into presentation decks. Every slide layout must feel authentically native to the client or project brand.

---

## 1. The Brand-First Invariant

> **Golden Rule**: Slide color schemes must NEVER be default, generic, or randomly assigned. Every presentation palette MUST be anchored directly to the brand identified in the project brief, proposal, or markdown metadata.

When rendering a slide deck, the design system requires six primary color tokens:

| Token Name | Role | Applied Elements |
| :--- | :--- | :--- |
| `slideBg` | Base canvas background | Entire slide canvas (Dark or Light brand variant) |
| `titleColor` | High-contrast title text | Main slide headings (`H1`, `H2`), hero titles |
| `subtitleColor` | Secondary text contrast | Subtitles, scene meta-tags, bullet prefixes |
| `textColor` | Body copy contrast | Paragraphs, lists, table body cells, screenplay dialogue |
| `accentColor` | Hero brand punch color | Minimalist accent bars, vertical margin anchors, callout metrics |
| `secondaryAccent` | Sub-brand / contrast anchor | Table header fills, card borders, tag badges |
| `scrimColor` | Gradient shade | Lower-third photo scrims ensuring text readability |

---

## 2. Ingestion & Extraction Protocol

The skill executes a 3-tier cascade to determine the brand palette:

```
┌────────────────────────────────────────────────────────┐
│ Tier 1: Explicit Codes in Creative Brief / Frontmatter │
│ • Exact HEX or Pantone values declared                 │
└──────────────────────────┬─────────────────────────────┘
                           │ (if absent)
                           ▼
┌────────────────────────────────────────────────────────┐
│ Tier 2: Named Commercial Brand Knowledge               │
│ • Canonical brand guidelines (Apple, Nike, Porsche...) │
└──────────────────────────┬─────────────────────────────┘
                           │ (if fictional / unlisted)
                           ▼
┌────────────────────────────────────────────────────────┐
│ Tier 3: Category Psychological Archetype               │
│ • Synthesize cohesive palette from brand ethos/tone    │
└────────────────────────────────────────────────────────┘
```

### Tier 1: Explicit Codes in Brief or Frontmatter
If the Markdown contains YAML frontmatter or mentions explicit brand colors in an "Art Direction / Styling / Brand Identity" section, extract them directly:

```yaml
---
title: "Project Horizon Commercial Pitch"
brand: "Arc'teryx"
brand_colors:
  primary: "#1A1A1A"
  accent: "#E25822"      # Flame orange
  secondary: "#4A525A"    # Graphite grey
  background: "#0D0D0E"   # Deep obsidian
  text: "#F2F2F2"
---
```

### Tier 2: Named Commercial Brands (Authoritative Canonical Presets)
When an existing brand is named without explicit hex codes, inject its canonical palette:

| Brand | Canvas Base (`slideBg`) | Accent (`accentColor`) | Secondary (`secondaryAccent`) | Text (`textColor` / `titleColor`) |
| :--- | :--- | :--- | :--- | :--- |
| **Apple** | `#000000` (Obsidian) | `#0071E3` (Cupertino Blue) | `#86868B` (Space Grey) | `#F5F5F7` / `#FFFFFF` |
| **Nike** | `#0D0D0D` (Pitch Black) | `#CEFF00` (High-Vis Volt) | `#E03A3E` (Heritage Red) | `#EBEBEB` / `#FFFFFF` |
| **Patagonia** | `#1C1C1B` (Forge Grey) | `#D95B32` (Campfire Ochre)| `#2F4858` (Deep Basin) | `#EDECE6` / `#FFFFFF` |
| **Porsche** | `#111111` (Matte Black) | `#D5001C` (Guards Red) | `#999999` (Turbonite Grey) | `#E8E8E8` / `#FFFFFF` |
| **Oatly** | `#F7F4EE` (Oat Carton) | `#1B1B1B` (Ink Black) | `#8EBFDB` (Nordic Sky Blue)| `#2A2A2A` / `#1B1B1B` |
| **Starbucks** | `#0F201B` (Espresso Dark)| `#006241` (House Green) | `#D4E9E2` (Warm Cream) | `#E8EDE9` / `#FFFFFF` |
| **Red Bull** | `#0B1E3D` (Aero Navy) | `#FFC907` (Solar Yellow) | `#D30138` (Bull Crimson) | `#EDEDED` / `#FFFFFF` |
| **Sonos** | `#0A0A0A` (Acoustic Black)| `#FF5A00` (Sound Wave Orange)| `#444444` (Mesh Grey) | `#F0F0F0` / `#FFFFFF` |
| **BMW** | `#0F172A` (Midnight Slate)| `#1C69D4` (M-Division Blue)| `#708090` (Reflective Silver)| `#F8FAFC` / `#FFFFFF` |
| **Sephora** | `#121212` (Noir) | `#E0004D` (Lipstick Magenta)| `#FFFFFF` (Pure White) | `#EAEAEA` / `#FFFFFF` |

### Tier 3: Category Psychological Archetypes
For startup, stealth, or fictional brands, derive the color scheme from the brand's industry ethos:

1. **Luxury & High-End Craftsmanship**:
   - `slideBg`: `#0E0E10` (Rich Black)
   - `accentColor`: `#D4AF37` (Champagne Gold) or `#C5A880` (Warm Brass)
   - `textColor`: `#EDE8E1` (Warm Alabaster)

2. **Clean Tech & Sustainability**:
   - `slideBg`: `#0E1A14` (Deep Pine) or `#F4F8F5` (Clean Sage Light)
   - `accentColor`: `#10B981` (Vibrant Emerald) or `#059669`
   - `textColor`: `#ECFDF5` / `#064E3B`

3. **Fintech & Enterprise Security**:
   - `slideBg`: `#0B132B` (Deep Navy Space)
   - `accentColor`: `#00B4D8` (Pacific Electric Blue)
   - `textColor`: `#E0F2FE` (Ice White)

4. **Youth, Creator Economy & Entertainment**:
   - `slideBg`: `#12111A` (Violet Black)
   - `accentColor`: `#FF3366` (Neon Coral) or `#7928CA` (Hyper Violet)
   - `textColor`: `#FFFFFF`

---

## 3. Dark vs. Light Variant Selection

- **Dark Brand Variant (Default for Pitches & Treatments)**:
  - Cinema, director pitches, visual storytelling, and screen presentations thrive on dark surfaces (`#0D0D0E` to `#1A1A1A`) because imagery "pops" with higher dynamic range, and ambient projection/monitors don't blast glare.
- **Light Brand Variant (Executive Readouts & Printed Decks)**:
  - If the brief is an enterprise business review, investor tear-sheet, or document to be printed, flip to the brand's light variant:
    - `slideBg`: `#FFFFFF` or `#F8F9FA`
    - `titleColor`: Primary Dark Brand Color (e.g., `#0F172A`)
    - `textColor`: `#334155` (Slate 700)
    - `accentColor`: Primary Brand Hue (e.g., `#2563EB`)
    - `secondaryAccent`: Muted Brand Tint for borders and table header bands

---

## 4. Contrast & Legibility Invariants (WCAG AA+)

1. **Title Contrast**: Titles must achieve at least a 4.5:1 contrast ratio against `slideBg`.
2. **Body Contrast**: Body text must achieve at least a 7:1 contrast ratio against `slideBg`.
3. **Accent Punch**: The `accentColor` must stand out distinctly against both the background AND the primary text color so anchor bars and callout tags immediately guide the reader's eye.
4. **Photo Scrims**: When text is overlaid on imagery (e.g. `hero-opener` or `full-bleed-text-overlay`), a bottom-to-top gradient scrim tinted with `slideBg` (80%–90% opacity at bottom, 0% at top) must be injected under the text box.

---

## 5. Adobe Color Harmony Models (Wheel Mathematics)

When synthesizing palettes from a single brand anchor hue $\theta \in [0^\circ, 360^\circ)$, apply Adobe Color's mathematical wheel rules:

```
                  Complementary (180°)
                         ▲
                         │
     Split-Comp (150°)   │   Split-Comp (210°)
              \          │          /
               \         │         /
   Triadic (120°) \      │      / Triadic (240°)
                   \     │     /
                    \    │    /
   Analogous (-30°) ─── Base (0°) ─── Analogous (+30°)
```

1. **Analogous Harmony ($\theta \pm 30^\circ$)**:
   - *Formula*: Hues adjacent on the 360° color wheel.
   - *Psychological Effect*: Serene, cohesive, organic, low visual tension.
   - *Slide Application*: Ideal for background surfaces, card fills, and secondary subtitles where unified undertones create subtle visual sophistication.
2. **Complementary Contrast ($\theta + 180^\circ$)**:
   - *Formula*: Diametrically opposite hue.
   - *Psychological Effect*: Maximum visual energy, high vibration, bold punch.
   - *Slide Application*: Use strictly for accent bars, callouts, and key data metrics. Never use for large text blocks over complementary backgrounds (causes chromatic aberration and eye fatigue).
3. **Split-Complementary ($\theta + 150^\circ, \theta + 210^\circ$)**:
   - *Formula*: Base hue paired with the two neighbors of its direct complement.
   - *Psychological Effect*: High contrast and energy like complementary, but significantly softer tension and easier visual balance.
   - *Slide Application*: **The director's choice for pitch decks.** The base color anchors the brand identity, while the two split complements handle secondary badges and focal metrics.
4. **Triadic Harmony ($\theta + 120^\circ, \theta + 240^\circ$)**:
   - *Formula*: Three hues spaced in an equilateral triangle.
   - *Psychological Effect*: Vibrant, balanced, dynamic.
   - *Slide Application*: Excellent for 3-part comparison cards, multi-tier pricing/deliverable tables, and story act breakdowns.
5. **Monochromatic & Tonal Shades ($\Delta \theta = 0^\circ$, varying $L$ & $S$)**:
   - *Formula*: Same hue, altering lightness $L \in [0, 100\%]$ and chroma/saturation.
   - *Slide Application*: Clean, ultra-minimalist, architectural editorial decks.

---

## 6. Coolors 60-30-10 Visual Weight Distribution

Never distribute colors equally. The **60-30-10 Rule** governs the spatial and visual weight across every slide layout:

```
┌────────────────────────────────────────────────────────┐
│ 60% DOMINANT CANVAS (slideBg)                          │
│ • Deep brand obsidian or clean brand paper tone        │
│ • Provides negative space and prevents eye fatigue     │
├───────────────────────────────┬────────────────────────┤
│ 30% STRUCTURAL SUPPORT        │ 10% ACCENT PUNCH       │
│ (secondaryAccent, text, cards)│ (accentColor)          │
│ • Slide containers & tables   │ • Accent anchor bars   │
│ • Readable body typography    │ • Active KPI numbers   │
│ • Subtitle meta tags          │ • Primary callouts     │
└───────────────────────────────┴────────────────────────┘
```

- **60% Dominant (Canvas Base)**: The resting space. Usually a dark, low-saturation tone (`#0D0D0E` to `#18181B`) for cinematic decks, or crisp off-white (`#F8F9FA` to `#FFFFFF`) for corporate readouts.
- **30% Structural Support (Forms & Content)**: Cards, table header fills, secondary labels, borders, and readable body paragraphs. Gives the presentation its architecture.
- **10% Accent Punch (Focal Anchors)**: The high-energy brand punch color (`accentColor`). Reserved strictly for intentional focal points: the 3pt vertical margin line, horizontal section bar, key metric statistics, or the closing CTA.

---

## 7. Contrast & Luminance Science (WCAG AA/AAA)

Human perception of brightness is non-linear. Pure yellow ($R=255, G=255, B=0$) appears dramatically brighter than pure blue ($R=0, G=0, B=255$) at identical nominal lightness.

### Relative Luminance Formula (sRGB IEC 61966-2-1):
For RGB channels normalized to $[0, 1]$:
$$C_{\text{linear}} = \begin{cases} \frac{C}{12.92} & \text{if } C \le 0.04045 \\ \left(\frac{C + 0.055}{1.055}\right)^{2.4} & \text{otherwise} \end{cases}$$

Relative Luminance $L$:
$$L = 0.2126 R_{\text{linear}} + 0.7152 G_{\text{linear}} + 0.0722 B_{\text{linear}}$$

### Contrast Ratio Formula:
$$\text{Ratio} = \frac{L_1 + 0.05}{L_2 + 0.05} \quad (L_1 > L_2)$$

- **WCAG AA Compliance**:
  - Regular body text ($< 18\text{pt}$): **$\ge 4.5:1$**
  - Large headings ($\ge 18\text{pt}$ or bold $\ge 14\text{pt}$): **$\ge 3.0:1$**
  - UI components, borders, and icons: **$\ge 3.0:1$**
- **WCAG AAA Compliance**:
  - Regular body text: **$\ge 7.0:1$**
  - Large headings: **$\ge 4.5:1$**

**The Golden Check**: When generating light text over dark brand backgrounds, always verify that $L_{\text{text}} \ge 0.65$ and $L_{\text{bg}} \le 0.05$ to guarantee comfortable, fatigue-free reading across conference projectors, OLED displays, and mobile screens.

