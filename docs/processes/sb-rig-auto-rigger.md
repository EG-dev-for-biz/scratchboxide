---
name: sb-rig
description: >-
  Rig ANY mesh (.glb) natively with SB-Rig: a skeleton and 4-bone skin weights discovered from the
  geometry itself (hands, creatures, tentacles, plants, branching props), with no preset skeleton and
  no Blender. Use for "rig this model", "add bones / finger joints", "make this hand/creature
  posable", "skin weights for", "auto-rig", and for preparing a static GLB for animation or
  pose-driven video. Covers the Python scripter (sb.rig), `sbox rig`, the sbrig_auto_rig agent
  tool, SbRigService, root/chain hints, renaming, and verification.
---

# SB-Rig: native analytical auto-rigging

> Reference written so it can be promoted to a skill unchanged: copy this file to
> `.agents/skills/sb-rig/SKILL.md`. The frontmatter is already in skill format.

SB-Rig turns a static mesh into a rigged one: a joint hierarchy plus glTF `JOINTS_0`/`WEIGHTS_0`
skin weights. Everything is derived from the mesh's own geometry.
- **No closed taxonomy.** There are no "thumb/index" or "arm/leg" enums. A 3-fingered claw, a 7-armed starfish and a branching tree all rig with the same code.
- **No world-unit constants.** Every threshold is a fraction of a length the mesh measures itself, so a centimetre-scale model and a kilometre-scale one get identical skeletons, up to scale.
- **Textures are never touched.** The skin is appended to the original GLB; images, UVs, materials and extensions stay byte-identical.

**When to use it:** any request to rig, bone, skin or pose a mesh, or to add finger joints to a hand. Rig in grey clay or textured; it doesn't matter.

**When not to use it:**
- The asset already has a skin. SB-Rig v1 refuses it; strip the skin first.
- You want the canonical 55-joint SB-Human body rig for an `.sbhuman` asset. Use `SbHumanLoader` for that.

## Entry points

All five share one native engine: `packages/core/src/native/3d-engine/include/scratchbox_sb_rig.hpp`.

### Python scripter (`import scratchbox as sb`)

```python
import scratchbox as sb

# A mesh built in the script -> skinned GLB bytes
result = sb.rig.solve(mesh)                                # returns sb.rig.Result
result.rename({"Chain1": "Tail", "Root": "TailBase"})
data = sb.rig.export_skinned_glb_bytes(mesh, result)

# A GLB file -> skinned GLB file (textures preserved) + JSON report
p = sb.rig.Params()
p.root_hint = (-0.32, -0.92, -0.06)
p.chain_hints = [[(0.40, 0.55, 0.03), (0.398, 0.541, 0.146), (0.311, 0.445, 0.212), (0.246, 0.363, 0.217)]]
result = sb.rig.rig_glb("in.glb", "out.glb", p, {"Chain3": "LeftIndex"}, "out.sbrig.json")

result.joint_names, result.parents, result.rest_positions, result.tip_joints
result.chains                    # [<sb.rig.Chain Chain3 leaf joints=4>, ...]: name, parent_joint, joints, leaf, hinted, length
result.joint_indices             # flat, 4 per input vertex (JOINTS_0 order)
result.joint_weights             # flat, 4 per input vertex, each group sums to 1
result.report_json(p, include_tree=True)
```

Parameter fields are snake_case (`p.min_branch_frac = 0.06`), or use `p.set("minBranchFrac", "0.06")`.

Errors raise `ValueError` for bad input (bad parameters, unknown rename keys, an already-skinned GLB) and `RuntimeError` otherwise. Long solves release the GIL. Typed stubs: `scratchbox/rig.pyi`.

### CLI

```bash
sbox rig hand.glb -o hand_rigged.glb --root-hint -0.32,-0.92,-0.06 \
  --chain-hint "0.40,0.55,0.03;0.398,0.541,0.146;0.311,0.445,0.212;0.246,0.363,0.217" \
  --rename Chain3=LeftIndex --param-minBranchFrac 0.05
```

