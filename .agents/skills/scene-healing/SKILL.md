---
name: scene-healing
description: >-
  Diagnose and heal any 3D scene, scan or generated model: cracks and T-junctions between pieces, steps, grooves,
  overlapping strips, melted photogrammetry, spikes, holes, inside-out surfaces, untextured fill and doubled skins.
  Measure first, name each defect by its geometry and where it sits, apply the smallest bounded fix that keeps measured
  geometry honest, label every change, and confirm from outside views. Use whenever a scene looks broken, melted,
  cracked, holed, spiky or seamed, before proposing or running any repair.
---

# Scene healing

Healing makes a scene read as one believable surface **without misrepresenting what was measured**.

1. **Measure before fixing.** A defect needs a number and a location. Count it, bucket it, map it.
2. **Name defects by geometry, never by subject.** A crack is a crack on a roof, a tree or an alien hull. Decide
   repairs from measured quantities, never from what the object is called.
3. **Smallest bounded move.** Measured geometry moves only within its own error (a tile's geometric error, a weld
   tolerance). Anything beyond that is a fill, labelled `generated` and given its reason.
4. **Confirm from outside.** A fix counts only if views from around and above show fewer holes, less untextured
   surface and fewer smears than before, with nothing worse elsewhere.

## 1. Defects and how to measure them

| Defect | How it shows | Measure |
|---|---|---|
| Crack | dark hairline where two pieces meet | distance from each open-edge vertex to the nearest open edge or vertex of another piece; histogram 0 / 1 mm / 5 mm / 1 cm / 3 cm / 10 cm / 30 cm |
| T-junction | hairline that sparkles even when "closed" | that nearest point lies inside an edge, not at a vertex |
| Step | a line with one side higher | vertical part of the offset across the seam |
| Groove or ridge | V-shaped line on flat ground | seam height minus the median ground height 1–1.5 m around it (flat ground only) |
| Overlap | flickering strips, doubled surfaces | top-down raster per piece; cells where two pieces both have surface within a few cm in height |
| Facet crease | straight lines across flat areas | shading jump along an interior edge of a coarse surface; not a seam |
| Melting | rounded corners, rippled walls, blobbed detail | plane-fit error of large regions; corner sharpness; difference from a fitted rebuild |
| Spike | a lone vertex poking out | offset from its neighbourhood average against the local median absolute deviation |
| Hole | see-through, or the inside visible | open edge loops; outside views where the nearest surface is a back face |
| Inside-out surface | photo lit from behind | seen only from behind from outside, and facing into the object |
| Untextured fill or smear | grey patches; streaked texture | outside views: share of pixels untextured, or with one-way stretched texture |
| Doubled skin | flicker; fill over a real surface | a surface within a few cm of another, facing the same way |

## 2. Diagnose

1. **Find the step that introduces it.** Measure the input, then after each processing step. The first step that
   raises a number owns the defect.
2. **Locate, then look.** Map defects top-down or per wall; at the worst spots, cut a height profile across the seam
   or cast a ray and list every surface it crosses, in order.
3. **Tell look-alikes apart.** A line may be a facet crease or a groove, not a crack; a "hole" may be an inside-out
   piece or a fill cap seen from behind. Fixing the wrong kind makes things worse.
4. **One change at a time.** Keep a change only when its defect drops and nothing else rises; otherwise revert it.

## 3. Fixes, in the order a scan should get them

### 3.1 Seams between pieces (first, straight after loading)
```
for each open-edge vertex v of piece A:
    q = nearest open-edge point of another piece B
    if dist(v, q) <= tol:                       # tol = max(3 cm, error of the coarser piece)
        if q is a vertex and piece(A) > piece(B): move v onto q    # one side moves; targets read from original positions
        if q lies inside edge (a, b) of B:       move v onto q; split triangle (a, b, c) at q, UV interpolated along a-b
revert any move that turns a triangle inside out; drop triangles the weld collapses into slivers
```
- **Overlaps:** where two pieces cover one patch within `tol`, keep the lower piece id and drop the other's triangles
  that lie wholly over it; repeat while new open rims are still covered.
- **Steps and grooves:** spread the measured mismatch as a smooth correction that fades out over 1–2 m on one side,
  never more than the piece's error; label it a seam blend.
