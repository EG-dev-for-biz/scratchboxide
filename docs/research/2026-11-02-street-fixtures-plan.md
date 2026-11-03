# Street fixtures: the things that stand in a place (plan, 2026-11-02)

**What it is.** Between the buildings and the trees, a real place is full of fixed things: fountains, columns,
plinths, statues, lamp posts, bollards, benches, railings, steps, signals. At leaf LOD the 3D Tiles scan cannot resolve
anything under about a metre, anything thin, and anything sculpted, so today these read as melted lumps (Trafalgar
Square, 2026-11-02: the fountain bowls, Nelson's capital and statue, the lions and the equestrian statue are blobs; lamp
posts and signals are bent spikes; a car and a stall are baked into the paving; the fountain water is a flat painted
colour). This plan rebuilds them from measurement first, from registered Street View for what the scan cannot see, and
from labelled generated fill only where neither reaches (AGENTS.md §4, "Believability first").

**It needs one decision first.** The real-world plan (`2026-10-30-hyper-realistic-real-world-plan.md`) puts street
furniture out of scope for v1 (2026-10-30). This plan only starts once that is lifted, or once it is placed after that
plan's M2.

## What exists today (checked 2026-11-02)

More of this is built than the "out of scope" line suggests. What is missing is the middle: turning an identified,
measured cluster into a rebuilt object for anything that is not a dome or a mast.

| Part | Where | State | What is missing |
|---|---|---|---|
| Vehicles removed | `vehicle-removal.ts` | On in non-isolate builds: the vision model boxes vehicles in top-down crops, the lump is pressed onto the street around it and the texels mirrored (photo-inferred) | Skipped in a K isolate build (`PIPELINE_K_ISOLATE_SKIPPED`); other temporary things (stalls, tents, barriers, people) stay |
| Street clusters found and measured | `district-residual-audit.ts`, `residual-audit.ts` | Every cluster standing proud of the ground away from buildings, with size, thinness, closure, radial symmetry, cross-section constancy and periodicity; verdict real / artefact / unsure | Labels only; nothing changes the build |
| Scene inventory | `scene-inventory.ts` | Runs beside every district build: one `sb-feature/1` entity per building, road, water area, crown and street cluster | Labels only |
| Street View identification | `street-identify.ts` | Built and measured (Federation Square, Flatiron, 2026-10-22): panos every 12 m along the streets, four registered views each, one vision read per view, boxes cast into the scan's depth for place, height and width, matched to the inventory; 88% of labels right on a hand check | **Not wired into builds** (a driver only); about 10% of objects seen in two views, the rest duplicated; the grounding API serves US panoramas only, so London and elsewhere read the Static API (user decision, 2026-10-22) |
| Pose registration | `pano-registration*.ts`, `streetview-registered-views.ts` | Panos posed against the tile mesh (edges, then jointly), 0.25-0.35 m at Haughwout | — |
| Clean references | `streetview-clean.ts` | Occluders inpainted out of a registered view under the inpaint lock (generated, reference only) | — |
| Solids of revolution | `revolution-fit.ts`, `scratchbox_revolution_fit.hpp` | Wired into the district massing stage: summits found in the surface model, sections fitted as circles, one smooth profile, then rings, stacked parts and K-periodic ribs; the rebuilt volume cut out of the other layers and published as layer `l2v` (generated) | Tuned for roofs: `minRadiusM` 1.5, found from summits down, a swing over 6% of the radius rejects the part. A fountain bowl, a column shaft or a lamp standard is missed; a quatrefoil basin is rejected |
| Detail the scan cannot see | `revolution-reference.ts` | Search-grounded answers agreed across several runs (rib counts), labelled | Revolutions only |
| Thin vertical members | `location_fit_object` (`fit-object.ts`) | A mast or a radial bundle of legs as a sweep, from the audit's slices | A preview GLB only; nothing puts it into the build |
| Image-to-3D | Trellis: Trellis multi on Fal.ai (`fal-trellis.ts`) and the self-hosted Trellis services (`trellis1-multi`, `trellis2-generate`, behind `SCRATCHBOX_TRELLIS_SERVICE_URL`) | Trellis multi used for whole buildings, fitted to the scan by `register.ts`; the self-hosted services unavailable until the gateway is deployed | Never used for a street object. Meshy is not used here: it stays outside the codebase (user decision, 2026-11-02) |