- It prints one line per chain: name, kind, joint count, parent and end position. `--json` prints the full report.
- `--flag=value` forms work, which helps with negative coordinates.
- Output defaults to `<input>_sbrig.glb` plus `<output>.sbrig.json`.

### In-app agent tool: `sbrig_auto_rig`

It lives in the `mesh_surface` tool pack, in `packages/core/src/node/gemini/tools/sb-rig-tools.ts`.

**Arguments:**
- `inputGlbPath`, `outputGlbPath`
- `rootHint: [x,y,z]`
- `chainHints: [[[x,y,z], ...], ...]`
- `rename: [{from, to}]`
- `params: {...}`

**Result:** a payload of `joints`, `chains` (with end positions), `stats`, `warnings` and `outputGlbPath`, plus a one-line summary that lists every chain. The agent is expected to call it again with renames and hints (see the workflow below).

### TypeScript (node)

```ts
import { SbRigService, sbRigMesh } from '@scratchbox/core/node';
const { outputGlbPath, report, glbBuffer } = await sbRigMesh({
  inputGlbPath, rootHint: [-0.32, -0.92, -0.06], chainHints: [...], rename: { Chain3: 'LeftIndex' },
  params: { minBranchFrac: 0.05 },
});
```

- `SbRigService` compiles `scripts/run_sb_rig_pipeline.cpp` through `NativeCppCompilerService`. The binary is content-hash cached, and `-march=native` is added only when `SCRATCHBOX_NATIVE_ARCH=1`.
- It runs the binary with pure argv, never a shell string.
- Failures throw `SbRigError` with `kind` set to `invalid-input`, `internal` or `compile`.

### Native runner (debugging)

```bash
clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/run_sb_rig_pipeline.cpp -o build/3d-native/run_sb_rig_pipeline
build/3d-native/run_sb_rig_pipeline --input in.glb --output out.glb [--debug-tree] [--param-<name> v] ...
build/3d-native/run_sb_rig_pipeline --synthetic claw --digits 5 --synthetic-out claw.glb --synthetic-truth claw.json --output claw_rigged.glb
```

- Exit code 0 means success, 2 means invalid input, 1 means an internal error.
- It always prints exactly one `[TELEMETRY] status=…` line.

## The agent workflow

SB-Rig separates *topology* (found automatically) from *meaning* (supplied by the LLM, the domain engine). The loop:

1. **Rig with no hints.** Read the returned chains. Leaf chains are appendages; each comes with its end position. Inner chains link branch points.
2. **Choose the root.** The default root is the geodesic centre (`rootSource: agd-center`). For an animatable hierarchy, pass `rootHint` at the attachment end: the cut end of a forearm, the base of a trunk, a pelvis.
3. **Add chain hints for digits that geometry cannot separate.** Fingers curled and fused into a palm, or limbs fused to a torso, produce no protruding branch.
   - Render the mesh with a coordinate grid. Use `renderPreviewPng` in `packages/core/test/helpers/skinned-glb-preview.ts` with `frame` and `gridStep`, or any viewer.
   - Pick points along each hidden digit, base to tip: knuckle, middle, tip.
   - Surface points (within 1% of D of the surface) are pulled to the local axis. Points clearly inside are used as given.
   - Hint chains always parent to the auto-discovered skeleton, never to each other.
4. **Rename** in the vocabulary the user wants, for example SB-Human: `Chain4→LeftIndex`, `LeftForearm4→LeftWrist`.
5. **Verify by posing.** Rotate one joint and check that only that part moves (see Verification).

## Naming and renames

- Generated names: `Root`, then `Chain<k>Seg<i>` with 1-based segments.
- Chains are numbered depth-first from the root, and siblings are ordered by descending subtree length.
- A branch point is the last joint of its incoming chain; child chains hang from it.
- Leaf chains end in a zero-weight tip joint (an end effector). This can be turned off with `emitTipJoints=false`.
- Rename map entries apply in order, and keys refer to the current names.
  - A chain name renames every joint in that chain: `Chain3 → LeftIndex` gives `LeftIndex1..n`.
  - Any other key must be an exact joint name.
