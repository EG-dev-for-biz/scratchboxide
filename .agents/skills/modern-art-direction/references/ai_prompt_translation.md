# Generative AI Visual Causality & Prompt Translation Engine

> **The Golden Law of Generative Art Direction**: Replace adjectives with **causality**. Never tell the model how to *feel*; describe the **physical conditions, optical glass, source lighting, and material history** that force the image to look that way.

---

## 1. The Banned Vocabulary & Causal Replacements

Diffusion engines (Nano Banana 2, Imagen, FLUX, Midjourney, Veo, Wan, Runway) generate plastic, synthetic mush when fed empty buzzwords. The art director must purge the banned lexicon and replace it with physical causality.

| ❌ Banned Buzzword (Purge Immediately) | Why It Produces Generic Mush | 💡 Causal Physical Directive (Adopt) |
| :--- | :--- | :--- |
| **"Photorealistic / Hyperrealistic"** | Triggers over-sharpened digital clarity, aggressive edge contrast, and uncanny-valley porcelain skin. | Specify the sensor and optics: *"Shot on 35mm Kodak Vision3 500T 5219 film stock, Zeiss Super Speed 35mm T1.3 prime lens at f/2.8, subtle organic film grain, natural skin pores, fine peach fuzz, visible micro-vascularity."* |
| **"Cinematic Lighting"** | Prompts gratuitous orange/teal rim lights, fake volumetric fog, and unmotivated blue backlight. | Specify physical source and direction: *"Single low-angle tungsten practical lamp (2800K) placed on the bedside table camera-right, casting long raking shadows across the unmade linen sheets. Ambient room fill at -3 EV, deep natural shadow falloff."* |
| **"Cinematic / Masterpiece / 8K"** | Pure noise tokens that dilutes the model's latent attention away from actual subjects and composition. | Specify optical character and framing: *"Wide anamorphic 2.39:1 aspect ratio, Panavision C-Series 40mm anamorphic lens, subtle barrel distortion at the frame edges, delicate horizontal blue streak on bright specular highlights, stopped down to T4.0."* |
| **"Moody / Atmospheric"** | Generates artificial rain, dark desaturated smog, and generic sadness. | Specify atmospheric physics and color temperature: *"Overcast coastal sea mist with 90% humidity, diffused cool daylight (6500K) scattering softly across wet slate rocks, damp hair sticking to the nape of the neck, breath mist visible in cold air."* |
| **"Detailed Texture"** | Produces uniform procedural bumps that look like synthetic plastic reptile skin. | Specify physical wear and material provenance: *"Heavily worn 14oz raw Japanese denim jacket with indigo fading at the elbows, frayed cuff threads, a tarnished brass donut button showing green copper patina, faint engine grease stain on the left pocket."* |

---

## 2. The 5-Layer Causal Prompt Architecture

Every generative prompt must follow this structured, 5-layer hierarchy:

```
[ LAYER 1: SUBJECT & BEHAVIORAL TRUTH ]
  ├── Hyper-specific casting, posture, genuine human action, wardrobe with lived-in history.
[ LAYER 2: ENVIRONMENT & PRODUCTION DESIGN ]
  ├── Lived-in architectural details, physical props, wear and tear, spatial depth.
[ LAYER 3: LIGHTING PHYSICS & MOTIVATION ]
  ├── Physical source name, angle, softness, color temperature (Kelvin), fill ratio.
[ LAYER 4: OPTICAL & SENSOR SPECIFICATION ]
  ├── Camera body/sensor format, exact lens brand/focal length, aperture, shutter behavior.
[ LAYER 5: MATERIALITY & FILM EMULATION ]
  ├── Film stock / sensor response, grain structure RMS, surface textures, physical flaws.
```

---

## 2.5 The 4K Resolution & Zero-Text Invariants (Non-Negotiable Directives)

> **CRITICAL RULE**: Images are for **visual reality**; layout is for **words**. Images for layouts must **ALWAYS** be produced in **4K resolution** and must **NEVER** feature text.

### 1. Mandatory 4K Resolution Architecture
* **Standard 16:9**: Target **4K UHD** (`3840×2160` pixels).
* **Cinematic 21:9**: Target **4K Ultrawide** (`3840×1620` or `5120×2160` pixels).
* **Optical Fidelity**: Generates sufficient micro-contrast and edge sharpness for Retina displays, large client presentation monitors, and high-DPI projection without interpolation blur.

### 2. Why Baking Text into Images Destroys Art Direction
1. **Model Hallucinations**: Generative diffusion engines cannot reliably typeset; they produce misspelled glyphs, garbled letterforms, and nonsensical pseudo-English that immediately betrays the image as cheap AI output.
2. **Loss of Compositional Control**: When text is burned into pixels, it cannot be edited, re-ragged, kerned, scaled, or localized.
3. **Destruction of Visual Tension**: Great magazine design comes from the dialogue *between* a sharp vector font and a textured photograph. Flattening them into one mushy raster destroys that tension.

