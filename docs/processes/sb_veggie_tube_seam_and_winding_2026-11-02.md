# SB-Veggie's tube seams and winding

**Date:** 2026-11-02
**Status:** fixed and verified. Every trunk and branch ring now has a seam column at u = 1. Every wood and leaf triangle
of the default tree turns counter-clockwise about its own vertex normals. A three.js render shows the trunk lit on its
sun side.
**Code:** `scratchbox_sb_veggie.hpp`: the trunk rings and their triangulation, `addBranchCylinder` (rings, quads, tip
cap), `SbVeggieBladeBuilder::append` (underside and petiole) and `appendFoliageCards` (the envelope normal transfer).
**Test:** `packages/core/test/sb-veggie-tube-seam-winding.test.ts`.

## The problem

Both faults turned up while the GLB writer's tangents were being verified (commit `4553767f` on
`claude/elastic-yonath-4dd0e6`, `glb_writer_uv_tangents_2026-11-02.md`, "Producer faults found on the way"). Neither
is a tangent fault: they are in the geometry SB-Veggie produces.

- **UV seam.** The trunk and every branch tube used `nextS = (s + 1) % radial` with u = s / radial. Each ring's last
  strip therefore ran u from (n-1)/n back to 0, squashing the whole bark texture backwards into one strip per tube. The
  tip caps of the twigs had the same wrap, and their fan centre sat at v = 0.5, behind the last ring's v = 2.5. That
  turned the cap's UVs the other way from the tube's.
- **Winding.** The trunk's ring turns from +x towards +z, clockwise seen from above. Its quads were indexed as the
  branches' are, so all 768 trunk triangles were wound clockwise about their outward normals. On the leaves, the upper
  side was right. The underside reversed the upper side's triangles but kept its normals: at the default
  `undersideNormalBlend` of 0.7, `N * -(1 - b) + N * b` normalises to the upper normal. The petiole's one triangle was
  wound against its normal as well. That left 13 of every leaf's 25 triangles clockwise.

What three.js made of it:
- **The trunk.** The bark material is single-sided, so its outer faces were culled and the inside of the far wall showed
  through. On a double-sided material the trunk was shaded with its normals flipped: dark on the sun side, lit on the
  shade side.
- **The leaves.** The foliage material is double-sided. Each underside triangle lies exactly on its upper triangle and is
  drawn after it, so it wins the depth tie. Seen from above it is a back face, so three.js negated its normal, and the
  crown rendered nearly black in sunlight.

## The fix

- **Seam column.** Trunk and branch rings have radial + 1 columns. The last column is computed at the first column's
  angle (`s % radial`), so its position, normal and shape-basis entries are bit-identical to the first's, but its u is 1.
  Skin weights are still pushed once per vertex inside the ring loop, so they stay in step. The quads index columns s
  and s + 1 with no modulo.
- **Tip caps.** The fan uses the seam column too, and its centre's v continues the tube's rate (2.5 over the branch)
  past the last ring. The cap's UVs now turn the same way as the tube's.
- **Trunk winding.** The quads are wound i00, i11, i10 and i00, i01, i11, counter-clockwise about the outward normals.
  The positions are unchanged, so the normals were not touched.
- **Leaf underside and petiole.** These are appended through `pushFacingNormals`, which winds each triangle
  counter-clockwise about the sum of its own vertex normals. With the default blend, which keeps the upper normals, the
  underside is wound as the upper side is. With a blend below 0.5, which flips them, it faces down. No normal is changed.
- **Envelope transfer.** `appendFoliageCards` pulls normals toward the crown envelope. An underside with flipped normals
  now takes the upper side's transferred normal, reversed. Without that, the transfer pulled a blend-0 underside back up
  across its own face: 95,026 triangles clockwise. A per-vertex version of this guard was tried first and dropped: on
  260 default vertices, about 90 degrees from the envelope, it moved the normal by 123 degrees, a jump inside a leaf.

**What did not change:**
- every triangle count;
- the wood's triangles cover bit-identical positions;
- the default tree's foliage positions, normals, UVs, colours and tangents are bit-identical (only the corner order
  within underside and petiole triangles changed);
- the fitter's objective, since triangle centroids are unchanged.

The template grows from 2,568 to 2,993 vertices, with 425 seam vertices. `sb-veggie-and-sb-terrain.test.ts` and
`sb-veggie-service.test.ts` pinned the old count and now expect the new one.

## Verification

**Measured on a fresh `run_sb_veggie --output x.glb`** (default tree, built with `env -i` and an empty HOME, measured with
a numpy GLB check). A pair of neighbouring wood triangles counts as "opposed" when their dP/du directions are more than
120 degrees apart, comparing across every shared edge with vertices welded by position so the seam joins its two
columns. A wrapped strip turns about 180 degrees. Neighbouring strips of a 4-sided twig are 90 degrees apart by geometry.

