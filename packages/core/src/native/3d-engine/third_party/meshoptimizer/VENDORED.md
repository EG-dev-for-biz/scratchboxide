---
name: meshoptimizer
upstream: https://github.com/zeux/meshoptimizer
version: v1.3
commit: 9e1f07b159d3cb777f1c67ed31fc11fd117986f4
vendored: 2026-11-07
spdx: MIT
license: LICENSE.md
copyright: Copyright (c) 2016-2026 Arseny Kapoulkine
sources: src/*.cpp
---

# meshoptimizer

Mesh simplification (quadric, error-bounded, attribute-aware), vertex cache, overdraw and vertex fetch
optimisation, meshlets and vertex/index codecs, by Arseny Kapoulkine.

## Files taken

From tag `v1.3` (commit `9e1f07b`, released 2026-09-25):

- `src/*.cpp` and `src/meshoptimizer.h`: all 21 translation units and the one header, byte for byte.
- `LICENSE.md`: the upstream licence, byte for byte.

Not taken: `demo/`, `extern/`, `gltf/` (gltfpack), `js/`, `tools/` and the build files. We build with the app's own
native builder (`native-third-party.ts` `buildVendoredLibrary('meshoptimizer')`).

## Local changes

None.

## Our adapter

`include/scratchbox_meshopt.hpp` (simplification, vertex cache and vertex fetch optimisation on the engine's
`Mesh`).
