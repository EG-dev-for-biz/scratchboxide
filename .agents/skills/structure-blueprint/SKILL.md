---
name: structure-blueprint
description: >-
  Think about a structure the way its builder did: work out what the task asks for, then infer the exterior's design
  intent (not only what the scan and photos captured), decide region by region whether its design repeats, is symmetric
  or is neither, and produce a structural line drawing with a material ID map in the same pixels. Use whenever asked
  for a blueprint, elevation, line drawing, structural guide, facade layout or material map of a building or any built
  object, and before rebuilding or texturing a structure whose capture is incomplete.
---

# Structure blueprint: the design intent, drawn

A capture is a partial, noisy view of a designed thing. Windows smear, a tree hides a bay, the photo never reaches a
face, a reflection reads as a frame. The designer laid out a frame, a rhythm and a few materials; the blueprint shows
that layout, labelled honestly where it was inferred.

## 1. Read the task first

Before drawing anything, settle:
- **What is it?** The building's name and address when there is one (the staged run's request), else what the scan
  and photos show. Say it in one line.
- **What is the drawing for?** A guide for a rebuild, a texture plan, an elevation for people to read, a check of
  what was captured. It decides how far to infer: a guide for a rebuild fills what the capture missed; a check of the
  capture shows only what was read (style `lines`).
- **What evidence exists?** The scan, the textured scan, pipeline K's facade readings (its window fit, facade reader,
  window arrays, wall grammar), the symmetry reading, the measured twin's clean shell.

## 2. Start from the pattern; make the exception prove itself

A designed facade repeats: repetition is cheap to design and build, exceptions cost. So the default is one lattice
per face, and the burden of proof is on the exception, not on the pattern:
- **Propose top-down.** The bay from the photo's period measured over the whole face (pipeline K's `periodM`; on the
  Empire State Building 5.54 m on 38 of 61 large faces), the windows within a bay from the read windows folded at it,
  the rows on the building's storey. Window boxes refine the module; they do not have to prove the lattice exists.
- **Test every site** against the photo (and the scan's depth where it resolves a recess; Google's tiles model the
  facade as a flat skin, so there depth only says where the face is).
- **A detail must be coherent:** a run of contradicted sites over two rows or three columns, aligned to the grid,
  backed by more than one source (or twice the size where only one speaks). Isolated contradictions are capture noise
  (glare, a smear, a misread) and the pattern overrides them, flagged.
- **Choose the simplest description that explains the evidence:** the lattice stands only when it explains most of
  the windows read and overrides little; an irregular face (a crown, a one-off) falls back to the readings below.

## 3. Decide how each region is organised: from evidence, never assumed

Split every face bottom to top into regions where its pattern changes (a base, a shaft, a crown; a blank band is a
region too). For each region decide, and record the scores that decided it:

| Decision | When | What it adds |
|---|---|---|
| **repeat** | the openings sit on one pitch across (most columns on the lattice, most sites between the first and last occupied) and, with three or more rows, one pitch up | every lattice site inside the region's read extent holds the module; sites the capture missed are inferred from the repeat |
| **symmetric** | most openings mirror onto an opening about the face's own axis (the symmetry reading's, when it is a mirror and not just repetition) or the region's centre | each pair averaged; an unpaired opening gains its mirror |
| **neither** | no pitch holds and nothing mirrors | nothing: the openings stand as read. A one-off entrance, an irregular crown, an object with no order is a valid answer, never something to force a grid onto |

Before anything is laid in an empty site, ask the photo (pipeline K's facade photo with its uncovered, occluded and
featureless masks) what it says there:
- **window**: it shows an opening (the site contrasts with the wall around it the way the read windows do);
- **wall**: it reached the site, saw it plainly, and it reads as the wall around it. **Closed**: nothing is laid;
- **occluded** or **unread**: something stood in front, or the photo never reached it or smeared it. **Open**.

Absence of evidence is not evidence of absence: only a site read as wall stops the design. Without the photo, nothing
is carried past what was read.

Then carry the design as far as the structure goes:
- **To the wall's ends**: a repeat runs on past its last read column while the photo does not read the column as
  wall, to a window's width from the face's edge. A builder runs the grid to the corner, not to where the camera
  stopped.
- **Through gaps**: two repeating bands with one lattice (pitch, phase, window size) are one shaft; the rows between
  them are laid at the shaft's row pitch (or the building's storey).
- **The frame**: piers between the columns (one piece down a shaft, through its spandrels) and floor lines between the
  rows are inferred with the windows: the structure the openings sit in.

Then across the whole structure:
- **Setback tiers**: the faces of one tier share a pattern (the column pitch, window size and row pitch its repeating
  bands carry most). A poorly read face takes it when its few read windows sit on it; one whose windows do not is its
  own design. A face with too few windows to place the pattern is left to the plan's symmetry.
- **Plan symmetry**: under a plan mirror or rotation that scores high, a poorly read face whose mapped partner
  coincides with it (same normal, plane and extent) takes the partner's windows: the partner's own reading and its own
  inferences, never windows other faces lent it.
- **Twin faces**: two faces the symmetry reading accepted as one transformed into the other (a plan mirror or
  rotation) share their openings only where they agree on what both read; otherwise they are two designs.
- **Floors**: one storey height and datum for the whole building, from the repeating regions' rows; a region whose
  row pitch agrees sits on those floor lines. A builder does not put one face's floors half a storey off the next.
- **Strips**: an opening several storeys tall whose panes stack is a column of windows; panes side by side are
  mullions.

## 4. Draw it, and map its materials in the same pixels

Call `location_building_line_drawing` (style `blueprint`, the default). It runs the reasoning above
(`structure-intent.ts`) and writes, per view:
- the elevation sheet (PNG and SVG): outline from the measured twin's shell when there is one, else the scan;
  recessed bays, piers, windows with frames, mullions, sills and spandrels from the intent; levels, dimensions, centre
  lines; oblique faces (a wedge plan's sides) foreshortened;
- `material_<view>.png`: every drawn region one material ID. Each element (a window family's glass and frames, a
  wall's bays, a facade's spandrels, the bare wall in blocks) is read from the photo as a whole, merged by colour with
  shade read as one material lit differently; the bare wall takes one material per facade region (a band of one
  design), and elsewhere its neighbourhood's majority, so a stain or a shadow inside a wall is the wall's material. The
  street and loose fill outside the building's footprint (its closed plan outline from 3 m up) are left out. Repeats, mirrors and twins share their source's material;
- `material_lines_<view>.png`: the drawing over the ID map, to check that lines and materials agree;
- `material_ids.json` (each ID's role, colour in the map, mean photo colour, area, provenance) and
  `structure_intent.json` (each region's decision with its scores, each window's provenance: measured, repeat,
  mirror, twin).

## 5. Report it honestly

- Say how many regions were decided each way and why, how many openings were inferred and from what (repeat, mirror,
  twin; and whether the photo showed a window there or could not tell), how many sites were withheld as wall, and the
  storey.
- Inferred content is labelled as inferred (repeat, mirror, twin; generated where nothing was read). Never call it
  measured.
- Look at the sheets before saying they are good: a region filled with a grid the photo does not show, a mirror that
  doubles windows, or an ID map that splits one wall into patches are failures to name, not to hide.
