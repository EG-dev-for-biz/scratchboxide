---
name: cinematic-scene-director
description: >-
  Build an imagined environment for a described shot and deliver a checked render of it: plan the shot and one layout,
  block out, add detail the lens can see, light and haze it, path-trace the hero frame, then compare the frame with the
  brief clause by clause and fix what is wrong. Use whenever a request names a camera (a height, a lens, a frame such as
  2.39:1, "looking down the street", "a low angle"), asks for a cinematic or film-like still of a made-up place, or asks
  to "render the hero shot"; not for a real place (google_3d_tiles_get_clay) or one object (build_3d_object_from_reference).
---

# Cinematic Scene Director

A cinematic frame comes from five decisions more than from settings: real 3D detail where the lens can see it, many
small things, nothing perfect, one low light with air in front of it, and a film camera. This skill is the order to make
them in, with the app's own tools, and the checks that catch the mistakes a scripted scene usually makes.

Read the script guide first (`read_sb_script_guide`): rule 9 there is the reference for `sb.shot`.

## 1. Plan the shot and one layout, before any geometry

Write down, from the brief:
- **The shot:** camera position and target in metres (y up), focal length, frame aspect, frame width. Declare it first in
  the script: `hero = sb.shot(position=..., target=..., focal_mm=..., aspect=..., width_px=1920, name="hero")`.
  Declare more shots only for other angles the brief asks for: every declared shot is detail the scene must hold up to.
- **The layout:** every shared number once, at the top of the script (street, pavement and block widths, footprints and
  heights, storey height, setbacks), and everything else derived from those names. Two parts that must meet are both
  computed from the same number, never typed twice.
- **Sides of the frame:** for everything the brief places left or right, near or far, take its position from the shot:
  `hero.frame_point(x, y, depth)` (x from -1 at the left edge to 1 at the right, y from -1 at the bottom to 1 at the
  top). Looking down -z, frame left is -x. Guessing the axis mirrors the whole scene, sun included.
- **The sun:** its azimuth from the shot too: `hero.sun_azimuth_deg(frame_x)` is the azimuth of a sun ahead of the
  camera toward that frame position (-1.5 ahead and to the left, 1.5 ahead and to the right, plus 180 behind the
  camera), in the convention both `atmosphere_configure_scene` and `path_trace_render` take. Pass the same number to both.

- **A moving camera** (a push-in, a crane, a fly-through): declare a shot for each key pose and join them with
  `sb.camera_move([(0, start), (40, end)], name="push-in")` (times in seconds). The scene's timeline plays the move in the
  viewport, easing in and out; `path_trace_render` with `timeSeconds` renders any moment of it. Build for every key shot:
  the detail budget counts detail as seen when any declared shot resolves it.

## 2. Block out, then look through the lens

Build the large forms only (masses, streets, the hero structures) and run the script. The result's visual review now
includes a clay view through the declared shot: read it before adding detail. Fix anything cut off, hidden, mirrored or
blocking the lens now, while each fix is one number in the layout.

## 3. Detail the lens can see

- **Ask about the whole feature, then size its members.** `hero.resolves(size_m, at=point)` on a feature's overall size
  (a window opening, a balcony, a tank, a vehicle), never on its thinnest part. When it resolves, build it, and build its
  bars, rails, mullions and reveals at `hero.member_m(real_size, at=point)`.
- **A recess reads by its opening and its shadow**, which under a low sun is several times its depth: recess every
  window whose opening resolves.
- **Step down only when the feature stops resolving:** a recessed window with frame, then a recessed opening, then a
  darker band per storey, then plain massing for the farthest blocks.
- **Spend near the lens.** The viewport holds about a million vertices. The result reports the shot detail budget: the
  share of in-frame triangles under 2 px and the parts holding them ("wasted": build those coarser) and pixels per
  triangle ("under-built" past 16: the frame is too plain, add what resolves, nearest first). Act on both, and when you
  rebuild to fix something else, keep the detail you had.
- **Many small things:** rooftop plant, tanks, vents, signs, street furniture, vehicles, all placed with one seeded
  `random.Random(seed)` so the scene rebuilds the same.
- **Nothing perfect:** vary what repeats by the amounts a real place varies (pane offsets of millimetres, blinds, bricked
  windows, parapet and storey differences between neighbours, objects off the grid), each variation above the budget
  where it stands.
- **Long scripts:** build each part in its own function with its own small test of its numbers, and keep the script
  well under a few thousand lines; one indentation slip in a 40 KB script costs a whole run.

## 4. Surfaces, dirt and signs

- Real material looks come from the texture library: `texture_library_search` per surface (colour, finish, tile size),
  then `librarySets` and `sb.library_surface(...)` in the script.
- **Dirt follows causes:** buildings through `sb.write_textured_building(..., weathering=...)` (streaks under ledges and
  sills, soot from the sources you name, rising damp); a generated object through `object_detail_pass`. Never uniform noise.
- **Signs and billboards carry artwork**, made-up brands only: paint each with `decal_generate` and lay it on the panel
  with `asset_decal` (`includeParts` naming the panel's part, or `patchCentre` / `patchSizeM`). A blank panel reads as unfinished.

## 5. Light and air

- One sun as the key, low and ahead of the camera to one side, so faces toward the lens are in shade with bright edges
  and long shadows run toward the lens: `atmosphere_configure_scene` with the sun from step 1.
- Haze for depth, only when the brief asks for air, haze, mist or time-of-day light: `visibilityMeters` (a hazy city
  2000-5000, mist a few hundred) and `hazeScaleHeightMeters` (30-80 for street haze under clear upper air) make the street
  fade while rooftops stay clear.
- The lens: `configure_physical_camera` for depth of field, flare or diffusion when the brief asks for a film look.

## 6. Render, look, compare, fix

- `path_trace_render` with no camera renders the open scene's declared shot at its own frame size, and with
  `timeSeconds` a moment of its camera move (the first, middle and last moments check a move). Open the image with
  `workspace_view_image` and look at it yourself.
- **Compare the frame with the brief clause by clause** (each object asked for, its side of the frame, the light's side,
  the lens and frame, the air) and fix the first clause that fails before rendering again.
- **The still carries the scene's light:** `path_trace_render` of the open scene takes its sun and haze, the same haze
  the viewport draws. Say what the render cannot show: trees carry every leaf and twig there but no textures (the viewport dresses them from its
  tree texture library), so they read as grey geometry close to the lens.
- Deliver the still and the scene together, with what is generated (everything here) said plainly.
