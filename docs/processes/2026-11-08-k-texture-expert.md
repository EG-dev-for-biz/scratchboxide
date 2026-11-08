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
- `material-regions.ts` `applyFrameFinish`: the texels of a window holding a glass pane, outside its glass, are drawn no smoother than 0.35.
- `.claude/skills/pbr-material-review`: the coding agents' screenshot review against the same reference.

## Step 3: uncached builds, main 17f1d2f1 against branch 141da180, one shared answer store

Benchmark `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-08-texture-expert`. Sheet: `texture-expert-proof-sheet.jpg` there.

| Building | reflective main -> branch | metal > 0.1 | rough < 0.4 |
|---|---|---|---|
| Penn 2 | 86.2% -> 32.1% | 68.3% -> 0.1% | 20.3% -> 32.0% |
| ESB | 12.5% -> 12.4% | 1.2% -> 0.0% | 12.4% -> 12.4% |
| Lever House | 100% -> 100% | 0% -> 0% | 100% -> 100% |
| 30 Rock | 14.1% -> 14.1% | 0.1% -> 0.0% | 14.1% -> 14.1% |
| Seagram | 100% -> 100% | 42.5% -> 58.1% | 100% -> 42.0% |

- **Penn 2:** the spandrels and mullions are read as painted metal panels (a dielectric) at 0.40-0.45, no longer anodised metal at 0.8.
- **ESB and 30 Rock:** the stone is drawn rougher (0.75-0.85, against 0.6-0.8 on main) with about half the set grain; the last hedged metal is gone; what is still reflective is glass. Frames beside the panes are raised from 0.08 to 0.35 (1.2% of the ESB's texels), still under the 0.4 line.
- **Seagram:** the bronze is read bronze (metal 1) at 0.50-0.55, against 0.24 on main, and one class main drew as glass at 0.08 now reads bronze. So metal rises and smoothness falls; the reflective share stays 100%.
- **Lever House:** an all-glass curtain wall, read as glass. Its two light classes were named brushed stainless (reference row 12, held to 0.25) but main's shade-twin rule (`settleFinishes`) overruled them into the glass finish: follow-up.

**Not done:** app-viewer close-ups at a raking sun. The session's window was closed, so the Browser pane ran as a background page and could not load the textured twins. Launch entries `scratchbox-tx-main` and `scratchbox-k-texture-expert` (ports 3270-3282, shared answer store) are in the main checkout's `.claude/launch.json`, ready for them.