- **Normals:** average across closed seams, keeping creases sharper than about 30°.
- **Colour:** one gain per piece, plus a smooth offset field fitted where pieces share surface; keep it only if the
  seams get closer.
- Report the gap histogram, T-junction and overlap counts, and the largest move, before and after.

### 3.2 Spikes
```
L(v) = cotangent-weighted neighbour average − v
flag v when |L(v)| > k · MAD of |L| over its neighbourhood      # k around 3–4
for flagged v only: λ/μ smoothing (λ > 0, μ < −λ), 3–5 passes, each move clamped
```
Never smooth the whole mesh: that is melting by another name.

### 3.3 Melting: recover structure, don't smooth
- **Plane snapping:** filter normals while keeping edges, grow flat regions by area (not face count), then:
  a vertex on one plane goes onto it; on two planes, onto their line; on three, onto their corner point. Vertices
  only move, so texture survives. Report mean, 95th-percentile and maximum deviation. `tile_refine` does this.
- **Footprint plus scan:** where the scan is too melted to snap, the measured footprint fixes the outline and the
  scan gives heights and roof planes; build a clean polyhedral solid from them (`vector-modelled` + `measured`).
- **Facade detail from photos:** read openings from straightened photos and rebuild on those lines; nothing outside
  the footprint.

### 3.3a Choosing among the ways to improve a melted city scan
There are four known approaches. Pick by what must survive.

| Approach | Logic | Keeps | Loses | Use when |
|---|---|---|---|---|
| **Snap in place** | detect planes, snap vertices to planes, lines and corners; topology and UVs untouched | the measured surface and its photos | nothing unbounded; melted detail stays melted | the default first pass |
| **Replace and bake** | build simple solids from measured footprints and heights; project the scan's photos onto them (a cage projection: cast rays along each new surface's normal into an offset cage of the scan, take the texel hit) | clean, closed geometry | the scan's real relief, ornament and irregular shapes | the scan is too melted to snap, or a closed low-detail model is the deliverable |
| **Rebuild from photos** | fit a new surface to many rendered or captured views | can recover shape the mesh lost | measurement honesty (it is an estimate of an estimate) | never from renders of the scan itself: project known geometry forward instead |
| **Add detail from street-level photos** | project registered ground-level photos onto the straightened facade; read openings, mullions and depths from them | the measured massing | nothing, when the photos are registered and labelled `photo-inferred` | facade detail the aerial scan never resolved |

```
heal_city_scan(scan, footprints, street_photos):
    scan = close_seams(scan)                                  # §3.1, always first
    scan = snap_in_place(scan)                                # §3.3 plane snapping; report deviation
    for each structure s:
        if planarity_error(s) > limit or coverage(s) < limit:
            s = replace_and_bake(footprint(s), heights(s), photos_of(s))   # label vector-modelled + measured
        if street_photos cover s: s.facades = detail_from_photos(s, street_photos)  # photo-inferred
    measure; keep each change only if the outside check improves
```
No published method fixes seams between pieces, keeps the measured scan and labels its fills, or recovers melted
ornament inside the scan itself. Those steps are this skill's own, so measure them carefully.

### 3.3b Resolving window placement
Openings are read from evidence and placed on the measured wall. They are never scattered by rule. Find them in 2D on
a straightened facade, then place them on the wall's plane.

```
place_windows(wall):
    plane  = fitted plane of the wall (measured)
    ortho  = the wall's photo, straightened: storey and pier lines traced, warped straight
    mask   = facade mask: drop sky, trees, neighbours, signage and street clutter before any reading
    # evidence, each a per-pixel score in [0, 1] on the ortho
    e_lat  = repeat lattice: periodic darker cells at a bay pitch and storey pitch (autocorrelation peaks);
             each site scored by contrast against the pier/spandrel beside it
    e_seg  = open-vocabulary segmentation of "window" on the ortho (an independent second opinion)
    e_scan = scan evidence: inside the fitted bays, holes, dips behind the plane, or missing returns
             where glass gave no surface
    e_st   = registered street-level photos projected onto the plane, where they cover it
    score  = weighted vote of the available evidence (weights by each source's measured agreement on checked walls)
    sites  = lattice sites inside the mask with score >= accept
    # completion: a site flanked by accepted sites on both axes is a window unless it looks more like the wall beside it
    sites += flanked lattice sites whose look matches the accepted ones          # labelled photo-inferred
    # rejection: keep a pane only where it reads unlike the stone beside its window
    sites -= sites whose texels are mostly the wall's own appearance class
    resolve conflicts: where two sources disagree by more than one cell, keep the lattice site only if a second source
                       agrees; else leave the cell as wall and report it as uncertain
    place each site on the plane at its measured recess (scan depth where resolved, else the photo's contrast rule,
                       never shallower than the scan measures)
    return sites, uncertain cells, per-source agreement
```

