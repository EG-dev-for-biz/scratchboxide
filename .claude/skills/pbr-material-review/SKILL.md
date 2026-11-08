---
name: pbr-material-review
description: Review the roughness, metalness and grain of a Scratchbox build's materials the way an experienced PBR texture artist would, from screenshots of the app viewer (raking-sun close-ups, glass and stone), the twin's ORM maps and the run's material note, against the repo's own reference of measured finishes and artists' rules (packages/core/src/common/spatial/pbr-artist-reference.ts). Use after any change to pipeline K's material regions, finish read, set pick or the viewer's material look, whenever a build looks too shiny, too metallic, too flat or too patterned, and before claiming a material change is better.
---

# PBR material review

The reference is code, not this file: read `packages/core/src/common/spatial/pbr-artist-reference.ts` first. It holds the measured roughness ranges by how a surface looks (`PBR_REFERENCE`), the rules artists follow (`PBR_ARTIST_RULES`) and the few numbers the pipeline applies (`ARTIST_FINISH`). The same text is what the in-app vision model is told when it reads each class's finish (`pipeline-k/material-finish.ts`) and picks its set (`pipeline-k/material-choice.ts`), so a review and the pipeline judge by one standard. Never change a range here or in the skill without changing it there.

## What to gather

1. **The numbers.** The run's `pipeline_k_materials.json` (cache `staged_location/runs/<run>/`): per class its share, the expert's read (`finish.read`: roughness, metalness, grain, coverage, conf, seen), what was drawn (`finish.drawn`), the set and the pick; `texels.glass`, `frameTexels`, `panesOnStone`.
2. **The texels.** The twin's ORM maps, measured per texel: the share with metalness above 0.1, roughness below 0.4, and either (the reflective share). A measuring script that parses the GLB and reads every `metallicRoughnessTexture` (G roughness, B metalness) is enough; compare main and the branch on one shared answer store (`SCRATCHBOX_MODEL_READINGS_DIR`).
3. **The pictures.** App-viewer close-ups (operate-scratchbox; the session window open) of each building's glass and stone at a raking sun (about 12 degrees up, along the facade), a few metres out, the same camera on every side.

## How to judge, region by region

For each region in a close-up, name what it is, what the reference says it should be, and what the picture shows:

- **Metal.** Metalness is 0 or 1. A dark or shaded wall drawn with a metallic sheen (tinted, mirror-like highlights on stone, spandrels or mullions that read painted) is wrong; so is any class drawn at an in-between metalness (0.1 to 0.9) in the note. Bare metal you would see on the real building (stainless, anodised, bronze) may be 1, rough 0.25 to 0.7.
- **Stone, concrete, brick, render.** Rough, 0.7 and up: a broad soft highlight under a raking sun, no reflected image, no sheen band along the facade. A readable reflection on masonry is wrong unless the photo shows polished stone.
- **Glass.** Smooth (0.05 to 0.15): it mirrors the probe and the sun's glint. A pane drawn matte or patterned is wrong.
- **Frames, mullions, sills, spandrels.** Not glass: 0.35 to 0.6 when painted or anodised, the wall's roughness when stone. A window drawn as one glassy block with its frames is wrong.
- **Grain.** How much the surface varies at a metre's scale: glass and polished stone nearly none; weathered stone, brick and concrete clearly. A checker or a repeating figure that the photo does not show (a library tile's own pattern) is wrong, as is a weathered wall drawn perfectly even.
- **Dirt and weathering** raise roughness: a city facade above the street should not look showroom-new.

When unsure between two readings, the rougher, non-metal one is usually right: a wrongly matte surface looks less wrong than a wrongly shiny one.

## Report

One line per building: the reflective share (metal above 0.1, roughness below 0.4, either), what drives it (the classes and their reads, glass panes, frames), and the regions in the pictures that break a rule, each with the rule. End with the pictures in one labelled sheet (verify-visually rule) and say what a fix would change, not only that it looks better. Give a small subagent the claims and the pictures for an independent look before calling anything done.
