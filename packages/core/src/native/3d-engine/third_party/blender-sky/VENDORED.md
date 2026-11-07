# blender-sky

The multiple-scattering clear sky of Fernando García Liñán, as Blender ships it (its "Multiple Scattering" sky
texture). Our adapter is `include/scratchbox_sky_ms.hpp`; the scene weather draws it
(`scene-weather.ts` `applySceneWeather`, `skyModel: 'multiple-scattering'`).

| | |
|---|---|
| Upstream | https://projects.blender.org/blender/blender.git |
| Path | `intern/sky/source/sky_multiple_scattering.cpp` |
| Commit | `8be38b821855731aaa3a981110870101962fbb52` (Blender `main`, 2026-11-07) |
| Taken | 2026-11-07 |
| SPDX | `MIT` (SPDX-FileCopyrightText: 2022 Fernando García Liñán; 2011-2025 Blender Authors) |
| Licence text | `LICENSE` (Blender's `doc/license/MIT-license.txt` with the file's copyright lines) |

## Files

| File | Origin | Licence |
|---|---|---|
| `sky_multiple_scattering.cpp` | upstream, modified (below) | MIT |
| `LICENSE` | upstream licence text | MIT |
| `sky_ms_support.h` | **written by Scratchbox**, not upstream | Scratchbox proprietary |

## Not taken

The upstream file includes `intern/sky/source/sky_math.h` and `intern/sky/include/sky_nishita.h`. Both are
`GPL-2.0-or-later`, so neither is copied. `sky_ms_support.h` is our own replacement, written from what the MIT file
calls (float vector types and arithmetic, `mix`, `saturate`, `safe_sqrtf`, `sqr`, `clamp`, a ray-sphere distance, the sun
direction for a zenith cosine, a parallel loop and the file's three entry-point declarations), not from those headers.

Also in that directory and not taken: `sky_single_scattering.cpp` (Apache-2.0, the older Nishita model, not needed) and
`sky_hosek.cpp`, `sky_hosek_data.h`, `sky_hosek.h` (BSD-3-Clause, Hosek-Wilkie, not needed).

## Local changes

1. `sky_multiple_scattering.cpp`: `#include "sky_math.h"` and `#include "sky_nishita.h"` replaced by
   `#include "sky_ms_support.h"`, and a "Modified by Scratchbox LLC, 2026" line added under the original header.
   Nothing else is changed; `diff` against the upstream file shows only those lines.

## How it is used

`scratchbox_sky_ms.hpp` includes the `.cpp` inside `namespace scratchbox::sky_ms::blender_impl` (so its globals, e.g.
`G` and `EARTH_RADIUS`, stay out of the global namespace) and calls `SkyMultipleScattering::precompute_lut`,
`get_inscattering` and `get_transmittance` directly, sampling the sky into the viewer's sky-view table instead of
upstream's equirectangular texture. Include the adapter in one translation unit only (the file defines non-inline
functions). Fixed by the upstream file and not exposed: ground albedo 0.3, aerosol anisotropy g 0.8, Earth radius
6371 km, atmosphere 100 km, 64 ray-march steps.

## Updating

Copy the new upstream file over `sky_multiple_scattering.cpp`, re-apply change 1, check every SPDX line again (take no
GPL file), update the commit and date above, and run `packages/core/test/sky-multiple-scattering.test.ts`.
