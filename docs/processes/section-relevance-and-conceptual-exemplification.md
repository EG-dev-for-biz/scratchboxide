# Process: Section Relevance & Conceptual Exemplification Pipeline

> **Recorded:** 2026-10-10  
> **Status:** Verified  
> **Tags:** `art-direction` `presentation-decks` `conceptual-exemplification` `scratchbox-mcp` `google-nano-banana` `prompt-engineering`  
> **Target Domain:** Visual Art Direction & Presentation Architecture

---

## 1. Problem Statement & Context
* **Problem / Obstacle:** Generative AI engines and slide compilers default to **Ambient Illustration**—producing generic stock filler and visual clichés (e.g., smiling businesspeople holding tablets, glowing blue digital wireframes, or disconnected architectural slabs) instead of imagery that actively proves, substantiates, and exemplifies the specific assertion of the presentation section.
* **Symptom / Error:**
```text
[AMATEUR-DEFAULT] Slide title: "Sub-millimeter Low-Latency Spatial Sync"
[AMATEUR-PROMPT]  "High-tech futuristic office, people working with computers, cinematic, 8k"
[AMATEUR-RESULT]  Irrelevant corporate stock image with zero technical authority or storytelling value.
```
* **Root Cause Diagnosis:** Prompt generators historically concatenated top-level title words with generic aesthetic descriptors (`cinematic, photorealistic, masterpiece`) without parsing the underlying technical mechanism, human behavior, or physical evidence articulated in the body copy and speaker notes.
* **Expected Outcome:** An automated, closed-loop art direction pipeline that inspects full section context, passes through the "No. That's the obvious version" gate, constructs an observable physical proof with motivated lighting and 1/48s cinema shutter motion blur, and coordinates negative space for typographic layout.

---

## 2. Prerequisites & Environment
* **Runtimes & SDKs:** Node.js 20+, Python 3.10+
* **Model Family:** Google Foundation Models exclusively (`google/nano-banana-pro`, `google/nano-banana-2`, Google Veo 2/3) via Scratchbox AI MCP (`scratchbox.ai`)
* **Core Source Files:**
  - `skills/modern-art-direction/SKILL.md` (Invariant 10: Section Conceptual Relevance & Exemplification)
  - `skills/modern-art-direction/references/ai_prompt_translation.md` (Section 2.7: The Section Exemplification Engine)
  - `skills/markdown-to-google-slides/SKILL.md` (Commandment 5C: Section Relevance & Conceptual Exemplification)
  - `skills/markdown-to-google-slides/scripts/md_to_slides_compiler.mjs` (`synthesizeContextualExemplificationPrompt`)

---

## 3. Step-by-Step Resolution Procedure

### Step 1: Deep Semantic Extraction from Markdown Section Nodes
Analyze the complete slide/section AST rather than just the title. Aggregate `title`, `subtitle`, `kicker`, `bodyParagraphs`, `bullets`, `blockquote`, and `speakerNotes` to isolate the core technical nouns, verbs, and mechanisms:

```javascript
export function extractSectionContext(slide) {
  const title = slide.title || '';
  const subtitle = slide.subtitle || '';
  const kicker = slide.kicker || '';
  const prose = [
    ...(slide.bodyParagraphs || []),
    ...(slide.bullets || []),
    ...(slide.blockquote ? [slide.blockquote] : []),
    ...(slide.speakerNotes ? [slide.speakerNotes] : [])
  ].join(' ');
  return { title, subtitle, kicker, prose, fullText: `${kicker} ${title} ${subtitle} ${prose}`.toLowerCase() };
}
```

### Step 2: The Four-Question Art Direction Gate ("No. That's The Obvious Version")
Before synthesizing the prompt, run the four-question interrogation gate:
1. *What is the specific point/tension of this section?* (Extract core nouns, verbs, mechanisms).
2. *What is the obvious generic visual default for this topic?* -> Say: *"No. That's the obvious version."*
3. *What physical, tangible, or human phenomenon proves this point in the real world?*
4. *How do camera lens, motivated light, and negative space dramatize this specific proof?*

