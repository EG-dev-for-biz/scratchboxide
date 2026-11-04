# Process: Street residue — what the residual audit finds standing in a district's streets, removed and filled

> **Recorded:** 2026-11-03
> **Status:** Verified at unit level and offline on Penn K-D chunk 8's published layer; wired into district builds, **no in-app build run yet** (PR 4 of the surface infill series)
> **Tags:** `street-residue`, `residual-audit`, `surface-infill`, `vehicle-removal`, `provenance`, `penn-station`, `farley-building`
> **Target Domain:** Real-world 3D locations (staged district builds, the tree-stripped scan every later stage reads)

---

## 1. Session Context

* **What prompted this session:** the user walked 8th Ave in front of the Farley Building (W 31st to W 33rd, looking south)
  in the Penn K-D district (run c81d307d) and reported "a big lumpy brown pile sits in the roadway (a car remnant). Beside it
  is a tall black spike". The vehicle step never removed either: the pile was shown to the vision model and read as nothing,
  and the spike is too small to be shown.
* **Instance used:** none (offline). Chunk 8's tree-stripped scan stayed on the Cloud Run disk, so the offline run is on its
  published layer (`2_penn_plaza_new_york_kd_ground_tex_8_e4c12e6a.glb`, the same remesh K built on that scan), with
  Google's vector data for the district fetched once (no model call). Worktree
  `/Volumes/3DTESTING/scratchbox-ide/worktrees/surface-infill-residue`, branch `feat/surface-infill-residue`.
* **Scope tested:** `street-residue.ts`, its orchestrator block, `packages/core/test/street-residue.test.ts`.

---

## 2. What was found

* The pile is three of the district residual audit's clusters in 8th Ave's east lane, just inside the row of bollards in
  front of Madison Square Garden: #37 (8.5 x 2 m, 0.8 m thick, "unsure: no measure stands out"), #36 (unsure, real 0.58)
  and #41 (a real object by its own measures, 1.0). Area-weighted real-object score 0.33.
* The spike is #71 (with #106, a copy sheet inside its box): a twisted sheet 2.9 m tall at the north end of the bollard row,
  "unsure" (real 0.32, upright score under the bar). Its slice sizes swing 0.15, 0.39, 0.10, 0.58 m going up.
* The bollards are 57 clusters, unsure or real, every one slender (height over plan 2.4) with a constant cross-section
  (constancy 0.87-1.0, every slice the same size).
* A carriageway mask cannot tell them apart here: the measured kerbs (`measureRoadSurfaces`) jump 3 m across between
  stations, and the pile and the bollards are 2 m apart. The rule is therefore the clusters' own shape, not where they stand.

---

## 3. What was built

* **`selectStreetResidue`** (measures only, no names):
  * floating: an audit artefact touching nothing (floating score >= 0.5, gap to the ground and buildings >= 0.25 m) that
    no cluster left standing comes within 0.5 m of: deleted;
  * a lump: clusters wider than tall (height over plan <= 1.2), at most 2.5 m, joined when their plan boxes lie within
    0.75 m (the audit splits one melted pile), area-weighted real score under the audit's 0.6, at least 1.5 m² in plan,
    over no fixture the vehicle step's model read: patched;
  * a spike: a slender cluster whose section turns from growing to shrinking at least 3 times over at least 6 slices (a
    post keeps one section; a sign on a pole steps out and back once), neither real nor an upright: patched;
  * a piece inside a removed cluster's own box goes with it unless the audit calls it real;
  * everything else stays, with the measure that keeps it (slender, real, fixture, tall, small, near a standing cluster).
* **`removeStreetResidue`**: deletes the floating triangles by their world centroids; patches lumps and spikes with the
  vehicle step's own machinery (`vehicleCandidates` grid, the cells as carriageway debris, `vehicleRegion`'s skirt,
  `measureRings`, `measureStacks`, `patchVehiclesInGlb`) and the surface infill (`infillRegions`, `applyInfillToGlb`
  painted by plan); what stays is kept out of every region. Root extras `sbStreetResidue` (the infill's record nested).
* **Orchestrator**: in a district, after the tree strip, `deps.streetResidue` (true in the app's deps) and vector data:
  the audit on the stripped scan, the residue taken out, and `strip.devegetatedGlb` replaced for every later stage (cache
  key `street-residue/1` + audit + infill versions + the strip key + the fixtures read). A failure leaves the stripped
  scan as it is, with a run note. `SCRATCHBOX_STREET_RESIDUE=0` turns it off.

---

## 4. What was tested & what worked (Verified)

* **Unit** (`street-residue.test.ts`, native audit, no network): a lane street at 5 cm a texel with a crumpled brown pile
  over its dashed line, a second pile under a fixture the model read, two bollards and a hanging needle shard. The pile is
  one lump, the shard floating, the bollards slender, the read pile a fixture; the shard's 2 triangles deleted; the
  bollards' and the read pile's vertices unchanged; the pile's vertices within 3 cm of the street; no vertex 2.5 m past
  it moved; under 3 % of its core texels still brown; `sbStreetResidue` written. The spike rule's section reading on a
  post, a sign on a pole and #71's sizes.
* **Offline, Penn K-D chunk 8** (sheet `docs/screenshots/surface_infill_2026-11-03/farley_block_residue_before_after.jpg`):

| | Clusters | Result |
|---|---|---|
| Pile (lump) | 36, 37, 41 (22.7 m², 1.46 m) | patched; seam gate passed, rim ΔE00 0.93, directional + periodic continuation, 100 % photo-inferred |
| Spike | 71, 106 (2.9 m) | patched; its 322-texel fill failed the gate (between bollards), least bad kept, labelled generated |
| Floating | 79 clusters, 161 needle triangles 1.4-3.8 m up | deleted (they draw almost nothing) |
| Kept | 56 slender (the bollards), 6 tall, 2 small, 12 near a standing cluster | unchanged |

  Whole chunk: 19.6 s on the shared machine (load average ~390).

---

## 5. What is not done

* No in-app uncached district build with it yet (the load average stayed above 100, and no Cloud Run was used).
* Low shards at the bollards' feet stay: they lie under the audit's 0.85 m apron, so the audit never sees them.
* A real object on the street that the audit cannot call real and the model did not read (a planter it misread, a
  low barrier) would be patched; the fixtures the vehicle step's model read are the guard.

---

## 6. Reproduction Steps

1. `npx vitest run packages/core/test/street-residue.test.ts` (Node 22.18, credentials unset, empty HOME).
2. Offline: the scratchpad scripts `audit8.ts` (the district audit on a layer, vector data cached beside it) and
   `residue8.ts` (selection, then removal), bundled with esbuild; views with `lookviews.ts`, the sheet composed in Python.
