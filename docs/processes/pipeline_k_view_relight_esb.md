# Process: Pipeline K view relight (Nano Banana Lite on rendered views) on the Empire State Building

> **Recorded:** 2026-10-29
> **Status:** Needs Fix (runs on the ESB in every arm; none evens the light: Lite + anchor removes the trend and lifts the canyon slightly, but every relit arm leaves the photo seams further apart, so the seam gate reverts them)
> **Tags:** `operate-scratchbox` `pipeline-k` `texture-lighting` `view-relight` `empire-state`
> **Target Domain:** staged locations / pipeline K / twin textures

---

## 1. Session Context

* **What prompted this session:** the user asked for a way to run Nano Banana Lite across the 3D tiles' textures for even light, prototyped on the ESB. texture-lighting.ts already relit atlas charts one by one (29 of 57 passed the lock on the Washington Square Arch; never applied). The new step (`pipeline-k/view-relight.ts`, `SCRATCHBOX_K_VIEW_RELIGHT=1`, node graph `twin.viewRelight`) shows the model rendered views of the building instead, keeps only the detail-locked gain field, matches the tiles' exposures and carries the gain back to every photo texel by projection. It runs in the twin before harmonising.
* **Instance used:** web `3910`, API `3911`, tools `3912` (`scratchbox-view-relight` entry, this checkout), restarted between the arms with the flag on and off.
* **Scope tested:** two builds of "Empire State Building, 350 Fifth Avenue, New York", isolated, pipeline K, from the chat: run `60b4a8be` (relight on) and run `2e5525cf` (relight off). Tiles and remesh were served from the stage cache in both (the same input to the twin: 85,412 shared seam patches in both); the twin was computed fresh in both (the previous relight-off twin entry was moved aside for the off run and restored afterwards). Other sessions were working in the shared cache, so it was not cleared.

---

## 2. What Was Tested & What Worked (Verified)

* **Rendering and back-projection** — dry run on the 2026-10-29 00:29 twin with a pass-through model: 230 tiles planned, 26 empty, 204 sent; gain exactly 1.00 everywhere; 80% of the photographed surface seen by a view (the rest is mostly the interior shells the remesh keeps).
* **Live run 60b4a8be (on)** — `twin.viewRelight` ran 145 s inside the textures stage (183 s), 0 degraded stages, build committed in 380 s. Run note `pipeline_k_view_relight.json`: 204 of 204 views through the detail lock with `gemini-3.1-flash-lite-image`, 13 directions (8 level, 4 oblique at 40 degrees, 1 from above), 80 m tiles at 1024 px; tiles' spread 1.153x -> 1.048x after the exposure offsets; gain 0.86..1.10 (p5..p95).
* **Run 2e5525cf (off)** — `twin.viewRelight` logged `skipped`; same 85,412 seam pairs.
* **The gain does not follow materials** — correlation of the on/off log-gain (smoothed) with the photo's own pier/window detail: 0.016.

---

## 3. What Broke / Didn't Work

* **The light is not evened out.** Same input, both twins computed fresh:

  | measure | off (2e5525cf) | on (60b4a8be) |
  |---|---|---|
  | photo seams before harmonising (mean patch difference, log colour) | 0.1517 | 0.1558 |
  | photo seams after harmonising | 0.1263 | 0.1279 |
  | lowest 60 m against 60-120 m (wall luminance, before harmonising) | 0.74 | 0.73 |

  - Evidence: `docs/screenshots/view_relight_2026-10-29/ratio.jpg` (off, on, and the on/off log-gain: red brighter, blue darker). The gain is a height trend in all four sides: the crown and upper shaft brighter, the lower setbacks and base darker, which deepens the street-canyon darkening instead of lifting it. Mean |log gain| 0.041.
  - Suspected cause: Lite exposes each tile by its content (the crown against grey background comes back brighter, a full frame of dense facade darker). Per-tile offsets fix the differences where tiles overlap, but a trend that runs smoothly from tile to tile is indistinguishable from real light, so it survives. The step's own gates (lock, seen share, tile spread) do not measure the seams, so it reports `applied`.
* **An earlier comparison misled.** Against the 00:29 twin (a different remesh input), the on twin looked less blotchy. The fair pair above does not support that.

---

## 3b. Round 2: the anchor and the full model (same day, view-relight/2)

The two follow-ups from round 1, each run as a live ESB build from the chat, all on the same remesh (the off arm's twin key `acc43b23` and seams came out identical to round 1's, so the round-1 Lite arm is comparable too). Both relit arms ran with `SCRATCHBOX_K_VIEW_RELIGHT_GATE=0`, so their result is kept and measured; with the gate on (the default) both would have been reverted.

* **Lite + anchor** (run `1130be00`): `anchorM` 25 m, so each view's field loses its component at 25 m and above, and the model can only move what it sees within a frame.
* **Full Nano Banana, no anchor** (run `1eb26be0`): `SCRATCHBOX_TEXTURE_LIGHTING_MODELS=gemini-3.1-flash-image`, `SCRATCHBOX_K_VIEW_RELIGHT_ANCHOR_M=0`.
* **Off** (run `c01f9e98`): the twin computed fresh (textures stage `cached: false`); remesh from the cache the anchor run had just filled (uncached at that point: another session cleared the cache at 07:32).

