# sand3d against our procedural objects: which ideas fit `sb`

2026-11-07. Survey of how Scratchbox builds procedural 3D objects today, compared with
[Sandflow-ai/sand3d](https://github.com/Sandflow-ai/sand3d) (Apache-2.0), with a recommended order and a first
prototype (named faces and edges, on this branch).

**Short answer.** None of sand3d's code can come in. It builds geometry with Blender's `bpy`/`bmesh`, and AGENTS.md
§3.1 requires geometry from our C++20 engine. Several of its ideas fit our `sb` scripting well, though. The best is
named faces and edges carried through edits. It is now prototyped in the native engine. Next come loud failures for
silent mistakes, a source fingerprint on every build, a shorter guide, and frames as the one way to repeat. Joints, and
the datasets as an evaluation set, are worth doing after those. The datasets are an evaluation set only, never training
data: training a model of our own is the user's decision.

## 1. How Scratchbox builds a procedural object today

There are two paths, and they share the native engine.

**A. Scripts.** `execute_3d_python_script` runs an `sb` Python script.
- Tool: `packages/core/src/node/gemini/tools/python-3d-tools.ts`. Runner: `NativePythonRunnerService`
  (`packages/core/src/node/3d-engine/native-python-runner-service.ts`).
- The script imports `scratchbox` (`packages/core/src/python/scratchbox/`). That package wraps `scratchbox_native`,
  the nanobind module built from `packages/core/src/native/3d-engine/bindings/python_bindings.cpp` over the C++
  headers in `include/`.
- Before running, basedpyright type-checks the script against stubs generated from the live module
  (`sb-script-typecheck.ts`, `scripts/gen_sb_stubs.py`). It blocks calls to API that does not exist. It does not
  catch unused arguments or silent no-ops.
- After running: a part-connectivity check, a vision review of three clay views in chat (`visual-review.ts`), and
  `GeometricComplexityGate`, which is advisory for scripts (`python-3d-tools.ts:553-557`).
- Recorded in the scene: `pythonGenerator {sourceCode, glbPath, sbApiVersion, typeCheck}`. `sbApiVersion` is a hash
  of the stubs. Neither the script nor the engine build is hashed.
- The rules are `SB_PYTHON_SCRIPT_GUIDE` in `prompt-builder.ts`, read on demand through `read_sb_script_guide`.

**B. Reference builds.** `build_3d_object_from_reference` (`object-reference-tools.ts`, `reference-object-builder.ts`):
1. Draw a reference image.
2. A model reads it into an `ObjectBuildSpec` (`common/spatial/object-build-spec.ts`).
3. `sb.object_spec.build(spec)` interprets the spec deterministically (`python/scratchbox/object_spec.py`). Each part
   uses exactly one operator: `sweep | revolve | replicate | relief | crown`, plus box/cylinder `cuts` and an
   `edgeRadiusMeters`. Children attach by `(u, angleDeg)` on the parent's evaluated surface. Parts are addressed by
   `id`, and labels are never read.
4. Checks: missing parts, detached children, body count, size, and a vision diff of clay and materials renders.
   There are up to two revision passes. A build that never passes is rejected.
- The scene keeps `objectBuild {spec, record, checks}` and the generated `object_spec_build.py`. There is no spec hash
  or seed.

**Edits after the build.**
- `object_detail_pass` (`object-detail-tools.ts`, `object-detail-pass.ts`, `scratchbox_object_detail.hpp`): wear
  and decals, chosen per part by glTF node name (the spec part id).
- `mesh_edit` (`mesh-shaping-tools.ts`, `scratchbox_mesh_edit.hpp`, `scratchbox_mesh_edit_ops.hpp`): BSP booleans,
  plane cuts, extrude/inset, wedge-cut bevel, shell, mirror, array, decimate, fracture.
- `universal_3d_structure_*`: a foundation mesh plus point cloud, camera rig, collision hulls and exports. There are
  no joints.

**Before this branch, nothing selected a face or an edge by name.**
- `sb.meshops.bevel` bevels every edge sharper than an angle.
- `sb.meshops.inset_extrude` and `mesh_edit`'s `FaceSelection` pick faces by a direction cone plus a box in fractions
  of the bounds.
- `mesh_edit`'s bevel picks convex edges by angle plus a box.
- A part on another part is placed by computed offsets, or by the object spec's `(u, angle)` attach.

**Engine behind it.**
- `scratchbox_engine.hpp` umbrella.
- `scratchbox_shaper.hpp`: `Loft3D`, `Lathe3D`, `Sweep3D`, `Replicator3D::onGrid / alongCurve`.
- `scratchbox_mesh_ops.hpp`: exact booleans, offset bevel, inset/extrude, solidify.
- `scratchbox_mesh_edit.hpp`: BSP CSG, wedge bevel.
- `scratchbox_relief.hpp`, `scratchbox_sdf_field.hpp`.
- The architecture and vegetation grammars.

**Gate.** `GeometricComplexityGate` (`common/spatial/GeometricComplexityGate.ts`):
- 25,000 vertices for scenes, 5,000 for props.
- 70-20-10 is measured only as "at least 2 submeshes"; the skill says 3.
- It is not run on `build_3d_object_from_reference`.

**App skills.**

| Skill | o200k tokens | Rules about naming parts, placement, repeats, verbs |
|---|---:|---|
| `python-3d-procedural-director` | 5.7k | Four operators; joint-first assembly; `add(mesh, name)`. Now also named faces and edges. |
| `universal-3d-structure` | 2.4k | One anchor, project outward. Nothing on naming. |
| `3d-artist` | 3.1k | 70-20-10 hierarchy and a checklist. |
| `3d-object-visual-critic` | 1.6k | Five-pillar critique. No naming or placement rules. |

## 2. What sand3d is

sand3d is a Python CAD-like layer over Blender.

**Verbs** (`docs/api.md`):
- Profiles: `rect`, `circle`, `poly`, `spline`, `station`...
- Solids: `extrude`, `revolve`, `sweep`, `loft`, `body`, `wire`, `box`, `cylinder`...
- Edits: `cut`, `join`, `hole`, `pocket`, `fillet`, `chamfer`, `shell`...
- Frames: `Frame`, `ob.face`, `ob.edge`, `bbox`, `local`, `at`.
- Repeats: `grid`, `ring`, `along`.
- Joints: `joint`, `pose`.
- Export: `.glb` with joints in extras, `.urdf`, `.usda`.

**What makes it good:**
- Every face and edge is named by its maker (`_core.py` `Builder`, `write_tags`), and the names survive booleans and
  bevels (`edit.py` `_retag`). A program says `fillet(plate, 1, edges="top")` or `at(stem, on=base.face("top"))`.
- Mistakes are loud (`_guard.py`, `edit.py` `NothingCut`). A cut that misses, an object used after a boolean consumed
  it, and an `at()` result nobody used all raise, naming the program line.
- A 159-line reference plus eight rules for writing an assembly program (`docs/guidelines.md`).
- Five CC BY 4.0 Hugging Face datasets of programs paired with reference meshes: objaverse, cad, articraft, simready,
  automate.
- It claims 2-6x fewer tokens than Blender Python, CadQuery, FeatureScript or Articraft for the same part
  (`docs/readme/tokens.md`).

**What we must not copy:**
- Named shape verbs as the way to make things: `gear`, `knurl`, `thread`, `box`, `cylinder`, `wedge`, `dome`.
- A closed material list: `material(ob, "oak" | "steel" | ...)`.
- These break ADA §1.1/§1.5 (four operators, no category verbs) and §1.6 (materials chosen by appearance and scale,
  not a category key).
- Its ban on `chair()` matches our rule. Its parts library does not.

## 3. The seven ideas

### 3.1 Faces and edges addressed by name, kept through edits — FITS (prototyped here)

**What it replaces.**
- Direction cones and fraction-of-bounds boxes (`inset_extrude`, `FaceSelection`, `BevelOptions.region*`).
- Angle-only bevel.
- Hand-computed placement offsets.

These go wrong quietly when a part changes size: the box catches a different edge, or the angle catches every edge.

**Fit with ADA.**
- A name is an open label. It selects geometry for an edit and never chooses how geometry is made.
- The only fixed words are the makers' own topological roles: `top bottom start end` for caps, `side` between walls,
  `chamfer`/`fillet` for a bevel's faces. These describe operator topology, not categories of thing.
- Owner qualifiers (`plate.top`) are free text.

**Where it went (this branch).**

| What | Where |
|---|---|
| Data | `ScratchboxMesh::faceGroup` (per triangle) and `faceGroups` (`FaceGroup {names, edgeKind, edgeKindAlways}`) in `scratchbox_geometry.hpp`. `append` carries them. An operation that rebuilds triangles without them leaves the vector the wrong length, and every named lookup then says the names were lost. |
| Names, lookups and refusals | New `scratchbox_named_topology.hpp`: edges derived from faces as sand3d derives them, `faceFrame`, `placeOnFace`, refusals that list the names the mesh has and suggest what was meant. |
| Makers | `footprints::extrudePolygon` (walls split into surfaces where the outline turns by 30° or more, so a circle has no `side` edges) and `ScratchboxMesh::createBox`. Bindings take `name=`, which also writes `name.top`... |
| Edits | `meshops::bevel(edgeNames)`: the offset bevel for closed loops. It falls back to the new `mesh_edit::bevelNamedEdges` (wedge cuts) for any other set, such as a single edge ending at a corner. Concave named edges are refused. `CsgPolygon::tag` carries names through BSP splits. `sb.geometry.boolean_mesh` keeps both operands' names. `creaseNormals` keeps them. |
| Python | `mesh.face_names()`, `edge_names()`, `face_frame(name)`, `place_on(target, face, u, v, gap, spin_deg)`, `sb.meshops.bevel(..., edges="top")`, `sb.create_box(..., name=)`, `sb.geometry.extrude_polygon(..., name=)`. |
| Tests | `packages/core/test/sb-named-faces-edges.test.ts` (5 cases on the real engine). |
| Instructions | Script guide (`prompt-builder.ts` §7) and the procedural-director skill. |

**Cost.**
- About 600 lines of C++, a day.
- Memory: 4 bytes per triangle on named meshes only.

**Next steps, not done here:**
- Names from `create_lathe` (rims), `create_sweep`/`create_loft` (start/end) and `sb.meshops.union/subtract`.
- Names on the object spec's parts, so `object_detail_pass` decals and `edgeRadiusMeters` can name a face.
- Concave fillets: today they are refused, because a cut cannot add material.
- The edge where a tool meets the part (sand3d's `edges="peg"`).

### 3.2 Loud failures for silent mistakes — FITS, small

Checked on this machine:
- `sb.meshops.subtract(a, b)` with `b` wholly outside `a` returns without a word (12 → 28 triangles).
- So does `sb.geometry.boolean_mesh(..., "subtract")`.
- `inset_extrude` with a box that holds no face returns the mesh unchanged.
- `bevel(width=0)` does nothing.

sand3d raises `NothingCut` in each case, naming the boxes.

**Where.**
- A `nothingCut` check in `meshops::booleanOp` and in the `boolean_mesh` binding: no face of `b` survives in a
  subtract, or the result equals `a`.
- An "empty selection" refusal in `meshops::insetExtrude` and `mesh_edit::selectFaces`.
- Unused script arguments: sand3d's guidelines found 31% of programs declare a dimension they never read. The same
  check fits `sb-script-typecheck.ts`: turn on basedpyright's `reportUnusedVariable`/unused-parameter as warnings
  returned with the result, never blocking.

**Cost:** half a day.

**Replaces:** silent no-ops that a vision review later reports as "looks wrong", one revision later.

### 3.3 A token-compact API and eight rules — FITS PARTLY

Measured with o200k_base:

| Text | Tokens |
|---|---:|
| `SB_PYTHON_SCRIPT_GUIDE` (43,456 chars, including the 14.0k-char API summary) | 12,638 |
| sand3d's whole `docs/api.md` | 3,643 |
| sand3d's eight rules (`docs/guidelines.md`) | 6,272 |
| Our procedural-director skill | 5,731 |

Most of our guide is policy (provenance, buildings, location staging). sand3d has none of that, because it does not
stage locations or label provenance. So the 3.5x gap is not all waste.

**What fits.** Rules 1-5 and 8 map onto ours, and four are missing from our guide:
- Rule 1, "the head is the table of contents": one function names the parts and places them.
- Rule 3, "name each dimension once, derive the rest": with the 15-numbers-per-part target and the unused-argument
  check from 3.2.
- Rule 4, "place each part once, in its parent's frame": now possible with `place_on` and `face_frame`.
- Rule 5, "repeat with frames, mirror with a copy, never cos/sin in a loop": see 3.5.

Our skill already has joint-first assembly.

**What does not fit.**
- Rule 6, "say each shape with the verb that names it": it relies on named shape verbs. Ours is "say each shape with
  one of the four operators".
- Rule 7's material kinds.

**Where.** A short "WRITING AN OBJECT PROGRAM" block at the top of `SB_PYTHON_SCRIPT_GUIDE`, and the same four rules
in the procedural-director skill. Separately, split the API summary out of the guide (it is already its own module,
`sb-api.generated.ts`), so the guide's own text can be measured and kept short.

**Cost:** an hour to write. A live check in the app (operate-scratchbox) to see that scripts follow it.

### 3.4 Joints and articulation, exported to GLB extras, URDF and USD — FITS, medium-large, later

Today nothing in the object spec, `sb` or `mesh_edit` makes a joint. The only joints are skinned rigs: humanoid
`scratchbox_kinematics.hpp`, SB-Rig, and the skinned-GLB writer in `scratchbox_io.hpp`. There is no URDF anywhere,
and USD appears only for materials.

**Fit with ADA.** A joint's kind is a kinematic dimension (revolute angle, prismatic length, continuous, fixed). It
constrains how a part moves, not what it is, the same standing as glTF's buffer layout. Fine under ADA §1.3.

**Where:**
- An optional `joint {kind, axis, frame, range, follows, ratio}` on `ObjectPartSpec` (`object-build-spec.ts`), with
  the frame read on a named face of the parent (needs 3.1 on spec parts).
- `sb.joint(child, parent, frame, ...)` for scripts.
- A writer: node `extras.scratchbox.joint` in `scratchbox_gltf_scene.hpp`, a URDF writer (one link per moving part,
  meshes beside it), and later `UsdPhysics` through the existing USDZ path.
- `pose()` for previews in the viewport.

**Cost:** about 3-5 days with tests. Nothing in it calls a model.

**Replaces:** nothing yet. It opens articulated props (doors, lids, dials, wheels).

### 3.5 `grid` / `ring` / `along` against our affine replicator — FITS AS AN API CHANGE, small

We already have the operator:
- `Replicator3D::onGrid / alongCurve` (rotation-minimising frames, continuous pitch, fit to length).
- `replicate_metric_array(CURVE_1D | POLAR_RING)`.
- The object spec's `replicate` (ring or path, mirror pairs).

sand3d's difference is that a repeat is a list of frames, and every verb takes that list:
- `at(peg, on=ring(...))` places copies;
- `hole(plate, d, on=grid(...))` drills a bolt circle;
- `cut(ob, at(tool, on=frames))` cuts a row of slots.

So "repeat" is one idea, not one function per verb.

**Where.** `sb.frames.grid / ring / along(curve, pitch | count)` returning frames (origin, normal, x-axis), the same
struct as `face_frame`. `place_on` and booleans then take a list of frames. Back it with `Replicator3D`'s frame code,
so the copies stay on the affine replicator operator.

**Cost:** a day.

**Replaces:** cos/sin loops in scripts, and per-verb repeat parameters.

### 3.6 Determinism and a source fingerprint with each build — FITS, small

- sand3d records `fingerprint()`, a digest of the library source, beside its version, and sorts mesh elements after
  bevel and boolean so a run is the same on any thread count (`edit.py` `_sort_mesh`).
- We already fingerprint the native build: sha256 over the engine sources, in `native-python-runner-service.ts`.
- We stamp `sbApiVersion`, but do not record it on the build.
- Pipeline K is byte-for-byte repeatable (`docs/processes/k_determinism.md`).

**Where.** Add `{scriptSha256, engineFingerprint, sbApiVersion}` to `pythonGenerator`, and
`{specSha256, engineFingerprint, interpreterVersion}` to `objectBuild.record`. Mirror both into
`asset.extras.scratchbox` of the GLB. Then a test: build the same script twice and expect the same GLB bytes.

**Cost:** half a day.

**Replaces:** guessing which engine made an old object.

### 3.7 The CC BY 4.0 datasets as an evaluation set — FITS AS EVALUATION, medium, needs a cost OK per run

The datasets pair a program with its reference mesh. Their meshes are the reference. We never ingest their programs:
they are `bpy`-backed sand3d code.

**Use.** A fixed set of 30-50 objects (cad and objaverse first; articraft once 3.4 exists).
1. Render each reference mesh to a reference image.
2. Run `build_3d_object_from_reference` on it, or a script session.
3. Score the result against the mesh: F-score at 2% of the diagonal (sand3d's own bar), Chamfer distance, body count,
   and the gate.

We have no object evaluation set today. The `photo-match` judges and `judge-preregister` cover locations only.

**Where.** A runner in `scripts/` with results in `docs/processes/`, preregistered like the location judges.

**Cost.** Model spend for each object: a Studio image, a spec read, and up to two vision diffs. Estimate the
whole-set cost before the first run and ask if it is over $10.

**License.** CC BY 4.0 needs attribution in the report.

**Not:** a training set. Training a model of our own is the user's decision.

## 4. Gaps in our object ability that sand3d exposes

1. **No named selection** before this branch. Edits picked faces by direction and box, and edges by angle. Now
   prototyped for extrusions, boxes, bevels, BSP booleans and merges. Lathes, sweeps, lofts, exact booleans and the
   object spec still have no names.
2. **Silent no-ops** (3.2).
3. **No joints or articulated export** (3.4).
4. **No placement frames on faces.** Before `place_on`, placement was offsets or the spec's `(u, angle)` attach.
   There is still no frame list for repeats (3.5).
5. **Script provenance**: no script, spec or engine hash on the build (3.6).
6. **No object evaluation set**: object quality is judged by a vision diff of one build, not against reference meshes
   (3.7).
7. **Bevel limits.**
   - The offset bevel caps its width at 45% of a vertex's shortest edge without saying so.
   - Neither bevel adds material at a concave edge.
   - Fillet corners where two rounds meet are the two cylinders' intersection, not a blended corner.
8. **The gate is advisory for scripts and absent for reference builds**, and its 70-20-10 check counts submeshes
   only.

## 5. Strengths we have that sand3d lacks

- **Four universal operators** (sweep, harmonic revolve with lobes and helix, affine replicator, normal relief)
  express any part without named shape verbs. sand3d leans on `gear`, `thread`, `knurl`.
- **A native C++20 engine, with no Blender dependency.** Exact booleans, SDF fields with blended booleans, relief
  layers, weathering and decals per part (`object_detail_pass`), PBR materials matched by appearance and real-world
  scale.
- **Reference-to-object**: an image to a spec to a build, checked by connectivity, size and vision diffs, with revision
  passes.
- **`GeometricComplexityGate`** and the clay vision review.
- **Location staging**: objects at real places from Google 3D Tiles, under the place's sky, with provenance labels.
- **Generated stubs and a type-check gate** on every script.

## 6. Recommended order

1. **Named faces and edges (3.1)**: done here for extrusions, boxes, bevels, BSP booleans and merges. Next, the
   same names from `create_lathe`, `create_sweep` and `create_loft`, and `sb.meshops.union/subtract`.
2. **Loud failures (3.2)**: cheap, and it removes the silent no-ops found above.
3. **Source fingerprint and a same-bytes test (3.6)**: cheap, and needed before 7.
4. **Frames as the one repeat (3.5)**: builds on `face_frame`.
5. **Object-program rules in the guide and skill, and a measured, shorter guide (3.3).**
6. **Names on object-spec parts**, so decals, edge radii and attachments can name faces.
7. **Evaluation set from the CC BY 4.0 datasets (3.7)**: a cost estimate first, then a preregistered run.
8. **Joints and URDF/USD export (3.4).**

## 7. The prototype (this branch)

**Before and after** on one object: a 0.8 × 0.4 × 0.06 m plate with a slot pocket and a boss.

- **Before** (today's sb): one angle bevel rounds every edge alike (the bottom, the boss's foot, the slot floor),
  and the boss is placed by hand-computed offsets.
- **After:**
  - `bevel(plate, 0.04, 6, edges="plate.side")` rounds the outer corners only.
  - `bevel(..., 0.01, 1, edges="plate.top")` chamfers the rim and the slot's mouth.
  - The boss's sides are filleted and its top chamfered; its foot stays sharp.
  - `boss.place_on(plate, "plate.top", u=0.22)` stands it on the top at y = 0.060.

Sheet: `docs/screenshots/sand3d-named-edges-before-after.png` (gitignored). It is also in the session group's notes
folder.

**Tests** (Node 22.18, empty HOME, no credentials):

| Test file | Result |
|---|---|
| `sb-named-faces-edges.test.ts` | 5/5 pass |
| `mesh-ops`, `native-mesh-edit`, `native-mesh-reshaping-pipeline`, `building-tiers-addons`, `python-engine-mesh-integrity`, `object-spec-interpreter` | 60/60 pass |
| `instruction-tool-drift`, `sb-stubs`, `sb-script-typecheck`, `python-3d-api-reference` | 123/123 pass |

- `npm run typecheck` is clean for `core`, `cli` and `desktop-app`. The electron project fails in this worktree only
  because `electron` is not in its node_modules, which has nothing to do with this change.
- 61 of the 62 C++ drivers that include the changed headers compile. The one that does not
  (`asteroid_field_generator.cpp`) is missing `glm`, on `main` too.
