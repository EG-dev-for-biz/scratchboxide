# Process: Facade material reading (glass, measured coursing) in the staged texture pass

> **Recorded:** 2026-10-18
> **Status:** Needs Fix (works end to end behind `SCRATCHBOX_FACADE_MATERIALS=1`; merged to main 2026-10-19 and judged again with a specular renderer: still no gain, stays off; see [facade_materials_merge_eval.md](./facade_materials_merge_eval.md))
> **Tags:** `operate-scratchbox` `staged-build` `texture-pass` `open-segment` `provenance` `pbr-kernel`
> **Target Domain:** Real-world 3D locations (textured twins)

---

## 1. Session Context

* **What prompted this session:** the texture pass paints windows with the reflected sky and trees and every wall as one diffuse photo; the PBR kernel draws every material as FBM noise. Task: read glass and masonry per region from the photos, accept only what held-out evidence supports, render glass as glass and measured coursing through the kernel.
* **Instance used:** web `3073`, API `3071`, tools `3072`, started from the `facade-materials` worktree (`node desktop-app/scripts/dev.js` with `SCRATCHBOX_NO_ELECTRON`, `SCRATCHBOX_FACADE_MATERIALS=1` and, as uncommitted local scaffolding, `SCRATCHBOX_TEST_ISOLATE_IOU_MIN=0.25`). Headless builds through `scripts/dev/staged-replay.ts` (recordings in the session scratchpad `fm/rec`, the arch on a copy of `mv/rec`).
* **Scope tested:** the masks (Street View crops and frontal tile faces), the per-region decision, the glass write, the coursing measurement, the kernel's structured pattern, the twin's material channels, the viewport's glass reflection probe and the provenance stripes.

---

## 2. What Was Tested & What Worked (Verified)

* **Synthetic suite** (`packages/core/test/facade-materials.test.ts`, 15 tests): two agreeing panos accept a window (interior from the 10th-percentile texel, roughness 0.05, provenance `facade-material-reading` / photo-inferred with the confidence in G, photo kept as fallback); one pano alone, a pano the tile contradicts, a mask leaking over a facade, and a pano left out (LOO) do not write glass; the tile alone needs a darker pane in a lattice; coursing read at 0.068 m for a drawn 0.0677 m pitch, joint 14 mm, phase within 5 mm; a 40 % dark band is rejected as not a joint; the kernel's profile; the GLB channels and extras.
* **Washington Square Arch** (replayed evidence, marble, no glass): before the fixes the tile masks proposed uniform marble panels as glass (accepted 7 + 2 + 1 regions) and a 1.14 m moulding repeat as coursing; after (tile-only glass must be darker, a joint at most 25 % of the pitch and 40 mm): 0 glass texels and 0 coursing on every layer. Leave-one-pano-out fit identical to the flag-off baseline on every layer (l2 8.315 px / NCC 0.085, l3b 7.336 / 0.097, l3cf 8.088 / 0.026); walls before/after the reading identical. Texture stage 440.9 s against 434.7 s (masks replayed; live masks added 93 s with one Python worker).
* **Haughwout Building** (live in the app, isolation forced by the local scaffolding; the fit is rejected so no Street View view exists): the scan's 24 planar faces read from the tile, 169 segmentation calls in 74.7 s; 403 candidate regions, 141 accepted by the tile (darker, in a lattice), 262 rejected, 1.3 % of the texels written as glass. Twin loads with `sbMaterial`, the probe is set (`envMap` present), provenance legend row "glass read from the photos ... (1% of texels)", no console errors.

---

## 3. What Broke / Didn't Work

* **Puck Building:** never isolates (`containment_failed`), so the texture pass never runs there. **Haughwout, Flatiron, Jefferson Market, Faneuil Hall, Independence Hall, Cooper Union, Tweed Courthouse:** `isolate_mismatch` or the fit is rejected on current main, so the Street View evidence stage is skipped and the Street View half of the reading was exercised on synthetic data and the arch only.
* **Visual result on Haughwout:** glass panes render as flat blue-grey blocks with stair-stepped edges (the tile masks are at the tile's ~0.15 m texel) that also cover mullions; the probe from the layer's centre clips everything within the layer's half-extent (80 m for this 140 m layer), so the reflection is mostly the backdrop. Not an improvement a viewer would pick over the photo.
* **Masks:** the open-vocabulary segmenter outlines at most ~8 instances per image (hence 3x3 crops) and leaks over whole facades in some crops (seen on the Haughwout cast iron in a Broadway photo); the per-texel agreement rules keep those out.

---

## 4. Candidate Tool/Service Ideas

* **Isolation for row buildings** — split a joined block at height steps / party walls so Puck and Haughwout reach the fit and Street View stages (being fixed by another agent).
* **Per-facade reflection probes** — one probe per face, outside it, instead of one per layer.
* **A metric for glass** — the LOO texture score compares albedo with photos, which by design rewards painted reflections; a view-dependent score (render with the probe from each held-out pose) would measure whether glass helps.

---

## 5. Reproduction Steps

1. Worktree `facade-materials`; link `secrets.json`; `SCRATCHBOX_FACADE_MATERIALS=1` (optionally `SCRATCHBOX_FACADE_MATERIALS_DEBUG_DIR=<dir>` to write every read image with its mask).
2. Headless: `SCRATCHBOX_REPLAY_DIR=<rec> SCRATCHBOX_ROOT=<worktree> node -r ts-node/register scripts/dev/staged-replay.ts --query "Washington Square Arch"`; the run note `texture_fit.json` carries `materials` per layer.
3. App: build "Haughwout Building, 488 Broadway, New York", Show real textures, Provenance.
