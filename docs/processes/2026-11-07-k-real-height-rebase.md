# Pipeline K: real height rebased onto the glass material path (2026-11-07)

Branch `feat/k-real-height`, the work of PR #147 (`feat/k-material-height`, stacked on the retired one-material-path branch) replayed onto main `b2a41010`, which now carries the glass panes in the material path (#182) and the kept measured relief (#187). The earlier notes, [pipeline_k_real_height.md](./pipeline_k_real_height.md), describe the mechanism; this file records the rebase and the main-against-branch measurement MAIN asked for.

## The rebase
- Ten commits replayed; merge commits and one already-applied commit dropped. Four conflict rounds, all in the material path: the kernel (`scratchbox_material_regions.hpp`), its TypeScript twin (`material-regions.ts`), the bridge and the CLI driver, where main's glass (`paneGlass`, `glassShare`, `panesOnStone`) and the branch's class map and height tiles touch the same loop.
- **One design rule added where they meet:** a glass pane's class-map texel names no relief class (`NO_RELIEF_CLASS = 255`, in TypeScript and the kernel alike), so no height tile is ever stacked on glass and the pane stays a flat surface in the viewer's parallax and the native displacement. The parity test asserts it (`material-regions-native.test.ts`).
- AGENTS.md: main's pipeline K paragraph kept, the branch's **Real height** block inserted before **Occlusion masks**.
- `npm run typecheck` clean; 16 touched test files, 104 tests pass, credentials unreachable.

## Measured: main against the branch, uncached, both through the app
Benchmark runner (`scripts/benchmark_buildings.ts`), two checkouts side by side, the stage cache set aside, model readings shared per side. Output under `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-07-height/` (results, close-ups, `height-sheet.jpg`).

| | ESB main | ESB branch | Flatiron main | Flatiron branch |
|---|---|---|---|---|
| outcome | complete | complete | complete | complete |
| holes | 0.53 % | 0.52 % | 0.83 % | 0.80 % |
| untextured | 0.38 % | 0.39 % | 3.38 % | 3.18 % |
| glass texels | 6.68 % | 6.75 % | 10.42 % | 11.65 % |
| classes with a height | 0 of 6 | 4 of 6 | 0 of 6 | 4 of 6 |
| deepest recess | none | 14.3 mm | none | 10.1 mm |
| displaced cells | none | 287 on 21 facades, 3,019 m² | none | 12 on 2 facades, 154 m² |
| triangles (final GLB) | 1,490,167 | 2,423,940 | 475,296 | 347,524 |
| height step | - | 3.3 s | - | 0.5 s |
| build | 23.3 min | 22.0 min | 6.8 min | 6.2 min |
| dark lines, grazing close-ups | 0.11 % | 0.39 % | 0.59 % | 0.30 % |

- The hole, untextured and glass shares are the same build to build: the height work changes nothing upstream of the material step, and the differences are the run-to-run noise of the reader.
- The Flatiron branch GLB is smaller than main's despite 40,061 displaced triangles because the two builds differ elsewhere (the reader read 464 windows against 428); the displacement itself adds what the height note says.
- **Dark lines** (`tools/darklines.py`, the share of thin dark pixels in the grazing close-ups, measured on the branch's displaced variant): up on the ESB, down on the Flatiron. On the ESB the raking sun throws thin shadows off the displaced cells' edges where they meet the scan at the base, and the camera also sees different geometry at the same spot (the two builds' lattices differ, see the sheet); the measure does not separate the two. It is not a regression of the lines the keep-measured-relief work removed (those were in the lattice, both sides carry that fix).
- **Sets with a height differ from the earlier proof:** the look-pick chose Concrete027, Concrete014 and Plaster005 on the ESB (depths 16 to 19 mm black to white, slope-fit correlation 0.69 to 0.74), Concrete027, Concrete014 and Concrete036 (2.5 mm) on the Flatiron. Main's own picks for the same classes differ (Concrete029, PavingStones112), which is the pick's run-to-run variation, not the branch.

## Close-ups at grazing light (sheet, columns 3 to 5)
Path-traced, sun 12 degrees up and raking along the facade, the camera 30 degrees off the facade's normal at 6 m and 20 m, on the branch's facade with the most relief cells (ESB `facade_lattice_10007`, 47 cells; Flatiron `facade_lattice_2`, 4 cells). The branch is drawn twice: flat (the GLB as any viewer draws it) and with its displaced base cells in place of the flat triangles (as the app's viewer draws them within 14 m).
- At 6 m and 20 m, 720 px wide, the recess is under a pixel (mean recess 1.8 to 4.5 mm, 8 mm a pixel at 6 m): the displaced columns read like the flat ones. The path tracer draws no parallax, so the upper facades are main's look on both sides. The viewer's parallax is the proof of the relief at these distances (the earlier note's captures); it was not re-captured here.
- **At 1.5 m (1 mm a pixel, sheet row 3) the displaced variant still measures the same as the flat one** (mean pixel difference 0.02 of 255 on the ESB, 0.01 on the Flatiron; the images' contrast unchanged). The path tracer's relit, denoised output shows neither the sets' normal grain nor the 2 to 14 mm displacement at this sun. So these renders do not prove the relief; they prove that the displacement adds no artefact (no fins, steps or dark rims, which the earlier note's fixes addressed) and that the base reads as before. The relief itself was seen in the app's viewer on the pre-rebase branch (`k-material-height-esb.jpg`, relief off against on at 6 m and 24 m); the viewer code is unchanged by the rebase and was not re-captured here.

## What is open (carried from the earlier note, still true)
- The relief is only as right as the set: limestone takes trowelled concrete and plaster grains. No jointed masonry in this proof either (Faneuil Hall, brick, is in the places list but not cached; the six benchmark buildings hold no brick).
- Estimated depths inherit the tile size's estimate.
- Generated objects get the relief with the object material path.

Tests: `texture-library-heights.test.ts`, `height-relief.test.ts`, `material-regions-native.test.ts`, the touched K tests; `npm run typecheck`.