| | Before (`d291688d`) | After |
| :--- | ---: | ---: |
| Wood vertices / triangles | 2,568 / 4,064 | 2,993 / 4,064 |
| Wood triangles clockwise about their normals | 768 (the whole trunk) | 0 |
| Wood triangles with an edge spanning more than 0.5 of u | 664 (640 tube strips, 24 cap triangles) | 0 (the widest edge is a cap fan's 0.5) |
| Wood triangles whose dP/du is opposed to a neighbour's | 368 (up to 177 degrees) | 0 (at most 104 degrees, on the 4-sided twigs) |
| Wood triangles whose UV winding disagrees with most neighbours | 120 | 0 |
| Foliage triangles clockwise about their normals | 143,184 of 275,600 | 0 |

**Variants**, checked with the native evaluator. Each had 0 clockwise wood and leaf triangles:
- a shaped, posed tree in wind (all 16 shape modes, scaffold IK, wind);
- `undersideNormalBlend` 0 and 1, and 0 without the envelope transfer;
- a planted cluster (`SbVeggieFoliage::buildCluster`, used by `tree_lod`) at blends 0 and 0.7.

In the template, all 425 seam pairs have bit-identical normals, skin weights and shape-basis entries.

**Render** (three.js r186 in the app's browser pane; sun from the camera's left at (-6, 4, 3), hemisphere fill 0.25,
no shadows). Mean luminance (0-255) of the lower trunk, y 0.35-1.6 m, in white matte, double-sided, with no normal map:

| | Sun side | Shade side | Sun / shade |
| :--- | ---: | ---: | ---: |
| Before | 38.6 | 81.7 | 0.47 |
| After | 186.8 | 78.1 | 2.39 |

What the sheet's other rows show:
- **The GLB's own single-sided bark:** before shows the inside of the far wall; after shows the trunk whole, lit on its
  left.
- **A u hue ramp, looking straight at the seam column:** before, one strip carries the whole ramp backwards; after, the
  ramp ends at u = 1 and starts again.
- **The whole tree as written:** the crown goes from nearly black to lit, because the leaves' undersides no longer win
  the depth tie with flipped normals.

Proof sheet (gitignored): `docs/screenshots/sb-veggie-seam-winding-2026-11-02/sb_veggie_winding_seam.png`, with
`seam_row.png` and `metrics.json`.

**Tests**, run with `env -i` (PATH only) and an empty HOME, so no credentials were reachable:

- **`sb-veggie-tube-seam-winding.test.ts` (new): 2/2 passed.** It compiles a probe against the engine headers, writes
  the default tree's GLB and measures it in TypeScript: 0 clockwise wood and leaf triangles, 0 opposed dP/du, widest
  u edge 0.5, 2,993 wood vertices. It also checks:
  - the 425 seam pairs (normal, skin weights, shape basis);
  - the posed tree, both blends and the planted clusters.

  Run against `HEAD`'s header it fails. Its measuring functions applied to the old GLB give 768 / 143,184 clockwise
  and 368 opposed, with a widest u edge of 0.9375, the same as the numpy check.
- **The SB-Veggie and tree tests:** 18 files in one run, 121 passed, 5 skipped, 1 failed:
  - `sb-veggie-and-sb-terrain`, `sb-veggie-service` (both with the new vertex count), `sb-veggie-lockdown`,
    `sb-veggie-fit-objective`;
  - `botanical-tree-tools`, `tree-mid-lod-cards`, `tree-lod-contract`, `tree-crown-density`, `tree-crown-shading`,
    `tree-crown-photo-check`, `tree-texture-library`;
  - `tile-vegetation-lod`, `tile-vegetation-support-cluster`;
  - `native-build`, `mvp-4step-pipeline`, `in-tree-3d-worldbuilder`, `adaptive-3d-scene-synthesizer`,
    `universal-nature-and-atmosphere`.

  The failure was one `sb-veggie-lockdown` test whose Python script type check timed out (`timed_out` where
  `rejected` was expected) while 18 files compiled in parallel. Run alone, `sb-veggie-lockdown` passed 10/10.

## Not done here

- **The leaf underside is a coincident copy.** At the default blend it is wound as the upper side and coincides with it.
  Under the double-sided foliage material, the two sides now share their shading normal from either side, but their
  colours (`leafColor`, `undersideColor`) still z-fight. `undersideNormalBlend` lerps between -N and N, so only its side
  of 0.5 matters. Whether the underside should be dropped, offset, or given its own shading model is a decision for the
  generator's design.
- **The UV handedness of trunk and branches differs.** The trunk maps the bark rotated 180 degrees about the outward
  normal; the branches mirror it vertically. Both are consistent within their tubes, and tangent w handles either.
- **The tangent writer's majority vote.** The writer on `claude/elastic-yonath-4dd0e6` votes at each vertex because of
  the wrapped strips. With the seam column, SB-Veggie's wood no longer needs the vote. It stays useful for other
  producers.