- Unknown keys, duplicate results, and names with quotes, backslashes or control characters are rejected.

## Parameters

All parameters are dimensionless. D is the geodesic diameter.

| name | default | meaning / when to change |
|---|---|---|
| `minBranchFrac` | 0.04 | A leaf must protrude this × D beyond its junction's radius. Raise it to drop bumps (knuckles, wrinkles); lower it to keep stubby digits. |
| `minLeafChainSegments` | 3 | Minimum weighted joints per leaf chain. Extra joints are spaced evenly by arc length. |
| `jointDeviationFrac` | 0.02 | Centreline deviation (× D) that earns a joint. Lower gives more joints. |
| `bendThresholdRad` | 0.35 | Bend angle that earns a joint. |
| `radiusWeight` | 0.5 | How strongly thickness changes (wrist, knuckles) place joints. |
| `minBoneFrac` / `maxBoneFrac` | 0.025 / 0.25 | Bone length clamp (× D). Long limbs are subdivided. |
| `hubMergeFrac` | 0.05 | Splits closer than this along the shape merge into one hub (e.g. four finger webbings → one palm hub). |
| `blendScale` | 0.6 | Skin blend width at each joint (× local ring radius). |
| `bandFrac`, `bandEdgeMultiple` | 0.015, 3 | Slicing resolution. Bands always span ≥ 3 median edges. |
| `loopContractRatio` | 3 | Loops shorter than this × ring radius are discretisation artifacts and are contracted. |
| `refineEdgeMultiple` | 2 | The analysis graph bisects edges longer than this × median (0 = off). Essential for decimated meshes. |
| `agdSamples` | 48 | Geodesic sources for the average-geodesic-distance field. |
| `weldFrac`, `minNodeFrac` | 1e-5, 5e-4 | Seam weld tolerance (× bbox diagonal) and the smallest Reeb node (fraction of vertices). |

## How it works

1. **Weld + graph.** UV and normal seams are welded with a scale-relative tolerance, giving an input→welded remap; the mesh itself is never modified.
   - A CSR edge graph is built from the triangles, which keeps it robust to non-manifold edges.
   - Long edges are bisected for analysis only.
   - Area-weighted normals are oriented outward by signed volume.
   - The largest component is analysed. Other components bind rigidly to their nearest main-component vertex.
2. **Root region.** An average geodesic distance (AGD) field is built from farthest-point Dijkstra sources. The root region is the AGD band around its minimum (the geodesic centre), or around `rootHint`.
3. **Slicing field.** Slicing uses the geodesic distance from the root region. Its unit gradient resolves compact features near the centre (a curled finger) as finely as the extremities.
4. **Band Reeb graph.** Nodes are the connected components of each band. Each node is positioned at the trimmed mean of inward-ray midpoints (the medial axis), and its ring radius is measured.
5. **Loops.**
   - A short loop (discretisation) is contracted.
   - A real loop (a fused contact) is cut at its lowest node, on its thinner side, so a curled digit hangs from its base rather than its tip.
6. **Tree.**
   - Rooted at the root region.
   - Leaves that protrude less than `minBranchFrac`·D beyond their junction are pruned.
   - Near-simultaneous splits are merged into hubs.
7. **Joints per chain.**
   - The centreline is smoothed.
   - Breakpoints come from Douglas–Peucker on (position, radius), bend maxima, and bone-length clamps.
   - Leaf chains get at least the minimum segment count.
8. **Chain hints** add extra chains. Vertices inside each hint's measured tube radius are relabelled to it.
9. **Weights.** Each vertex is first owned by its node's joint. A bounded multi-source geodesic Dijkstra from each joint's region gives a smoothstep falloff; the top 4 are kept and normalised. Distances are geodesic, so weight never jumps the gap between neighbouring fingers.
10. **GLB patch.** The source JSON is parsed losslessly: untouched values keep their exact text, including `\u` escapes. SB-Rig then appends:
    - `JOINTS_0` and `WEIGHTS_0` accessors per primitive
    - joint nodes
    - one skin per skinned node, with inverse bind matrix = T(−p)·W_node

    A transformed skinned node is moved to the scene root with an identity transform, so spec viewers and three.js agree.

