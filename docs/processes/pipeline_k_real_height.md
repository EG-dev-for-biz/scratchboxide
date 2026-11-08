# Pipeline K: real height in the material path (2026-11-05)

Branch `feat/k-material-height`, stacked on `feat/k-one-material-path` (PR #140, not merged). The user's ask (2026-11-05): "Height: real height, it moves the actual geometry" added to the material path.

## What changed
- **Library:** the index lists each set's height (displacement) map (2,476 sets). No publisher states a height map's real depth (ambientCG's third dimension is 0, Poly Haven gives two dimensions), so it is estimated: the depth at which the height map's slopes equal the set's normal map's over the tile's real size, measured on the publishers' previews (`texture-library-heights.ts`, `npm run library:heights`, `assets/textures/library/heights.json`). 2,090 of 2,434 sets got one (median 11.5 mm black to white); the 344 whose two maps disagree draw no height. The fit finds each publisher's normal convention on its own (ambientCG DirectX on 1,819 of 1,831, Poly Haven OpenGL on 255 of 256), which is the check that it reads real slopes. Labelled an estimate.
- **Material path:** each class's set gives a recess tile (inward only, capped at 3 cm, scaled by the share of the normal relief drawn, so by the look-pick's confidence, the tile fit and the read roughness). A rebuilt facade's photo is 7.7 cm a texel, too coarse for a joint, so the height is kept as one 256 px tile a class at the tile's own resolution, placed by each facade's class map and metric frame. The class map's green channel fades the relief out toward a class's border. TypeScript and the native kernel agree bit for bit (protocol 6).
- **Viewer** (`heightRelief.ts`): parallax occlusion through that field, its slope as a fine normal, grooves dimming the ambient light; full to 30 m, gone by 70 m.
- **Native displacement** (`scratchbox_height_displace.hpp`, `height-relief.ts`, step `twin.heightRelief`): the rebuilt facades' lowest 4 m, in 4 m cells, tessellated where the relief needs it and displaced inward; cells are child nodes drawn in place of the flat triangles within 14 m; at most 900,000 triangles. Scan pieces carry no relief.

## Builds (through the app, branch worktree on /Volumes/3DTESTING, stage cache empty)
| | Penn 2 (run af49fb4f) | ESB (runs 1982d53f, 0c422841) |
|---|---|---|
| classes with a height | 0 of 6 | 3 of 6 (Concrete017, Plaster005, Plaster006) |
| deepest recess | none | 12.8 mm |
| displaced | nothing: `no class's set has a height` | 217 cells of 19 facades, 2,806 m2: 726,279 triangles in place of 14,008 |
| height step | 2 s | 2 s (29 s in the first version) |
| material step | 163 s | 476 s first build (sets fetched), 62 s rebuild |

- **Penn 2 shows no difference, and that is the rule working:** five of its six classes had their grain cut to 0 (the look-pick confirmed no set: a curtain wall matched to Wood080, PavingStones107, Foam001), and the sixth's recess came to about 0.3 mm, under the 0.5 mm threshold.
- **ESB, viewport, relief off against on at one camera** (`k-material-height-esb.jpg` in the side-session notes; the off side is the PR #140 look of the same build, not a separate main build): at 6 m grazing, 24 cells and 83,156 displaced triangles on screen, 25.9 ms a frame against 16.6 ms off (1180 x 1424); at 24 m, 17.1 ms against 18.5 ms.
- The first ESB build timed out in its texture stage because the engine's Python module took 43 minutes to compile while the machine's load was above 300; rebuilt at load under 100.

## Found and fixed on the way
- Risers at cell borders stood as dark fins between neighbouring cells: the displacement now fades to nothing at a cell's border instead.
- With the edge coarsened to 9 cm, triangles sampled a millimetre grain into facets: the kernel now reads the relief low-passed to its least edge (and at 12 mm the ESB fits the limit without coarsening).
- Neighbouring classes stepped to different recess levels and dimmed as whole regions: the relief fades toward a class's border, and only a groove deeper than its tile's mean dims the light.
- Relief switched off drew black (a division by a zero depth); displaced cells no longer cast shadows of their own.

## Open
- **The relief can only be as right as the set.** On the ESB the stone classes take plaster and concrete sets with a trowelled grain; real limestone ashlar is flat between joints. No brick or jointed-stone building is in the proof: Fraunces Tavern (brick) from the benchmark set is the next one to build.
- **Estimated depths inherit the tile size.** For a set whose size is itself a vision estimate the depth scales with that estimate.
- **Thin dark outlines on the facade at 24 m** are in both the off and the on capture, so they do not come from the displacement; their origin was not found here.
- **A dark class at a grazing angle looks wet** where the fine normal meets a reflective finish; the sheen itself is PR #140's finish read (the user's remark, 2026-11-05).
- **Generated objects** get the relief through the material path on objects, the next PR (`feat/object-material-path`).
- No separate main build was captured at these cameras; the comparison is relief off against on.

Tests: `packages/core/test/texture-library-heights.test.ts`, `height-relief.test.ts`, `material-regions-native.test.ts` (parity with the class map and its weights), with the touched K tests; `npm run typecheck`.