## What the screenshot asks for, by kind

The kinds are how a cluster is rebuilt, decided from measurement, never from what it is called (AGENTS.md §1).

| Kind | Read from | Rebuilt by | Trafalgar Square |
|---|---|---|---|
| Temporary | The vision read (top-down crop, and its Street View read): "stands there only for a while" | Removed; the ground patched as vehicle removal does | The car, the stall, the blue and yellow patches, people |
| Round about a vertical axis | The scan's sections are circles about one axis | Operator 2, solid of revolution (exists, needs street scale) | Fountain centre bowls, the column shaft and drum, lamp standards |
| A plan curve with a profile | The scan's sections share one closed outline with periodic lobes, the profile constant along it | Operator 1, a profile swept along a fitted plan curve (Fourier r(θ) of any lobe count) | The quatrefoil basins' rims, kerbs, plinth mouldings, steps' nosings |
| Repeats at a pitch | The audit's periodicity along a line or curve | Operator 3, a replicator at the measured pitch | Bollards, balusters, railings, steps, bench slats |
| Sculpted | No operator family explains it (large fit residual), real per the audit, seen clear in enough registered views | Image-to-3D from clean registered views, fitted into the cluster's measured volume | Nelson's statue, the lions, the equestrian statue, the capital |
| A level surface in a basin | A flat surface held inside a closed raised rim, measured level | A water material on the measured surface | The fountain water |

## Milestones

**F0: See it.** Fresh, uncached district builds at two places (AGENTS.md memory: judge only uncached builds):
Trafalgar Square (every kind in one view; Static API panos) and Bryant Park (a US place on the grounding API; fountain,
lamps, chairs and balustrades). Screenshot each from three registered Street View poses and from above. Run the
district residual audit and read every real and unsure cluster by kind. *Exit:* a list of fixtures ranked by how much of
the street-level screen they cover, each with its kind and its audit numbers, in `docs/processes/` with a README row.
The order below is re-checked against it.

**F1: The splice** (before any rebuild can show). Generalise what the revolution layer already does
(`cutRevolutionsFromNodes`) into one step every fixture rebuild uses: the rebuilt object's volume is cut out of the
scan and the other layers, the cut is checked by a tear audit seen from the object's registered views (scan put back
over any torn pixel, as pipeline K's tear audit does), and the object is published as its own layer and object-store
entry with its provenance, confidence and fit residual in the GLB extras. `location_fit_object` writes through it
instead of a preview. Buildings still win: no fixture volume ever cuts a building. *Exit:* the existing revolution
layer and one `location_fit_object` mast go through the splice with no torn pixel, and the run note lists what was cut.

**F2: Identify every cluster from the street.** Wire `street-identify.ts` into the district build behind a switch
(`SCRATCHBOX_STAGED_STREET_IDENTIFY`, on once F0 has measured its cost), after the scene inventory. Add the
deduplication pass the findings asked for: each object projected into the other panos' views and asked "is this the
same object?". Each audited cluster then carries its registered views, its photo-inferred reading (form, permanence)
and the views it is seen clear in. Outside the US it reads the Static API, as decided. *Exit:* at both places, objects
seen in two or more views rise from about 10% to over half, and the labels stay at least 85% right on a hand check.

**F3: Take out what is temporary.** Run vehicle removal's method on every cluster the reading calls temporary (a stall,
a tent, a barrier, a person), from the same top-down crops plus the F2 street views. The decision is the model's
reading of permanence, never a noun list. Turn vehicle removal on around a K hero as well (it is skipped today), so the
square in front of a building is clean too. *Exit:* at both places, no temporary object left on the ground from the
three street poses; the patches seamless in the judge's ground mask.

**F4: Revolutions at street scale.** Let the revolution fit find parts that stand on the ground, not only roof summits,
and down to the size of a lamp standard: lower `minRadiusM` for parts whose clusters the street audit already isolated,
and use the existing thin-stack reading (masts as straight sections) for poles. Where the scan is too soft to place the
profile, fit it to the part's silhouette in registered, segmented Street View views (the profile's outline projected
into each view; photo-inferred, with the residual per view), never to a shading guess. *Exit:* at Trafalgar, the two
fountain bowls and the column's shaft and drum rebuilt as clean solids through F1, their scan RMS reported; at Bryant
Park, the fountain and the lamp standards.