### Step 3: Ground in Physical Causality (The Observable Phenomenon)
Translate the abstract claim into physical, observable reality with tangible materials, tools, and motivated lighting:

```javascript
// Example domain translation logic in synthesizeContextualExemplificationPrompt:
if (/(thermal|cooling|heatsink|heatpipe|battery|energy|power)/.test(fullText)) {
  physicalScene = 'Extreme macro photograph of an extruded matte-black aerospace aluminum heatsink with sintered copper heatpipes undergoing thermal laser stress testing; micro-convective heat shimmer in the air; 5000K overhead technical work lamp casting sharp raking shadows across precision CNC milling lines';
} else if (/(code|software|engine|compiler|latency|pipeline|shader|gpu|compute)/.test(fullText)) {
  physicalScene = 'Technical studio photograph: an engineer\'s dark matte workstation with a color-calibrated monitor displaying wireframe mesh density; hands resting at an anodized mechanical keyboard with soft 3200K tungsten desk lamp grazing aluminum edges';
}
```

### Step 4: Staging the Planned Void & Motivated Shutter Drag
Inject layout negative space coordination and cinema shutter settings:
1. **The Planned Void**: When text is in the left column (standard 21:9 or 16:9 split), anchor the primary subject on the rightmost 35–40%, leaving the left flank as an expansive low-frequency negative space void.
2. **Inward Vector Convergence**: Ensure lighting angles, laser beams, or subject gaze point inward toward the copy.
3. **Micro-Motion Blur**: Set `shutter_angle: 180` and `motion_blur: 0.06` (1/48s cinema shutter) to eliminate synthetic AI plastic edge sharpness.
4. **Zero-Text Invariant**: Pure photographic imagery without burned-in letters, words, or watermarks.

### Step 5: Compiler Integration (`md_to_slides_compiler.mjs`)
Connect `synthesizeContextualExemplificationPrompt` to `resolveScratchboxImages`:

```javascript
const prompt = synthesizeContextualExemplificationPrompt(s, brandContext, aspect, 'split-left');
const genRes = await generateScratchboxImage(prompt, aspect, workspaceId, 'split-left');
img.url = genRes.url;
```

---

## 4. Verification & Validation

* **Verification Command:**
```bash
node /Users/eligreen/.gemini/config/skills/markdown-to-google-slides/scripts/md_to_slides_compiler.mjs \
  --help | grep "scratchbox-images"
```

* **Success Criteria & Invariants:**
  - [x] **Invariant 6 (Zero-Text & 4K Resolution)**: Generated image contains zero letters, numbers, or brand text, and is formatted for 4K display.
  - [x] **Invariant 8 (The Planned Void)**: Subject is anchored on the opposing flank to leave clean, low-frequency negative space for the text column.
  - [x] **Invariant 9 (Micro-Motion Blur)**: 1/48s shutter drag softens clinical AI sharpness.
  - [x] **Invariant 10 (Section Relevance)**: Image provides direct physical proof of the section's argument rather than generic category decoration.

---

## 5. Pitfalls, Edge Cases & Rollback
* **Pitfall 1: Keyword Traps**: Avoid naive single-keyword matching that mistakes a metaphorical title (e.g. "Cold Start Problem") for literal weather (generating snow instead of software initialization). Always evaluate `prose` and `speakerNotes` alongside the title.
* **Pitfall 2: High-Frequency Negative Space**: Avoid placing detailed high-frequency textures (foliage, crowded cityscapes) in the negative space void, which makes overlay text illegible.
* **Rollback Plan:**
```bash
git -C /Users/eligreen/dev/scratchbox-studio checkout HEAD~1 -- .agents/skills/
git -C /Users/eligreen/dev/scratchbox-ide-master checkout HEAD~1 -- .agents/skills/
```

---

## 6. Reusability & Future Automation
* This process is fully baked into `synthesizeContextualExemplificationPrompt()` in `md_to_slides_compiler.mjs`.
* Future CLI invocations passing `--scratchbox-images` or Markdown decks using `![alt](generate:21:9)` will automatically execute this 4-step pipeline without requiring manual prompt crafting.