| measure | off | Lite v1 (60b4a8be) | Lite + anchor | full Nano Banana |
|---|---|---|---|---|
| views through the lock | - | 204 / 204 | 204 / 204 | 187 / 204 (16 model failures, 1 rejected) |
| step time | - | 145 s | 168 s | 293 s |
| tiles' spread before -> after offsets | - | 1.153x -> 1.048x | 1.032x -> 1.031x | 1.175x -> 1.054x |
| relight's seam probe (49,019 pairs, single texels), before -> after | - | n/a (v1) | 0.2174 -> 0.2219 | 0.2174 -> 0.2268 |
| harmonise seams, before harmonising | 0.1517 | 0.1558 | 0.1564 | 0.1604 |
| harmonise seams, after | **0.1263** | 0.1279 | 0.1279 | 0.1300 |
| final twin, 0-60 m / 60-120 m wall luminance | 0.714 | 0.702 | **0.726** | 0.683 |
| final twin, 200-300 m / 60-120 m | 1.019 | 1.060 | **1.004** | 0.971 |
| mean abs log gain against off (two views) | - | 0.038-0.047 | 0.024-0.028 | 0.044-0.055 |

Evidence: `docs/screenshots/view_relight_2026-10-29/arms_view0.jpg` and `arms_view2.jpg` (off; each arm and its gain against off, red brighter, blue darker), `four.png` (all four from four sides).

* The anchor did what it was built to do: v1's building-scale trend (crown brighter, setbacks darker) is gone, and the canyon ratio moved the right way for the first time (0.714 -> 0.726, 200-300 m 1.019 -> 1.004). But the change is small, and the seams still got further apart.
* The full model relit more and agreed less: its gain is hard-edged rectangles and stripes the shape of single views, the canyon got darker, the seams furthest apart, and 16 calls failed (`Media model gemini-3.1-flash-image is unavailable`).
* No arm lines up with the off twin's dark blotches. The gate, on by default, would revert both relit arms on this building.

### Roofs (seen from above)

The relight covers roofs: 6 straight-down views and 58 at 40 degrees, all through the lock. Lite exposed the three kinds differently (mean tile gain: level 0.79, 40 degrees 0.91, top-down 0.99/1.01/1.03 R/G/B); the exposure offsets absorb that. On the final twins, seen from straight above (`docs/screenshots/view_relight_2026-10-29/top_arms.jpg`), against off:

| arm | roof-view mean luminance gain | mean abs log | R / G / B |
|---|---|---|---|
| Lite v1 | 1.079 | 0.089 | 1.067 / 1.085 / 1.090 |
| Lite + anchor | 1.010 | 0.056 | 1.008 / 1.012 / 1.014 |
| full Nano Banana | 1.151 | 0.172 | 1.165 / 1.146 / 1.137 |

In every arm the dark base roofs come back brighter (Lite v1 and the full model most), and the green roof gardens darker. Both read as the model taking a dark material for shadow and a saturated one for a colour cast: the twin's own roof rule (texture-harmonize.ts, tile-refine-twin.ts) gives roofs no shadow lift for exactly that reason ("a dark roof is a dark material"), and the relight does not follow it.

### The cast shadow on the upper decks

The tower's shadow across the setback decks below the crown (seen in the viewport, Lite v1) survives every arm. The cause is upstream of the fusion: Lite never took it off. In the straight-down view over the crown (`relight_d12_x0_y1`) the answer keeps the dark band (crop mean luma 116.2 sent, 114.7 answered), and the four 40-degree views' topmost tiles keep it too. Even one view that removed it would be averaged with the five that did not.

In the same views Lite repainted a pale setback roof teal (`relight_d11_x0_y1`). The detail lock checks edges and shift, not hue or chroma, so it passed; texture-enhance.ts's RECREATE_GATE has a hue/chroma check the lighting lock lacks.

## 4. Candidate Tool/Service Ideas

* **Cast shadows from the geometry** — the deck shadow is cast by the tower, which is in the mesh. Per roof photo, fit the sun direction that best explains its dark up-facing texels (shadow-map the mesh for each candidate), then lift the texels in the fitted shadow by the lit/shadow ratio of the same material across the shadow edge (photo-inferred). Accept a fit only when its shadow edge lands on the photo's edge. sky-delight.ts found no single sun across the ESB's tiles, so this has to be per photo, not per building.
* **Hue lock for the lighting lock** — reject an answer whose chroma or hue moves beyond the lighting's range in a region (RECREATE_GATE's check), so a recoloured roof does not become a gain.

* **Seam gate and anchor** — built in round 2 (`gate`, `anchorM` in VIEW_RELIGHT_PARAMS).
* **A/B arm in one build** — the node graph could run the twin twice (step on and off) on the same input and write both GLBs and a ratio map; this session restarted the instance and rebuilt.

---

## 5. Reproduction Steps

1. Add a launch entry with `SCRATCHBOX_K_VIEW_RELIGHT=1` (and `SCRATCHBOX_TEXTURE_LIGHTING_DUMP=<dir>` to keep each tile's original, answer and corrected image) on free ports; start it.
2. In the chat: "Build the Empire State Building, 350 Fifth Avenue, New York as a 3D building (isolated)."
3. Read `runs/<id>/pipeline_k_view_relight.json` and `pipeline_k_texture.json` (`seams`).
4. Restart with the flag at 0, move the matching `textures/<key>` entry aside if it exists, build again, and compare the two `pipeline_k_model.json` twins.