**F5: Plan curves and repeats.** Extend `location_fit_object` with two families beside the sweep it has:
- a closed plan curve fitted to the cluster's sections as r(θ) with any lobe count and amplitude (a quatrefoil is lobes
  K = 4 at large amplitude, which the revolution fit rejects by design), and a profile measured across it, swept along
  the curve (operator 1);
- a seed fitted to one period and replicated at the measured pitch along a fitted line or curve (operator 3), the count
  from the measured length, never invented.

Each takes its numbers from the scan where it resolves them and from the registered views where it does not (a
baluster's profile, a bench's slat count), labelled per number as measured, photo-inferred or estimated, as the current
tool already does. *Exit:* the Trafalgar basins' rims and the terrace balustrade rebuilt through F1; at Bryant Park, a
row of bollards or a balustrade with the count matching the street views.

**F6: Sculpture.** A real cluster that no family in F4 or F5 explains (fit residual above a bar set in F0), seen clear
in at least three registered views from different sides: clean copies of those views (`streetview-clean.ts`) go to
Trellis multi-image (the self-hosted `trellis1-multi` once the gateway is deployed, else Trellis multi on Fal.ai; best of
several seeds by silhouette IoU against the views, as pipeline J's Trellis service scores them, `seed-score.ts`), and the
model is fitted into the cluster's measured volume and footprint (`register.ts`'s fit), its plan IoU and coverage
reported. Labelled generated throughout. No Meshy: it stays outside the codebase (user decision, 2026-11-02). Where
fewer than three clean views exist, the scan stays, with the reason. Cost per object is estimated in F0 before anything
runs (the spend rule: under $100 needs no approval). *Exit:* Nelson's statue and the
four lions at Trafalgar rebuilt and fitted, judged better than the scan in the fixtures mask (F7), with no decoy
passing.

**F7: Judged.** Add a fixtures mask to the world judge (real-world plan M1): the F2 objects projected into each
held-out Street View pose. Each of F3-F6 is scored against today's build in that mask, preregistered
(`judge-preregister`). *Exit:* every milestone above lands with a score in the fixtures mask no lower on the whole frame
and higher in the mask.

**F8: Water in basins.** A level surface held inside a closed raised rim (measured: the rim from F5, the level from the
scan) gets the water layer's shading (real-world plan M7: the probe's reflection, as glass has). Not drawn where no
level surface is measured. *Exit:* the Trafalgar basins read as water from the street poses.

## Order

- F0 first. F1 next: nothing after it shows without it.
- F2 and F3 then run side by side (street identification; the removal pass), and F4 beside them (revolution fit only).
- F5 after F2 (it reads the registered views); F6 after F2 and F1; F8 after F5 (it needs the rims).
- F7's mask is built with F2 and scores everything from F3 on.
- F2, F3 and F4 touch different files and are candidates for separate sessions.

## Decisions

Needed:
1. Lift "no street furniture in v1" (real-world plan, 2026-10-30), or place this after that plan's M2.
2. The two places: Trafalgar Square and Bryant Park.
3. Trellis spend for sculpture in F6, once F0 has the count, and whether F6 waits for the self-hosted Trellis gateway.

Already made, which this plan keeps:
- Street View outside the US reads the Static API (2026-10-22).
- Stitch Street View and the tiles whatever their era (2026-10-29): a statue moved since the scan is reported, not
  rejected.
- Image-to-3D for fixtures is Trellis only; Meshy stays outside the codebase (2026-11-02).

## Rules every milestone keeps

- Geometry comes from the four operators and the scan's measurements; what a thing is called is a label and selects
  nothing (AGENTS.md §1). No fixture catalogue, no named mesh library.
- Measured numbers lead; Street View sets only what the scan cannot resolve; generated fill only where neither does,
  with the reason.
- Every rebuilt fixture carries `measured`, `vector-modelled`, `photo-inferred` or `generated` per part and per
  number, with a confidence, in the GLB extras, the run note and the provenance view.
- Buildings win over fixtures as they win over trees.
- Every milestone ends in uncached builds and a labelled visual proof sheet in the chat.

## Out of scope

- Moving things (traffic, crowds, fountain jets) as animation: a later feature.
- Interiors seen through Street View indoor captures (the identification step already drops them).
- Signs' text and logos: the scan's photo stays the colour; no lettering is generated.
