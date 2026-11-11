# The place picker: the chat asks "where" on a map

**Date:** 2026-11-11 · **Branch:** `feat/place-picker` · **Status:** Verified (the map card, search, the pin and area circle, the pick reaching the build tool); Unverified (a point pick for one building; touch input; a finished district from a pick).

## What was asked

The user (2026-11-11): the 3D Scene and 3D Building buttons should both ask where, and the follow-up question "could even give the user a 2d overhead graphic map from google so they can select a physical location".

## What was built

- `ask_user_question` takes `placePicker` (`message`, `query`, `lat`/`lng`, `radiusMeters`). Its card shows Google's 2D roadmap: drag to pan, scroll or +/− to zoom, click to drop the pin, a search box, and for an area a circle with a radius slider (50 to 500 m).
- The pick goes back to the chat as `[Place picked on the map]: <lat>, <lng>…`, which the build tool takes as a "latitude, longitude" query.
- Tiles: the existing `/api/map-data/roadmap/tile/:z/:x/:y` (the Map data view's). Search: new `/api/map-data/geocode?q=`, one Places lookup through `GoogleMapsService`.
- `SPATIAL_INTENT_POLICY`: a request for a real place that names none calls the picker.

## Live check (own instance `scratchbox-main-now`, ports 4610-4612, current main plus this branch)

1. New chat, **3D Scene** button: the chat called `ask_user_question` and the card "Pick a Place for Your 3D Scene" showed the map with its search box.
2. Search "Flatiron Building, New York": the map centred on it at zoom 16, the pin on the building, a 250 m circle and the slider; the status line read `40.74106, -73.98970 · 250 m radius · Flatiron Building, 175 5th Ave, New York, NY 10010, USA`.
3. **Use this place**: the card showed Confirmed, the pick was sent as the user's message, and the chat called `google_3d_tiles_get_clay`; the district's Google vector massing appeared in the viewport within about 20 s.
4. `/api/map-data/geocode?q=The Plaza Hotel, New York` → 768 5th Ave, 40.7646318, −73.9743251. Tile `16/19301/24627` → 200, image/png.

## Findings

- **A fresh checkout serves no tiles until its workspace root is allowed.** The tile route answered 403 `workspace_root_not_allowed` for a worktree outside the allowed roots; the launch entry needs `SCRATCHBOX_WORKSPACE_ROOTS`. The picker then shows "The map could not be loaded… Type the place or address in the chat instead."
- **The first card carried no explanation**, only the map: the chat put nothing in its text. `placePicker.message` now holds the explanation and suggestion, shown above the map (not re-checked live after that change).
- A fresh checkout also has no `.env`, `secrets.json` or `service-account.json` (gitignored), so no Maps key: link them from the main checkout.

## Candidate tool/service ideas

- A satellite layer toggle on the picker (the 2D Tiles API has a satellite map type), so a building can be told from its neighbours.
- Draw Google's building footprint under the pin for a point pick, so the user sees which structure `isolate` will take.
- The tile route should not need a workspace root: its cache could live in the app's own cache directory.
