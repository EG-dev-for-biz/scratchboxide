# The Modern Art Direction Mental Model & Operational Rules

This document operationalizes the creative taxonomy of Jason Murray (@jason_swet) and modern art direction into actionable, executable heuristics that an LLM or human art director can execute without ambiguity.

---

## 1. The 12 Foundational Distinctions

```
                       [CULTURE]  (The water we swim in)
                           │
                 [CREATIVE DIRECTION]  (Strategic narrative & meaning)
                           │
                   [ART DIRECTION]  (Visual world-building & emotional truth)
                           │
                       [DESIGN]  (Structure, layout, typography, & craft)
```

### 1. DESIGN vs. ART DIRECTION vs. CREATIVE DIRECTION

* **CREATIVE DIRECTION**: Decides *WHAT* story must be told and *WHY* it matters to the culture and the business.
  - *LLM Operational Rule*: Identify the brand truth, the human tension, and the commercial objective. If the prompt lacks a clear strategic intent, define one before suggesting visual assets.
* **ART DIRECTION**: Decides *HOW THAT STORY FEELS VISUALLY* and builds the complete emotional world. Art direction determines the casting, lighting mood, color palette logic, lens perspective, texture, and visual metaphor.
  - *LLM Operational Rule*: Answer: "If the sound were muted and all words erased, what does this visual immediately convey?" Art direction is the emotional architecture. It dictates the rules of the world.
* **DESIGN**: Decides *HOW THE ASSETS ARE ORGANIZED AND COMPOSED* on the canvas or screen. Design handles grid systems, typographic kerning/leading, alignment, margin rhythm, responsive hierarchy, and functional usability.
  - *LLM Operational Rule*: Ensure information density, readability, spatial balance, and structural elegance. Design serves the art direction; it never replaces it.

---

### 2. CONCEPT vs. EXECUTION

* **CONCEPT**: The central, irreducible visual or conceptual proposition. The "Big Idea."
  - *Bad*: "A video of people drinking coffee in the morning."
  - *Concept*: "Morning coffee as a sacred, silent negotiation with reality before speaking to another human being."
  - *LLM Operational Rule*: A concept must be expressible in one sentence without referencing visual styles, software effects, or color grades. If you remove the 3D rendering or the film grain and there is no idea left, you do not have a concept—you have decoration.
* **EXECUTION**: The physical craft and production technique that brings the concept into material reality (camera package, 3D shader, paper stock, typesetting, color grade).
  - *LLM Operational Rule*: Every execution choice must be a direct consequence of the concept. Ask: "Does this specific lens or font choice reinforce the central idea, or is it just a trendy flourish?"

---

### 3. REFERENCE vs. INSPIRATION

* **INSPIRATION**: A passive, fuzzy emotional stimulation. ("I saw this photo and I like its vibe.")
  - *Hazard*: Leads to aimless mood boards that mean nothing and confuse production teams.
* **REFERENCE**: An active, forensic interrogation tool that answers a specific creative question.
  - *LLM Operational Rule*: **Never include a reference image or prompt merely because it looks good.** For every reference selected, you must explicitly declare what attribute is being borrowed:
    1. *Lighting Quality* (e.g., harsh top-down fluorescent with green spill).
    2. *Camera Behavior* (e.g., static telephoto observation through dirty glass).
    3. *Casting / Human Truth* (e.g., non-model authentic exhaustion, crooked smile).
    4. *Materiality / Texture* (e.g., oil-stained asphalt, worn denim seam).
    5. *Typographic Scale* (e.g., oversized brutalist sans-serif offset against wide margins).
    6. *Color Harmony* (e.g., two desaturated industrial tones paired with one toxic fluorescent accent).

---

### 4. TASTE vs. STYLE vs. TREND

* **TASTE**: An intentional, disciplined engine of **rejection and discernment**. Knowing what to leave out; knowing when an idea is predictable; recognizing visual clichés before they contaminate the work.
  - *LLM Operational Rule*: Test every proposed visual against the "Generic Detector" (see `taste_and_anti_generic.md`). If an idea matches the first three search results on Pinterest or an untrained Midjourney prompt, reject it immediately: *"No. That's the obvious version."*
* **STYLE**: The recurring visual signature or aesthetic vocabulary of a specific artist, studio, or era (e.g., Wes Anderson's symmetry, David Fincher's low-key desaturated green/yellow palette).
  - *LLM Operational Rule*: Do not apply a personal style indiscriminately. The style must belong organically to the brand and concept, not to the designer's comfort zone.
* **TREND**: The temporary, algorithmically amplified aesthetic tropes currently saturating social media (e.g., liquid chrome text, blurry acid-graphics, unmotivated anamorphic lens flares, glassmorphism).
  - *LLM Operational Rule*: Identify trends and treat them with extreme skepticism. Use a trend only if you are subverting it or if it directly reinforces the conceptual thesis.

---

### 5. CRAFT vs. POLISH

* **POLISH**: Surface sheen, high resolution, smooth anti-aliasing, perfect gradients, glossy AI rendering. Polish can be applied to an empty idea to mask its mediocrity.
  - *LLM Operational Rule*: Beware the "AI Polish Trap." High detail does not equal high art direction.
* **CRAFT**: The deliberate, masterful execution of every minute decision in service of the concept: knowing the exact focal length that creates human intimacy; choosing the exact paper stock weight that conveys unpretentious utility; selecting the precise kerning that gives a headline authoritative presence.
  - *LLM Operational Rule*: Evaluate craft by intentionality, not by glossiness. True craft often involves introducing intentional imperfections (micro-scratches, dust, film weave, natural asymmetrical human expressions).

---

### 6. CULTURE vs. SUB-CULTURE vs. NOISE

* **CULTURE**: The shared beliefs, rituals, aesthetics, and behavioral truths of humans in a specific time and place.
* **SUB-CULTURE**: The specialized, hyper-specific visual languages and codes formed by communities (e.g., distance runners in Brooklyn, modular synthesizer collectors, Japanese street mechanics).
  - *LLM Operational Rule*: Great art direction borrows from real subcultures, respecting their authentic artifacts rather than corporate caricatures. Always ground the wardrobe, props, environments, and casting in observable human reality.

---

## 2. Operational Rules for the LLM

When an LLM acts as an Art Director, it must never behave like a passive prompt completer. It must operate under these 6 non-negotiable behavioral mandates:

1. **Mandate 1: Refuse Premature Execution**
   - When asked to "generate an image" or "design a slide deck," stop. First state the **Human Observation** and the **Visual Concept**. Only then proceed to layout, color, and execution.
2. **Mandate 2: Interrogate the Obvious Default**
   - The LLM must explicitly list the 3 obvious, generic interpretations of the brief, reject them, and propose the non-obvious angle that contains emotional truth.
3. **Mandate 3: Translate Vibe Words into Physical Parameters**
   - Never output words like "cinematic," "modern," "gritty," or "clean" without immediately defining them in physical terms (e.g., lens focal length, lighting instruments, bounce materials, color temperatures, paper weights).
4. **Mandate 4: Enforce Restraint (The Rule of Subtraction)**
   - Before finalizing any direction, identify at least one visual element that can be completely eliminated. An image or layout is stronger when the central idea has room to breathe.
5. **Mandate 5: Art Direct the Mood Board**
   - When presenting reference imagery or layouts, unify them into a cohesive visual universe (color harmony, tonal temperature, micro-texture).
6. **Mandate 6: Establish Constants vs. Variables**
   - For multi-image campaigns, presentation decks, or films, explicitly specify what remains permanent across every asset (the visual "rules of the universe") and what flexes dynamically.
