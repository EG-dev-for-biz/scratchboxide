# Pipeline K: one material path for every surface (2026-11-05)

Branch `feat/k-one-material-path`, against main `f4989130`. The user's decision (2026-11-05): "we should not be doing glass / metal anymore, we should be detecting materials and assigning them roughness texture etc". Two refinements followed: window glass keeps a glass quality of smoothness, and materials follow the architecture's repeats.

## What changed
- **Gone:** the separate glass layer (bays, fitted panes, glass weight, pane seeds, feathering), the metal gate, the plain finish for smooth classes and for unconfirmed picks, and the viewer's pane tilt and recess occlusion.
- **Detection:** CIELAB classes are read apart inside the fitted windows (2 classes) and outside them (4). Each texel takes its nearest class among its region's, then the majority within 0.15 m. Every window's unit cell (the window and half the gap to its neighbours) is folded over its family of same-size repeats: each place in the cell takes the family's majority class.
- **Maps:** each class takes its library set's occlusion, roughness, metalness and normal at the set's real size. A confident vision read (numbers) sets the drawn roughness and metalness, keeping the set's grain, and flattens the relief by the square of the read roughness, so glass read at about 0.1 is almost flat. The grain is scaled by three things: the look-pick's confidence (none when the pick confirmed nothing), whether the tile fits the class's repeat element (`patternFit`), and whether the photo shows that much texture (`energyFit`).
- **The viewer:** it reflects the probe on every texel of a K twin by its own roughness and metalness.
- **The facade reader:** it stays, with no glass question. Its brief and what it saw go to the material reads; nothing is drawn from it. Prompt version `facade-reader-prompts/2`.
- **The regression guard** (`scripts/material_regions_metrics.ts`): repeat spread, the drawn finish inside the windows and around them, and the grain within a cell, read from a finished twin.

## Builds (uncached, benchmark runner, same tile cache)
| | main f4989130 | branch |
|---|---|---|
| Penn 2 repeat spread | 0.231 | 0.089 (53f208fc, isolate l2) / 0.063 (97d8e193, isolate l2v) |
| Penn 2 in windows, roughness / metalness | 0.08 / 0.06 | 0.42 / 0.24 (53f208fc) / 0.35 / 0.18 (97d8e193) |
| ESB repeat spread | 0.168 | 0.048 (97d8e193) |
| ESB in windows, roughness / metalness | 0.14 / 0.08 | 0.22 / 0.18 |
| ESB around windows, roughness / grain | 0.77 / 0.092 | 0.55 / 0.150 |
| holes | Penn 2 1.28%, ESB 0.72% | Penn 2 1.28% (l2) / 1.60% (l2v), ESB 0.72% |

The sheet of close-ups is `k-one-material-closeups.jpg` in the side-session notes folder. ESB on the branch reads like main at street distance, with fewer repeat flips.

## Open
- **Penn 2's spandrels still show a library pattern.** The look-pick confirms Fence004 or MetalPlates sets, and the photo-energy cap does not bring their grain down: the facade's window rhythm gives the photo high band energy.
- **Penn 2's glass inside the fitted windows reads rougher than main's plain 0.2.** The opening classes there are window interiors and blinds, and the curtain wall's glazing class sits outside the fitted windows.
- **The ownership vote drew isolate l2v on both final Penn 2 builds.** It is a vision vote before textures, unrelated to this change.
