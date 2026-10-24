# Consistent building imagery from the tile scan: depth/point-cloud massing tests, even light, the outline check, and the character sheet

Date: 2026-10-23 to 2026-10-24. Buildings: E.V. Haughwout (488 Broadway), Puck Building, Cooper Union Foundation Building (all New York). Commits: `6ac37dc8`, `3605f803`, `2b8e81d6`.

The question: how far can the scan itself, and AI Beautify imagery made from it, be used as evidence for a building's shape, and how do we keep that imagery consistent (structure, colour, subject isolation) across views. Experiments ran in scratch scripts; what held up is now in `packages/core`.

## 1. Massing from the scan (experiments, not shipped)

All on a fresh `location_isolate_structure` of Haughwout (raw clay GLB), facade axes found from the minimum-area rectangle of the raised scan.

| Method | What it gave | Verdict |
|---|---|---|
| 5 orthographic depth maps (4 facades + top) back-projected to a point cloud, space-carved | Solid massing, 15,448 m³; roof tiers 24.0 m and 15.5 m found by mode clustering; one wall plane per street face (85-90 % of samples) | Works. Needs back-face culling (open party walls otherwise hollow the building) and facade holes treated as unknown, not empty |
| + Canny/Hough on the depth maps, lines snapped to the facade axes, each straight depth step made a hard boundary | Straight roof edge, setback and tier edges; surface 146k -> 120k boundary voxels at equal volume | Helps edges, not facade noise |
| Blurred point cloud (0.5 / 1 / 2 m) | Removes slivers and relief; rounds every corner; 2 m loses the setback; fit to scan 79 % -> 45 % | Denoiser only; chain with plane snap if used |
| Tile photo (ortho photo views) lines checked against depth: steps move geometry, flat "painted" lines kept as storey/bay grid | 73 photo lines confirmed as steps, 170 painted lines; diagonals are glazing/shadow noise and must be dropped | Photo mainly tells what the building is (storeys, bays), small massing gain |
| Lines from beautified survey images ray-cast onto the massing | Storey stack 5.25 / 9.75 / 14.25 / 18.75 / 23.75 m (4.5 m pitch), cornice agreeing with the depth maps' 24.0 m roof | Best storey evidence; trust only inside the scan outline |

## 2. What AI Beautify invents, and the fixes (shipped)

First survey run (orbital stations, clay render, sun from "now"): colour differed per view (cream vs black cast iron), a full arched facade was drawn on the open party-wall side, a skyline was painted in, and the facade was drawn ~4 bays wider than the scan (14 % overflow).

Shipped in `6ac37dc8`:

- **Even light for every 3D-feeding beautify** (user decision): `buildStationBeautifyPrompt` now uses `EVEN_LIGHT_SENTENCE` (bright overcast, no cast shadows) and drops the sun clause; `lighting: 'scene'` keeps sun/mood only when the image is the final 2D picture. Render/video deliverables build their own prompts and are unchanged.
- **Building-survey mode** (`survey_beautify_station` `mode: 'building-survey'`): renders from the tile photos, adds `OUTLINE_LOCK_SENTENCE`, and runs `checkStationOutline` inside the station QC: above the horizon, non-sky outside the scan outline = overflow, sky inside it = underfill, both < 3 %, subject wholly in frame; failures reroll. Colour distance is 8-bit Lab (lightness x2.55): true-CIELAB units could not tell a grey facade from a grey overcast sky.
- **Sun-time bug:** the route recomputed the sun at call time (night: -60° in every prompt); it now uses the instant the stations were planned for.
- Result on Haughwout: overflow 14.1 % -> 1.6 %; a corner frame that painted a Manhattan skyline was rejected after 3 tries, labelled.

Chaining stations (each accepted image warped into the next as a style reference) took the colour spread between stations from ΔE 16.4 / 9.7 to 2.6 (harness test; not wired into the route).

## 3. The character sheet (shipped, `3605f803` + `2b8e81d6`)

The user's method: one 4K Nano Banana 2 image prompted as a character sheet on white with four views, so every view is one generation.

- `survey_beautify_station` with `stationIds` (four) -> `building-character-sheet.ts`: the four tile-photo station renders in a 2x2 sheet on white, one 4K `gemini-3.1-flash-image` call, split back into the station frames; every panel must pass the edge QC and `checkStationOutline`, and the sheet must carry no dividing lines or borders (`checkSheetBorders`), else the whole sheet is regenerated.
- **The framing lock is essential** (`CHARACTER_SHEET_FRAMING_LOCK`, "a registration sheet, not a presentation sheet"). Without it the model enlarged, centred and flattened the long face into an elevation: 127 % outside its outline. With it every panel stayed registered.
- **Dividing lines:** on Cooper Union the model drew a black cross between quadrants despite the prompt, and every panel passed (the outline check's speck filter removes 1 px lines). `checkSheetBorders` flags it at 100 % coverage and passes the clean sheets.

| Building | Attempts | Panels in outline | Time | Notes |
|---|---|---|---|---|
| Haughwout (hand-placed stations) | 1 | 4 / 4, 0 % overflow | 34 s | 5504 x 3072 |
| Puck Building (auto-planned stations) | 1 | 4 / 4, 0 % | 40 s | baked-shadow black side of the scan drawn as the same red brick |
| Cooper Union (auto-planned) | 1 | 4 / 4, 0 % | 43 s | dividing lines -> now rejected |
| Flatiron | - | - | - | not testable: isolation falls back to a district twice (vector footprint pick ~118 m² of a much larger wedge) |

Aerial panels cannot be outline-checked (no sky above the horizon); they still pass through the edge QC.

## Open items

- Chaining for the single-station route (colour lock) is proven in a harness only.
- Station framing (street to roof objects) is still the caller's job; the automatic 4-view planner used for Puck/Cooper is a scratch script (min-area rectangle, two adjacent faces with most scanned wall, corner, aerial) and frames the corner/aerial too loosely on large plans.
- Storey-line agreement across views is measured, not enforced.
- Flatiron isolation (split vector footprint) is a separate isolation bug.
