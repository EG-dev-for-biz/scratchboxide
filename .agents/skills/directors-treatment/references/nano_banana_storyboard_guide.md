# Nano Banana 2.1 Storyboard Artwork & Visualization Guide

> *"Storyboard frames in a director's treatment aren't generic stock photos or fantasy illustrations—they are proof of camera vision. With Nano Banana 2.1, we direct every frame with exact lenses, lighting ratios, brand typography, and cinematic blocking."*

---

## 1. Why Nano Banana 2.1 Over Legacy Generators

Nano Banana 2.1 (Google's Gemini 3.1 Flash Image architecture) replaces legacy diffusion engines (like Midjourney) by leveraging semantic reasoning, native text rendering, and high-efficiency multimodal generation:

1. **Natural Language Cinematography**: No disjointed comma-separated tag soup (`photorealistic, 8k, unreal engine 5`). Nano Banana 2.1 understands directorial grammar, lighting falloff, lens distortion, and emotional staging.
2. **Native Text & Typography Rendering**: Nano Banana 2.1 can cleanly render on-screen titles, packaging typography, and storefront signage when enclosed in double quotes (e.g., `"VELOCITY"` in bold geometric sans-serif).
3. **Multi-Reference Consistency**: Supports character and product identity locking across shot-by-shot storyboard sequences.
4. **Direct Execution in Scratchbox**: Prompts are rendered into real image files with the in-app `generate_image` tool (`prompt`, `aspectRatio: "16:9"`, `name`), which returns each file's path and served URL and names the model that answered.

---

## 2. The Nano Banana 2.1 Storyboard Prompt Formula

Every key storyboard frame prompt must follow this structured natural language blueprint:

```
A photorealistic cinematic film still of [Subject & Action/Emotion] in [Environment & Setting]. 
[Lighting Setup & Extracted Brand Color Palette]. 
Captured from [Camera Framing & Angle] on [Camera Body & Lens Choice, e.g., ARRI Alexa Mini LF with 35mm anamorphic prime glass]. 
[Atmosphere, Tactile Textures & Depth of Field]. 
[Optional: Specific Text in Double Quotes on Signage/Packaging]. 16:9 cinematic widescreen.
```

---

## 3. Core Directorial Components Breakdown

### A. Subject & Human Performance
Describe exact physical posture, micro-expressions, and spatial relationships:
- *"A woman in her early thirties sitting on a rain-streaked windowsill, her shoulders dropping in quiet relief as steam rises from her ceramic mug."*
- *"Two chefs working in synchronized chaos in a cramped copper-clad kitchen, caught mid-motion as one plates a dish with surgical precision."*

### B. Extracted Brand Color & Lighting Integration
Seamlessly infuse the brand's primary, secondary, and accent colors into the practical lighting and production design:
- *"Illuminated by warm amber practical lamps (#D4A373) with a deep twilight indigo (#1D2D44) ambient falloff through the floor-to-ceiling windows."*
- *"Clean architectural daylight bounce, featuring crisp white highlights and rich terracotta undertones (#C85A32) in the linen wardrobe."*

### C. Camera, Lens & Depth
Use real cinematography terminology to anchor the visual style:
- **Lenses**: `Panavision C-Series anamorphic prime`, `Cooke Speed Panchro 50mm f/1.4`, `Zeiss Master Prime 21mm ultra-wide`, `85mm portrait telephoto`.
- **Camera Movement & Angle**: `Low-angle tracking profile`, `intimate Dutch-tilt push-in`, `medium close-up with shallow focus`, `wide atmospheric tableau`, `over-the-shoulder witness shot`.
- **Sensory Texture**: `Subtle halation around practical lights, gentle organic 35mm film grain, soft lens flare, tactile dust motes suspended in sunlight`.

### D. Typography & Graphic Assets Rendering
When the shot calls for hero product packaging or title cards:
- *"A sleek matte aluminum can centered on a wet granite slab, featuring the exact brand logo \"LUMEN\" in minimalist bold sans-serif lettering."*

---

## 4. Scratchbox Tool Integration (`generate_image`)

When writing the treatment or visualizing frames for the agency pitch, generate the actual image files with the in-app tool, one call per frame:

```json
{
  "prompt": "A photorealistic cinematic film still of a solitary runner paused at dawn on a wet coastal asphalt road, steam rising from their breath. Backlit by a low golden sun with deep cobalt blue shadow tones (#1A2B4C) and subtle warm gold rim light (#F2A900). Low-angle 50mm prime shot on 35mm film stock, shallow depth of field, sharp water droplets on pavement. 16:9 cinematic widescreen.",
  "name": "storyboard_frame_01_dawn_run",
  "aspectRatio": "16:9"
}
```

For identity across frames, pass earlier frames or the product plate in `referenceImages` (workspace paths, URLs or data URIs). The result lists each image with its `path`, served `url`, `modelUsed` and a `modelNote` naming the model that answered and why any earlier one was skipped; every image carries `provenance: "generated"`.

Then embed the returned `url` directly into Markdown:
```markdown
![Frame 1: Dawn Awakening](/build/generated-images/storyboard_frame_01_dawn_run_1760950000000.png)
```

The tool fails with an error, and writes no file, when no image model or credential is available: say so instead of substituting a placeholder.

---

## 5. Storyboard Frame Prompt Examples by Genre

### Automotive / Adventure Commercial
```text
A photorealistic cinematic film still of a matte charcoal electric SUV navigating a switchback pass in the Scottish Highlands during a brooding autumn drizzle. The vehicle's amber LED daytime running lights carve through low-hanging valley mist. Captured from a dynamic low three-quarter tracking angle on an ARRI Alexa Mini LF with Panavision 40mm anamorphic glass. Reflections of wet heather and slate rocks shimmer on the vehicle body. Atmospheric volumetric haze, desaturated slate tones punctuated by vivid amber light. 16:9 cinematic widescreen.
```

### Beverage / Food Commercial
```text
A photorealistic cinematic extreme close-up of a frosted amber glass bottle resting on an outdoor weathered teak table at dusk. Fine droplets of icy condensation bead and trickle down the cold label, which bears the word "SOLSTICE" in crisp embossed serif typography. Warm golden-hour side lighting catches the effervescent golden liquid inside, creating a warm bokeh flare against a blurred lush Mediterranean terrace. 85mm macro lens, ultra-shallow depth of field. 16:9 cinematic widescreen.
```

### Tech / Human Connection Commercial
```text
A photorealistic cinematic medium shot of an elderly grandfather and his seven-year-old granddaughter sitting cross-legged on a wooden living room floor, assembling a wooden puzzle beneath warm tungsten lamplight. Gentle, unguarded laughter caught mid-expression. The room is styled in warm earthy neutrals and deep sage green accents (#3A5A40). Shot on a 35mm prime lens with natural soft window fill and organic film grain, intimate and grounded. 16:9 cinematic widescreen.
```