Rules:
- **Evidence beats rhythm.** Continuing a rhythm into parts no photo reached (generated) is allowed only within the
  wall's outline and only where neighbouring sites on both axes are accepted.
- **Conservative over wrong.** A missed window is a smaller defect than glass on stone. When the score is in the
  uncertain band, leave the cell as wall and report it.
- **One grammar per wall, not per photo.** Coplanar overlapping facade patches are one wall. Read the bay grammar from
  all its photos together; a setback level's walls share one grammar fitted from all their read bays, laid on each wall
  except where its own photo shows plain wall.
- **Straighten before reading.** Detection on a straightened ortho is markedly more accurate than on a skewed photo.
- **Measure against a checked set.** Report per wall: found / missed / false placements against hand-checked windows,
  intersection-over-union of the window rectangles, and window-to-wall ratio error. A change is kept only when found
  rises without false placements rising.

### 3.4 Holes
```
for each open loop:
    split a long loop where it nearly touches itself
    if the rim strays off its best-fit plane over a large cap: leave open, count it
    triangulate: repeatedly cut the ear with the shortest closing edge (in the loop's plane, else in 3D)
    drop any fill triangle that pokes outside the object's envelope,
         that lies on a surface already there, or that a rebuilt surface already covers
```
Never shrink-wrap a scene into one closed shell: that destroys measured detail. A visible grey cap is worse than a
small honest hole.

### 3.5 Inside-out surfaces
Turn a triangle only when outside views see its back and hardly its front, **and** a ray along its normal hits the
object (it faces inward). A surface seen from behind that faces open air (an overhang's underside, the far side of a
hole) stays as it is, so a hole is never hidden by turning the wall behind it.

### 3.6 Texture
Fill takes the texture of the surface it continues (planar mapping from the nearest rebuilt face, labelled
`generated`), or stays untextured with its reason. Smeared slivers leave the textured copy but stay in the clay.

### 3.7 Vision judge with a confidence gate
After the measured checks, render crops of each flagged region from several views. Ask a vision model for a structured
verdict per region — `defect`, `feature` or `uncertain`, a confidence, and the crop it relied on. Apply a fix only above
the confidence threshold, and only from the bounded fixes above. Report the uncertain regions. The judge chooses fixes;
it never moves geometry itself.

## 4. Simplifying without losing structure
Weight each edge-collapse cost (quadric error) by:
```
cost = quadric_error · (1 + w_prov · crosses_provenance_boundary · rank(provenance))
                     · (1 + w_sal · saliency) · (1 + w_n · normal_inconsistency)
rank: measured = vector-modelled > photo-inferred > generated
```
Ridges, window reveals and provenance boundaries survive; never collapse a building edge in a tree's favour.

## 5. Generators for fills (continuous parameters only)
- **Poisson-disk scatter** (minimum distance, density field) for irregular debris, rubble, clutter and greebles.
- **Voronoi or Delaunay cells** (count, jitter, relaxation passes) as relief patterns: panels, fracture, paving.
- **Offset + Chaikin smoothing** to turn a rough outline into a clean carrier curve, inset or panel line.
- **Constraint placement:** place discrete elements by relations over continuous parameters, not by hand.

## 6. Avoid
- Copying a renderer's on-screen mesh: whatever detail level was drawn, unwelded, with nothing repaired.
- Repair aimed at 3D printing (one closed shell): wrong goal for scenes.
- Whole-mesh smoothing, remeshing that drops UVs, or decimation that smears the texture.

## 7. Report every heal
1. Before: each defect kind, with its worst places.
2. The change, its bound and its provenance label.
3. After: the same measures from the same views.
4. What got worse, and whether that is acceptable.
5. What remains, and why (no clean measurement, unsafe cap, low judge confidence).

Never claim a heal you did not measure, and never call a fill measured.