## Output contract

- **Joints:**
  - Joint nodes carry translation only, so their local axes are world-aligned. Rotating `LeftIndex2` about +X bends it about world X.
  - At rest, Σw·(World·IBM)·v reproduces the original world positions to within 1e-4.
- **Report (`.sbrig.json`):**
  - `joints[]`: `name`, `parent`, `position`, `tip`
  - `chains[]`: `name`, `parentJoint`, `joints`, `leaf`, `hinted`, `length`, `basePosition`, `endPosition`
  - `stats`: counts, `geodesicDiameter`, `bands`, `loopsCut`, `loopsContracted`, `leavesPruned`, `hubsMerged`, `medialHitRatio`, `rootSource`
  - `timingsMs`, `warnings`, `params`, and optionally `tree`
- **Refusals (exit code 2, or `ValueError` / `SbRigError(invalid-input)`):**
  - the input already has a skin
  - a mesh is instanced by more than one node
  - a mesh mixes triangle and non-triangle primitives
  - geometry is Draco- or meshopt-compressed or sparse
  - buffer 0 is external
  - a transformed skinned node has children

## Failure modes and remedies

| symptom | cause | remedy |
|---|---|---|
| A digit has no chain | It is fused into the body (curled into a palm) | `chainHints` along it, base → tip |
| Hierarchy starts mid-limb | Root defaulted to the geodesic centre | `rootHint` at the attachment end |
| Many tiny leaf chains | Surface bumps or noise | Raise `minBranchFrac` (0.06–0.1) |
| A short real digit disappears | Pruned as a bump | Lower `minBranchFrac`, or add a chain hint |
| Too many / too few joints along a limb | Joint placement tolerance | `jointDeviationFrac` (lower = more), `minLeafChainSegments`, `maxBoneFrac` |
| Separate splits where one hub was expected | Webbings split far apart | Raise `hubMergeFrac` |
| Warning: low `medialHitRatio` | Open or inside-out mesh | Node positions fall back to centroids. The result is usable, but close large holes for better centrelines. |
| A large motion of a hinted fused digit tears the surface | The source mesh has no separate surface where the digit touches the body | Keep motions small, or separate or re-sculpt the digit before rigging |

## Limits (v1)

- **Joint frames.** Frames are world-aligned (translation only). Bone-aligned rest rotations, such as +Y along each bone, would suit some retargeting tools; they are a planned follow-up.
- **Already-skinned and instanced meshes are refused.** Multi-part hard-surface models are bound rigidly per secondary component, not articulated per part.
- **Performance.** Typical runtime is 1–10 s for about 50k vertices (most of it AGD Dijkstras); reduce `agdSamples` for very large meshes.
  - `SbRigService` runs inside `NativeCppCompilerService.executeBinary`, which has a 60 s timeout.
  - The first run compiles the runner (about a minute), and later runs hit the cache.
- **Marching cubes.** The engine's `MarchingCubes::polygonize` is currently not a real isosurface extractor, so the runner's synthetic test shapes use their own surface nets. Don't mesh SDFs through that routine before rigging until it's fixed.

## Verification

- `npx vitest run packages/core/test/native-sb-rig.test.ts`
  - Synthetic claws with 1, 3, 5 and 7 digits give exactly that many leaves.
  - Scale invariance at ×0.01 and ×100.
  - Twice-forking tree hierarchy.
  - Fused-loop cut: the curled digit hangs from its base.
  - Geodesic anti-bleed between fingers.
  - Chain hints.
  - Textured-GLB byte preservation and exact rest-pose reproduction.
  - Transformed-node re-homing, secondary components, renames, and refusals.
