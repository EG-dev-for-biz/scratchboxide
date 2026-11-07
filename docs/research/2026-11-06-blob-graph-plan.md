# The blob graph: every piece of a district understood, wrapped and rebuilt

**Date:** 2026-11-06
**Status:** Proposal. Nothing here is built yet, except the pieces named as existing.
**Asked for by:** the user, 2026-11-06: "distinguish every blob in a district, and use this logic on each."

## 1. Why

Pipeline K treats a building's tile scan as one surface to straighten and repair. What remains wrong after 22 trains is mostly what that view cannot fix:

- **Holes and seams:** they are gaps between the pieces K stitches together (scan, rebuilt facades, core, skirt), not cracks in one surface. Penn 2 shows 1.08% of its outside as holes, the Empire State Building (ESB) 0.73%, and the Flatiron 1.71% in its worst view.
- **Roof and street clutter:** tanks, bulkheads, kiosks, signs and railings stay as melted scan because nothing rebuilds them.
- **Districts:** the default look (massing) is extruded footprints, so it reads as a city model rather than the place. The best look (K-D) is slow and still carries every building's holes.

The scan is a collection of things: ground, buildings, things on buildings, things on the ground, trees and passing vehicles. Each should be rebuilt in the way that suits it, from a closed, measured first shape.

## 2. The idea in one paragraph

Split the district's scan into **blobs**, one per thing, and record what each touches and rests on. Measure each blob. Ask a vision model what it is, in open words, for labels only. Give each blob a **wrap**: one closed surface rolled over its outside by a ball sized from its own measured thickness. Then refine each wrap with the geometric operator its **measurements** call for (a facade rebuild, a solid of revolution, a sweep, a repeat, regrown vegetation), keep the wrap where no fit holds, and store every blob as its own versioned object.

## 3. The rules this must keep (AGENTS.md)

- **Measurements choose the geometry, never names** (§1.1-1.2, §1.5). The vision model's words are labels for prompts, filters, the provenance view and export. A blob gets a solid of revolution because it measures as one: its cross-sections are circles about one axis. Being called "tank" decides nothing.
- **The four operators** (§1.5): every refinement is a sweep, a solid of revolution, a repeat or a relief field, fitted to the blob's scan.
- **Provenance** (§4): wrap surface within the offset of the scan is `measured`. Surface the wrap invents to bridge a gap is `generated`, with its reason. Fitted operators are `measured` in their dimensions and `photo-inferred` where the photo decided, and every blob carries a confidence.
- **Buildings win over trees** (§4): where a split cannot tell tree from wall, the surface stays building.
- **Real data still leads** (§4): no fit may erase a feature the scan or the photos show. A fit that moves the surface beyond its tolerance is rejected, and the wrap stays.
- **No canned assets** (§1.6): nothing is replaced from a library. Vegetation regrows through SB-Veggie and the species library, which is the allowed data exception.

## 4. The blob graph (data contract)

One record per blob, kept in the scene object store (`scene-objects.ts`) as a new object kind, `blob`, synced to the place store (`place-store.ts`):

| Field | What it holds |
|---|---|
| `id` | Stable across runs: the Google vector feature id when one owns it, else a hash of the blob's scan geometry rounded to 5 cm |
| `parent`, `rests_on`, `attached_to` | Graph edges: the building a roof tank belongs to, the surface it stands on, the facade a sign hangs from |
| `scan` | The blob's scan triangles (indices into the welded extraction), its bounds and its surface area |
| `measures` | Continuous descriptors (§5.2) |
| `reading` | The vision model's open description, its numeric attributes, its confidence and the model used (§5.3), cached in the model readings store |
| `wrap` | Ball size and offset used, the wrap's GLB, its watertightness check, and its distance to the scan |
| `fit` | The operator chosen and why (which measurement decided), its parameters, its residual and coverage against the scan, accepted or rejected |
| `provenance` | Area shares of measured, photo-inferred and generated surface, each with a confidence |
| `versions` | As the object store does today: a new version becomes current only when none of its measures is worse |

## 5. The stages

### 5.1 Split: every triangle into exactly one blob

In this order, each stage claiming triangles so none is counted twice:

1. **Ingest and weld** (exists: `tile-seam-weld-service.ts`).
2. **Ground** (exists: `ground-classifier.ts`): the terrain surface and what lies flat on it (roads, pavements, grass).
3. **Buildings** (exists: the structure pick, `location_isolate_structure`, `location_split_block`, Google's vector footprints): one blob per building, its outline from the vector footprint when it fits the scan, else the scan's own.
4. **Vegetation** (exists: the tree strip, `scratchbox_tile_vegetation.hpp`, with the classifier evidence): one blob per crown.
5. **Transient things** (exists: `vehicle-removal.ts`): vehicles and similar, marked for removal and fill rather than rebuilding.
6. **Things on buildings** (new): within each building blob, remove the fitted roof and wall planes (K's `tile_refine` planes, the scan fitter's `scratchbox_scan_fit.hpp`). What stands proud of them by more than about 0.3 m splits into connected pieces: roof objects (tanks, bulkheads, plant), and facade attachments (signs, awnings, fire escapes, balconies). They are child blobs, attached to their building.
7. **Things on the ground** (new; exists in part as the residual audit, `residual-audit.ts` and `district-residual-audit.ts`): what is left after steps 2 to 6 splits into connected pieces: street furniture, kiosks, bridges, walls and fences.
8. **Unassigned:** whatever no stage claims is counted and drawn on the review sheet. The target share is below 1% of the scan's area.

Splits between touching things (a tree against a wall, a sign on a facade) carry a confidence. A doubtful split joins the larger blob rather than tearing either.

### 5.2 Measure

Each blob's descriptors are continuous numbers, computed natively:

- **Size:** bounds, area, enclosed volume (of its wrap), and height above what it rests on.
- **Thickness:** the distribution of its local thickness (thinnest part, median, thickest). This sets its wrap's ball size.
- **Shape:**
  - planarity (share of area on a few planes) and verticality;
  - axial symmetry (how well cross-sections fit circles about one axis);
  - elongation (how well it follows one curve, and how thin about it);
  - repetition (a dominant pitch along a line or surface);
  - porosity (how much the wrap at a large ball differs from one at a small ball: high for trees and lattices).
- **Appearance:** colour statistics from the tile photos, and roughness.
- **Context:** what it rests on, what it is attached to, and how far it is from the street.

### 5.3 Read intent (labels and attributes)

For each blob, the vision model sees a contact sheet: the blob rendered from four sides in clay, the same in the tile photos, its context (a wider view with the blob outlined) and, where registered, a Street View crop. It returns:

- an open description ("a riveted steel water tank on timber legs", "a pressed-metal awning");
- numbers: how manufactured versus organic, how permanent, how symmetric, the likely material and finish (roughness, metalness), each with a confidence;
- what to keep in mind when rebuilding it, in one sentence.

These readings label the blob, feed the material choice (as K's finish reading does today) and set the "permanent" score that marks transient things. They never pick the geometry. Readings are cached in the model readings store (`pipeline-k/model-readings.ts`), keyed by the blob's geometry hash, so a blob is read once across runs and machines. Several blobs share one call where they fit on one sheet.

### 5.4 Wrap

A new native module, `scratchbox_wrap.hpp`, with a CLI driver and a service, built from the published method (Portaneri et al., "Alpha Wrapping with an Offset", SIGGRAPH 2022), in a clean room: written from the paper, without reading CGAL's source, and with a patent check before shipping.

- **Input:** any triangle soup. Only distance to it is used, so holes, overlaps, flipped faces and doubled tile caps do not matter.
- **Two settings, in metres:** the ball size (gaps narrower than it are bridged, openings wider are carved into) and the offset (how far the result stands off the scan).
- **First version, on a grid:**
  1. distance to the scan, stored only near the surface (sparse), from the engine's `BvhTree`;
  2. free space is what lies further than the offset from the scan; shrink it by the ball size, flood-fill from outside, grow it back by the ball size;
  3. extract the boundary with corners kept (dual contouring);
  4. snap flat regions to fitted planes, and thin out flat areas.
- **Second version, if the grid's corners are not sharp enough:** the paper's refined tetrahedral form, with Shewchuk's public-domain geometric tests.
- **Output:** one closed, never self-crossing mesh, its distance to the scan per area, and which surface is measured (within the offset) and which bridged (generated).
- **Textures:** the scan's (or K's) colour and detail copied onto the wrap by casting rays from the wrap back to the source, with the provenance carried as a channel.
- **Settings per blob:** the ball size is about twice the blob's median thickness, clamped to 0.05-0.5 m for parts and 0.3-0.5 m for building shells; the offset is a few centimetres. Districts add coarser wraps for distance (§5.6).

### 5.5 Refine: the operator the measurements call for

| What the measurements show | Refinement | Acceptance check | Exists |
|---|---|---|---|
| A large blob, mostly vertical planes, storey and window rhythm in its photos | Pipeline K's facade rebuild, on the wrapped shell instead of the scan soup | K's own (window fit, facade reader, tear audit), plus zero holes from outside | K exists; on a wrap, new |
| Cross-sections are circles about one axis | A solid of revolution: profile, lobes, twist | Distance to the blob's scan within its tolerance over most of its area | Engine operator; `location_fit_object` |
| Follows one curve, thin about it | A sweep of a profile along the curve | Same | Engine operator |
| A dominant pitch along a line or surface | A repeat of a fitted unit | Same, plus the pitch's residual | Engine operator |
| Porous, organic colour, not manufactured | Regrow with SB-Veggie and the species library | Crown fit (existing tree stage checks) | Merged |
| Low permanence (vehicles, people, scaffolding) | Remove; fill what it hid from neighbouring surfaces and photos | No hole left where it stood | `vehicle-removal.ts`, in part |
| Flat, on the ground, wide | Part of the ground surface: one continuous terrain wrap with roads flat | Height residual against the scan | Partly (ground classifier) |
| Nothing fits within tolerance | Keep the wrap itself | Watertight, distance to scan | New |

A fit replaces the wrap only when it beats the wrap on distance and coverage, or matches them while being cleaner (fewer triangles, real parts). Otherwise the wrap stays and the reason is recorded.

### 5.6 Assemble, store and draw

- Every blob is its own versioned object. Its parent building, its ground and the district are assembled from the current versions, which is how the object and place stores already work.
- **Detail levels:** each blob also gets coarser wraps for distance (ball sizes of about 2 m and 8 m for buildings). Every level stays closed and crack-free, so districts draw far lighter.
- **The scan-wrapped massing look:** a coarse wrap of each real building (2-4 m ball) as a district option. It keeps true silhouettes, setbacks and roof shapes at massing cost, as measured geometry.

### 5.7 Review

- **Per blob:** the quality gate's scored review on the blob's contact sheet, against criteria from its reading. Low scores send the blob back for its next refinement, not the whole district.
- **Per district:**
  - a labelled sheet of the blob graph (blobs coloured by how they were treated);
  - the unassigned share;
  - holes from outside;
  - the before/after against the current look.

## 6. Phases

Each phase ends with a labelled sheet and the user's judgement before the next starts.

| Phase | Work | Proof (exit) |
|---|---|---|
| 0 | Building benchmark on current main (running 2026-11-06) | The baseline: holes, untextured and generated shares, and views for 11 buildings |
| 1 | The wrap module (grid version); building closure from the wrap in K, behind a switch | On the benchmark: zero holes from outside on every building, and no building looking worse than today's K by eye |
| 2 | Roof objects on the ESB and Penn 2: split (5.1.6), measure, read, wrap, fit, put back | Each roof object a clean part or an honest wrap; a before/after sheet of every roof |
| 3 | The blob graph for a whole district at the test place (Penn Station, 7th Avenue and West 32nd Street): every stage of 5.1, readings cached, blobs stored | Unassigned share under 1%; the blob sheet; the district assembled from blobs |
| 4 | District detail levels and the scan-wrapped massing look | Frame time and memory against today's district; side-by-side views |
| 5 | Facade attachments, street furniture, ground, and filling after transient removal | Per-blob reviews passing; street-level views |
| 6 | Defaults: what the user approves becomes the default look | The user's decision |

## 7. Costs

- **Vision readings:** one call per contact sheet of several blobs. Expected a few hundred calls for a dense district on first build, then near zero on later runs (cached). In the order of a few dollars per district.
- **Compute:** wraps are local, native and per blob, so they run in parallel and fit the K-D chunk runner, including in the cloud. A building shell at a 5 cm grid stored only near the surface should take seconds to a minute; to be measured in Phase 1.

## 8. Risks

- **Thin features disappear in a wrap** (masts, railings, cables). Detected by thickness and handed to the sweep fit before wrapping.
- **Recesses narrower than the ball are bridged.** They come back as texture and height detail, not geometry; judged by eye in Phase 1.
- **Splits are imperfect** where things touch. Confidence per split; doubtful splits join the larger blob.
- **Fits that are confidently wrong.** Every fit is checked against its scan, and the wrap is the fallback.
- **Texture sharpness lost in copying.** Copy at the source's own resolution; measure sharpness before and after.
- **Memory on districts.** Per-blob and per-chunk wraps, with the field stored only near surfaces.
- **The method's legal status.** A clean-room implementation and a patent check before shipping.

## 9. Decisions for the user

1. Does the wrap replace K's current closure chain, or run alongside it as a switch until judged?
2. The default ball size for building shells (0.3, 0.4 or 0.5 m): the trade-off between closing seams and keeping recesses.
3. Should the scan-wrapped massing look replace extruded massing as the district default, once judged?
4. Readings per blob cost model calls: is a few dollars per new district acceptable as the default?

## 10. Existing code this builds on

| Piece | Where |
|---|---|
| Seam weld | `packages/core/src/node/3d-engine/tile-seam-weld-service.ts` |
| Ground | `packages/core/src/node/3d-engine/staged-location/ground-classifier.ts` |
| Structure pick and isolation | `staged-location/orchestrator.ts`; `gemini/tools/location-evidence/isolate-structure.ts`, `split-block.ts` |
| Trees | `scratchbox_tile_vegetation.hpp`, the species library, SB-Veggie |
| Vehicles | `staged-location/vehicle-removal.ts` |
| Residual clusters | `staged-location/residual-audit.ts`, `district-residual-audit.ts` |
| Planes and fitting | `scratchbox_scan_fit.hpp`, `tile_refine`, `location_fit_object` |
| Distance queries | `scratchbox_bvh.hpp` |
| Objects and stores | `staged-location/scene-objects.ts`, `place-store.ts`, `place-store-best.ts`, `district-completeness-audit.ts` |
| Readings cache | `staged-location/pipeline-k/model-readings.ts` |
| District chunks | `staged-location/pipeline-k/district-chunks.ts`, the cloud chunk runner |
| Review | `gemini/quality-gate.ts` (scored review, #160) |
