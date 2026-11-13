---
name: material-plan
description: >-
  Read a structure's materials from its photogrammetry texture, one material per element of its design intent (wall,
  piers, spandrels, glass, frames), with each material's colour, clean exemplars at real scale, grain, repeat unit,
  finish and library candidates, so infill and procedural rebuilds use the building's own materials instead of the
  nearest texel or a generic set. Use whenever filling holes in a texture, choosing materials for a rebuilt or
  procedural part of a real building, or asked what a building is made of.
---

# Material plan: the building's own materials, per element

A texture is a photo of materials under light. Filling a hole from the nearest texel bleeds one material into the
next; giving a rebuilt pier a generic stone loses the building. The plan reads each material once, from the photo,
at the level of the structure's elements, and hands every element its material.

## 1. Start from the structure, not the texels

Run the blueprint first (`location_building_line_drawing`, see the `structure-blueprint` skill): its design intent
gives every element's shape on every facade. The plan reads materials per element, never per texel, so a stain or a
shadow inside a wall is the wall's material, and repeats, mirrors and twin facades share their source's material.

## 2. Read each material

- **Group** elements by role and what they share a design with (a facade's window family, its piers, a region's wall).
- **Colour**: over the texels the photo reached unblocked and not as a smear. Groups of one role whose colours agree
  are one material; shade reads as one material lit differently (lightness counts little against chroma taken
  relative to lightness). The orthos are not de-lit: the colour is as captured, and the plan says so.
- **Exemplars**: the cleanest patches of each material (fully usable, its own texels only, nearest its mean colour),
  from several elements and facades, cut at their real texel size into `material_atlas.png`.
- **Grain**: luma energy in bands of real size. **Repeat**: a coursing or tile unit only where the exemplars agree on
  one autocorrelation peak, and never finer than two texels of the photo (Google's tile photos are about 8 cm a texel:
  brick courses are below what they resolve; stone coursing and panel joints are not).
- **Finish**: pipeline K's finish read for the nearest class on the same side of the window openings (glass and frames
  against K's opening classes, the rest against the wall's).
- **Library**: candidates only where a finish was read (colour alone cannot tell glass from steel), pipeline K's own
  pick first.

## 3. Use it

- **Infill**: a texel the photo never reached takes its element's material: patches from that material's exemplars at
  its repeat, labelled generated. Never the nearest real texel across an element boundary.
- **Procedural build**: a rebuilt or generated part takes its element's material: the measured colour, the finish, the
  repeat, and the exemplar or library texture at real scale.

## 4. Report honestly

Say how many materials were read and for which roles, which have a finish and from where, and which values could not
be measured (a repeat below the photo's resolution, a band too large for the exemplars). A material the photo never
reached is labelled generated with that reason. Look at the atlas: an exemplar showing another element (a window in a
wall patch) means the element shapes and the photo disagree there, and is a finding to name.
