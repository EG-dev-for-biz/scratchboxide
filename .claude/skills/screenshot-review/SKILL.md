---
name: screenshot-review
description: Examine a screenshot or render of Scratchbox work (a viewport capture, a headless clay render, a side-by-side of candidates, an overlay on a photo) and say, region by region, what has gone right and what has gone wrong, why, and what to check next. Use every time a picture of the work exists - after a build, a render, a fit or an overlay, before claiming any visual result is good, whenever a metric and a picture might disagree, and whenever the user sends a screenshot and asks what is wrong.
---

# Screenshot review: what went right, what went wrong, and why

## Why this exists

Numbers about geometry are easy to trust and easy to fool. On 2026-10-23, in one session:

- the Space Needle's lofted candidate scored F 0.85 against its scan, the best of the day, and the render showed its
  three legs missing and its shaft in pieces (thin parts are a small share of the scan, so the score barely moved);
- the Haughwout block looked exactly right in a render and scored 0.52 coverage, because the "scan" it was judged
  against still carried a rooftop water tower, plant and the neighbours' spill;
- a clay render came out solid black (the renderer takes 0-255 colours and was handed 0-1), and a panel labelled
  "block + roof objects" showed the plain block (a path substitution had silently matched nothing).

Only looking caught each of these. The picture decides; the numbers explain. This skill is how to look.

## 1. Get the picture in front of you, at a size you can read

- Read the PNG/JPG with the Read tool. For a wide side-by-side, also Read crops of each panel: a 2000 px strip of four
  panels is shown to you at about half size, and small parts (a leg, a railing, a 1 m duct) vanish.
- `scripts/review_image.py` (this skill) makes the crops and side-by-sides:
  - `crop <image> <x0> <y0> <x1> <y1> <out.png> [--scale 2]` - one region, enlarged;
  - `panels <image> <n> <outdir>` - split a strip of n equal panels into files;
  - `compose <out.png> <title> <label=path> ...` - a labelled side-by-side (every image you send carries a title and
    numbered labels: the user's standing rule).
- Live app: take the screenshot with the Browser pane (`computer` screenshot, then `zoom` on the region). Headless:
  `HeadlessMeshSilhouetteRenderer.renderShadedMesh` (clayColor in 0-255) from fixed cameras, the same cameras for every
  candidate.
- Send every picture you judge to the user with SendUserFile (`display: "render"`) as it lands, labelled. If the user
  says they cannot see them, send them again; do not describe instead.

## 2. Check the picture shows what it claims before judging the work

A wrong picture produces a confident wrong review. First rule these out:

| Symptom | Likely cause | Check |
|---|---|---|
| Solid black or flat silhouettes | colour scale (0-1 vs 0-255), normals flipped, light behind | render a known box with the same call |
| Two panels identical where they should differ | the file path or substitution did not apply | `grep` the script for the second path; print each file's triangle count |
| Object not where expected / missing | wrong frame (scan vs tile vs ENU), camera target off, near-plane clip | print the mesh bounds beside the camera target |
| Everything grey and untextured in the app | clay mode, or textures not published yet | the viewport's Show clay toggle; the build's layer list |
| Viewport shows an older scene | the chat opened a different artifact; HMR reloaded | the scene title and version (v7 of 7) in the viewport |

State which of these you ruled out, and how.

## 3. Compare against a reference, never in isolation

A picture alone cannot say "wrong". Put it beside what it should match, from the same viewpoint:

- **the source**: the isolated scan, the photo tiles (top-down photo for roofs and lawns), Street View;
- **the previous version** or the shipped pipeline (pipeline K today) at the same camera;
- **a known case**: a synthetic test with a known answer, or the Haughwout benchmark.

Make an **inventory** of the reference first, then tick it off in the result. For a roof: tank, bulkheads, hatch,
skylight, plant, ducts, railing posts; for a tower: shaft, legs, rings, deck, spire; for a lawn map: each lawn, the
paths, the fountain. Number the items on the reference image. Every reference item is then **present and right**,
**present but wrong** (say how: size, height, shape, place), or **missing** - and every item in the result that is
not in the reference is **invented**.

## 4. Look for these failure shapes

- **Missing thin parts**: legs, posts, masts, railings, cables - small share of area, large share of what reads.
- **Merged things**: several objects fused into one blob (a tank and the ducts beside it).
- **Over-split things**: one object in many fragments, often from colour or sampling noise.
- **Bleed**: a tall object's height or colour spreading onto neighbours (scan blur is about the tiles' geometric error,
  1-2 m).
- **Stair-steps and terraces** where the real surface is smooth or tapered.
- **Shredded surfaces**: holes, slivers, inside-out faces (a loft or remesh copying scan noise).
- **Floating or buried parts**: not touching their support, or sunk into it.
- **Wrong kind of shape**: a pitched roof on a flat roof, a prism for a revolved tank, a strip for a row of posts.
- **Scale and placement**: compare a known dimension (a car is about 4.5 m, a storey about 3-4 m, a door about 2 m).
- **Uninvited content** (AGENTS.md section 3.6): skies, fog, ground slabs nobody asked for; trees that are not SB-Veggie.
- **Honesty of labels**: estimated or generated parts shown as measured.

## 5. Reconcile the picture with the numbers

When a metric and the picture disagree, the disagreement is the finding:

- metric good, picture bad: the metric is blind to that failure (area-weighted scores hide thin parts; plan-view
  IoU hides height) - say which failure, and how to measure it next time (per-height bands, per-object inventory);
- metric bad, picture good: the metric is judged against the wrong thing (clutter in the scan, hidden party walls,
  the tolerance below the source's own blur) - say what, and fix the reference before trusting the score.

## 6. Write the review in this shape

```
Picture: <what it is, which panels, which camera>; ruled out: <section 2 checks>
Right:
 1. <item> - <where in the picture> - <why it is right, with a number if one exists>
Wrong:
 1. <item> - <where> - <how it is wrong> - likely cause: <mechanism> - check: <the one test that would confirm it>
Numbers vs picture: <agree / disagree, and what that means>
Next: <the single most valuable fix, then the next>
```

Tie every claim to a visible region ("panel 3, the tank", "top-left corner of the roof"), never to what the code was
meant to do. Say "I can't tell from this picture" and name the picture that would tell, rather than guess. Do not call
a result good from a thumbnail: crop and look at the parts that matter.