- `npx vitest run packages/core/test/python-sb-rig.test.ts`: `sb.rig` through `NativePythonRunnerService`.
- `npx vitest run packages/core/test/sb-rig-service.test.ts packages/cli/test/sbox-rig.test.ts`: service, agent tool and CLI.
- **Screenshots** (gitignored) are written to `test-results/screenshots/sb-rig*.png`.
- **Posing helper:** `readSkinnedGlb` + `skinPositions(doc, { JointName: { axis, angleRad } })` give independent CPU linear-blend skinning, and `renderPreviewPng` colours by dominant joint with the skeleton overlaid.
- **Visual pass in a real renderer:** load the GLB with three.js `GLTFLoader`, set `bone.quaternion` on one joint, and check that only that part moves and the textures are intact.

## Worked example: `brunson_hand_celly.glb` (jb-chase)

**Asset:** a generated hand plus sleeved forearm in a celebration pose.
- **Pose:** index and middle extended, thumb out, ring and pinky curled into the palm.
- **Mesh:** one primitive with 3 PBR images. 45,256 vertices weld to 31,257; the analysis graph is refined to 67,133.
- **Scale:** about 1.0 × 1.9 × 0.43 units.
- **Defects:** 18 non-manifold edges and small holes. Genus ≈ 2–3, from the fused curled fingers.
- **Edge lengths:** strongly non-uniform (median 0.0071, maximum 18× that). This is why `refineEdgeMultiple` exists.
- **Orientation:** palm faces +z, fingers point +y, thumb is at −x, so it is a **left** hand.

**1. Unhinted pass (`sbox rig in.glb`):** 4 leaves are found automatically (thumb, index, middle, and the forearm stump), with the root at mid-forearm. The ring and pinky are fused into the palm and produce no branch.

**2. Root at the sleeve end:** `--root-hint=-0.32,-0.92,-0.06`, taken from the forearm leaf's end position. The hierarchy becomes forearm → wrist → palm → digits.

**3. Chain hints for the curled ring and pinky.**
- Points were picked on a front clay render with a 0.025 grid: knuckle (interior) → PIP (surface) → DIP → nail.
- Ring: `0.40,0.55,0.03; 0.398,0.541,0.146; 0.311,0.445,0.212; 0.246,0.363,0.217`
- Pinky: `0.43,0.44,0.03; 0.412,0.422,0.149; 0.35,0.361,0.196; 0.266,0.287,0.195`

**4. Renames to SB-Human style:**

```
--rename Chain1=LeftForearm --rename LeftForearm4=LeftWrist --rename LeftForearm5=LeftHand --rename Root=LeftForearmBase
--rename Chain2=LeftPalm --rename Chain3=LeftMiddle --rename Chain4=LeftIndex --rename Chain5=LeftThumb
--rename Chain6=LeftRing --rename Chain7=LeftPinky
```

**Result** (`brunson_hand_celly_sbrig.glb` plus `.sbrig.json`, next to the source):
- 30 joints in 7 chains, 5 of them leaves. 1 real loop cut and 3 bumps pruned; the medial-ray hit ratio is 0.9999.
- Hierarchy:
  - `LeftForearmBase` → `LeftForearm1`–`3` → `LeftWrist` → `LeftHand`
  - `LeftHand` → `LeftThumb1`–`4`
  - `LeftHand` → `LeftPalm1`–`4` → `LeftIndex1`–`4`, `LeftMiddle1`–`4` and the hinted `LeftRing1`–`4`
  - `LeftPinky1`–`4` (hinted) hangs from `LeftPalm3`
- Run time: 1.4–9.6 s in the runner, depending on machine load.

**Verified in three.js** (`GLTFLoader` and GPU skinning; screenshots in `test-results/screenshots/sbrig_brunson_*.jpg`):
- 30 bones and 45,256 skinned vertices load.
- The colour, normal, metalness and roughness maps all survive.
- Curling `LeftIndex1` and `LeftIndex2` (+55° and +70° about X) gives a clean, believable finger curl; the other digits don't move.
- Uncurling the hinted `LeftRing2` by 80° works but stretches the fused skin along the old contact, which is the documented limit for fused digits.
