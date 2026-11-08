# Pipeline K: a texturing expert for the materials' roughness, metalness and grain (2026-11-08)

**Ask** (user via MAIN): too many surfaces look reflective; metalness is overused and roughness too low. Main's matte ESB base looks better than PR #191's sheeny travertine.

## Step 1: what made the twins reflective (main ab9ca95d, benchmark 2026-11-08-array-followups)

Per texel over every lit material's ORM map: Penn 2 81.6% reflective (metal > 0.1 or roughness < 0.4), Lever House 88.1%, Seagram 100%, ESB 12.4%, 30 Rock 14.1%. Drivers, from each run's `pipeline_k_materials.json`:
- metal finish reads on whole colour classes (Penn 2 65% of texels at 0.8, Seagram 42%);
- the `r x r / 0.5` squaring (Seagram bronze read 0.35 drawn 0.24, Penn 2 read 0.40 drawn 0.32);
- hedged metalness squared to in-between values (Lever House: 54% at 0.18);
- smooth reads outside the openings (Seagram 27%, Lever House 21%);
- opening classes drawn at 0.08 including the frames inside the window boxes (ESB 11.3% against 8.2% panes);
- `paneGlass` at 0.08 (8-24%, correct for glass); `OPENING_FINISH` 0 here; set grain about 1 point.

## The change (feat/k-texture-expert)

- `common/spatial/pbr-artist-reference.ts`: our own reference of measured finishes by look and the artists' rules (from the Physically Based database, Filament, Substance's PBR guide, Lagarde's charts, the glTF model). It is data told to the model; nothing branches on it.
- `material-finish.ts` (material-finish/5): the read is asked as a PBR texture artist, told the reference; it also returns grain, coverage and the numbered reference finish it matched, and its roughness is held to that finish's range. Drawing: roughness as read (reads under 0.2 are glass at main's 0.08); metalness 0 or 1, 1 only when read metal at confidence 70 or more over at least 60% of the class; the set's grain at most the read grain.
- `material-choice.ts` (material-choice/4): the pick by look is told the rules and votes 0 or 1 on bare metal; `agreeMetal` draws a dielectric where the two looks differ.
- `material-regions.ts` `applyFrameFinish`: the texels of a window holding a glass pane, outside its glass, are drawn no smoother than 0.45 (0.35 before MAIN's review).
- `.claude/skills/pbr-material-review`: the coding agents' screenshot review against the same reference.

## Step 3: uncached builds, main 17f1d2f1 against the review head 4034c447, one shared answer store

Benchmark `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-08-texture-expert`. Sheets there: `texture-expert-viewer-sheet.jpg` (app viewer at a raking sun, main against branch, and MAIN's three review items) and `texture-expert-proof-sheet.jpg` (finish maps, at 141da180). Earlier branch heads' builds are kept under `v1/`, `v2/` and `v3/`.

| Building | reflective, main -> branch | metal > 0.1 | rough < 0.4 |
|---|---|---|---|
| Penn 2 | 86.2% -> 17.3% | 68.3% -> 0.0% | 20.3% -> 17.3% |
| ESB | 12.5% -> 11.2% | 1.2% -> 0.0% | 12.4% -> 11.2% |
| Lever House | 100% -> 98.9% | 0% -> 0% | 100% -> 98.9% |
| 30 Rock | 14.1% -> 13.7% | 0.1% -> 0.0% | 14.1% -> 13.7% |
| Seagram | 100% -> 72.4% | 42.5% -> 42.4% | 100% -> 30.1% |

- **Penn 2:** the spandrels and mullions are read as outdoor painted metal (0.55, a dielectric), where main drew anodised metal at 0.8. What remains reflective is glass.
- **ESB and 30 Rock:** the stone is drawn rougher (0.78-0.85) with about half the set grain, and no metal. Frames beside the panes are raised to 0.45.
- **Lever House:** the vision and spandrel glass is read as glass on both sides. The stainless trims keep their own 0.35, where main's shade-twin rule had pulled them to 0.08.
- **Seagram:** the bronze stays metal at 0.50-0.55 (0.24 on main). The class that moved from glass (L44, 16%) lies on the mullion lines; the pick by look votes it not metal, so it is drawn a dielectric at 0.45.
- **App viewer:** at these cameras the main and branch pictures differ only slightly (see the sheet).

**Repeat runs** (MAIN's determinism check): a second uncached build of each arm on the ESB and Penn 2 (main 17f1d2f1; branch ac7f646f, which is 141da180 plus docs only), on the same shared answer store, gave the same classes, picks and shares texel for texel. The spread is 0, so every difference above is the change. Both arms rank from the committed `stats.json`: neither checkout had measured sets of its own.

**App-viewer close-ups** were taken by chat builds on each side's own app (launch entries `scratchbox-tx-main` and `scratchbox-k-texture-expert`, ports 3270-3282, shared answer store), the same camera per pair, and the scene sun moved to rake along the facade.

## Follow-ups (2026-11-08)

- **Sky de-light:** off, /1 has a sign bug, /2 fixes it on backup/*, measured near-zero value on ESB and 30 Rock. On ESB and 30 Rock with the neighbours as occluders it explains 2.4% and 5.3% of the wall variance. A wall sun-shadow lift built like the roof lift finds no shadow edge either: the best sun is 1.21:1, failing the gates. The dark stone class is a material, not shade (the next item).
- **The window bays outside the openings:** on the ESB's wall sheets the facade reader's zones covered only the middle bays. Facade 8 got 3 columns at x 217-358 of 426, and facade 9 its central bays at x 88-288 of 410. The window fit found few windows in the outer bays too, so their glass and spandrels fell outside the openings mask and formed an outside class the glazing's colour (ESB: L 40.1 a 1.1 b 0.4, against the glazing's L 41.6 a 1.0 b 0.5). The finish read called it shaded limestone. `matchGlazing` now draws such a class as a window frame (roughness 0.45, no metal) when it is read as stone or masonry, and leaves it out of the exposure fit. Paint, metal and glass reads stand. The reader's zone coverage itself is the follow-up.