### 3. Mandatory Syntax to Append to Every Layout Prompt:
* **For 16:9**:
  `"4K UHD resolution (3840x2160), edge-to-edge optical sharpness, high dynamic range, fine physical surface micro-textures. Pure visual photography, absolutely zero text, no words, no letters, no alphabet, no fonts, no numbers, no subtitles, no watermark, no logo, clean visual frame."`
* **For 21:9**:
  `"4K Ultrawide resolution (3840x1620), edge-to-edge optical sharpness, high dynamic range, fine physical surface micro-textures. Pure visual photography, absolutely zero text, no words, no letters, no alphabet, no fonts, no numbers, no subtitles, no watermark, no logo, clean visual frame."`
* When designing the slide or presentation, the **words are laid out WITH the image** as separate vector text frames, asymmetrical column monoliths, floating editorial cards, or margin folios.

---

## 3. Structural Translation Examples

### Example 1: Street Sportswear Runner
* **❌ The Generic / Buzzword Prompt**:
  > *"Ultra-detailed photorealistic cinematic running portrait, dramatic lighting, 8k resolution, athletic runner sweating, masterpiece, trending on artstation."*
* **💡 The Art-Directed Causal Prompt**:
  > *"A candid 35mm street portrait of a 28-year-old marathon runner caught mid-breath at a Brooklyn street corner at 5:45 AM. The runner has damp, unruly hair sticking to their forehead, a slight smear of zinc sunscreen unblended on their cheekbone, and a faded nylon race singlet pinned with safety pins.  
  > **Environment**: Wet cracked asphalt, yellow municipal street paint worn smooth by traffic, distant storefront roll-up metal gate in the background.  
  > **Lighting**: Direct, on-camera flash with hard, crisp 45-degree drop shadows against a brick wall behind them; subtle ambient sodium-vapor street lamp glow (2200K) in the far background.  
  > **Camera & Film**: Shot on a Leica M6 with a Summicron 35mm f/2.0 stopped down to f/5.6. Kodak Tri-X 400 black-and-white film stock pushed one stop in development, rich silver halide grain, deep ink-dense blacks, bright specular sweat reflections without clipping."*

### Example 2: Quiet Interior Domestic Scene
* **❌ The Generic / Buzzword Prompt**:
  > *"Beautiful cozy kitchen morning, warm cinematic light, family breakfast, photorealistic, 4k."*
* **💡 The Art-Directed Causal Prompt**:
  > *"A quiet, observational medium shot of an 8-year-old boy sitting sideways on a mismatched wooden kitchen chair, swinging one bare foot rhythmically while watching milk pour into a chipped ceramic bowl. His rumpled flannel pajamas are slightly too large, cuffs folded over once.  
  > **Environment**: A modest pre-war apartment kitchen; an open jar of strawberry jam with a sticky spoon resting on the formica countertop; buttered toast steam rising softly; a refrigerator humming in the shadow covered in child drawings held by magnets.  
  > **Lighting**: Single soft key light from an overcast morning window camera-left (5400K), casting gentle diffused shadows across the tabletop. Passive warm bounce from worn pine floorboards; no artificial fill lights.  
  > **Camera & Film**: ARRI Alexa Mini LF paired with a Cooke S4/i 40mm prime lens at T2.8. Shallow, organic focus falloff with the boy's focused eye in sharp focus and the refrigerator soft in the background. Authentic 35mm grain overlay, lifted matte shadow tones."*

### Example 3: Strange Household Product (Surreal Deadpan Comedy)
* **❌ The Generic / Buzzword Prompt**:
  > *"Funny weird toaster advertisement, high quality, commercial studio lighting, vibrant colors."*
* **💡 The Art-Directed Causal Prompt**:
  > *"A deadpan, hyper-clinical commercial still of a gleaming chrome 4-slice toaster sitting alone on a manicured Kentucky bluegrass lawn under harsh, cloudless midday sun. Two pieces of completely charred, smoking rye bread protrude from the slots.  
  > **Props & Context**: A 50-foot heavy-duty bright orange industrial extension cord snakes from the toaster across the pristine green grass into the far distance, disappearing into a dense wall of pine trees.  
  > **Lighting**: Unrelenting, harsh direct sunlight (5600K) creating hard, black shadows directly underneath the appliance; blinding specular highlights glinting off the polished chrome toaster corners with natural starburst diffraction.  
  > **Camera & Styling**: Shot on Hasselblad H6D-100c medium format with HC 100mm f/2.2 lens at f/11 for edge-to-edge razor sharpness. Orthographic-like straight-on perspective, waist-level camera height. Palette dominated by vivid kelly green, bright orange cord, mirror chrome, and carbon black."*
