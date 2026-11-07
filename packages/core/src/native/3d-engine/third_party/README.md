# Vendored third-party code in the native engine

Scratchbox is proprietary (`UNLICENSED`). Outside code comes into the native engine only under one of these
licences (SPDX): `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `Zlib`, `BSL-1.0` (Boost), `ISC`, and
`MPL-2.0` **only as unmodified files**. GPL, LGPL and AGPL code is never copied; an idea from GPL code (Blender's
own modules, for instance) is rewritten clean-room from the published paper, as our own code, outside this folder.
Non-commercial and "research only" licences are never accepted, nor code with no licence.

`packages/core/test/native-third-party.test.ts` enforces this: it fails when any file here carries a GPL-family or
non-commercial licence, when a library has no licence file or no allowed SPDX id, when an MPL library lists a local
change, and when the root `NOTICE.md` is out of date.

## Layout

```
third_party/
  README.md                this file
  <name>/                  one folder per library, named as upstream names it (lower case)
    VENDORED.md            what was taken, from where, and every local change (below)
    LICENSE[.md|.txt]      the upstream licence file, byte for byte
    src/ include/ ...      the upstream files, copied unchanged where possible, in upstream's own layout
```

- Copy only the files the engine needs (sources and headers), keeping upstream's relative paths so its own
  `#include "..."` lines resolve unchanged. Leave out demos, tests, bindings and build files.
- Edit vendored files only as far as you must (a build fix, a missing include). Every modified file keeps its
  original licence header and adds, directly below it:
  `Modified by Scratchbox LLC, 2026: <what changed>`
  and the change is listed under "Local changes" in `VENDORED.md`.
- Our own glue never lives here. The adapter that turns the library's API into engine types goes in
  `include/scratchbox_<x>.hpp` (e.g. `include/scratchbox_meshopt.hpp`) under our own header.

## VENDORED.md

It starts with a front matter block the tools read, then free text for people:

```
---
name: meshoptimizer                                   # the folder name
upstream: https://github.com/zeux/meshoptimizer       # the repository (or release page)
version: v1.3                                         # the exact tag, or "commit" when there is none
commit: 9e1f07b159d3cb777f1c67ed31fc11fd117986f4      # the full commit the files came from
vendored: 2026-11-07                                  # the date they were copied
spdx: MIT                                             # SPDX id (an AND/OR expression of allowed ids is fine)
license: LICENSE.md                                   # the licence file in this folder
copyright: Copyright (c) 2016-2026 Arseny Kapoulkine  # the upstream copyright line(s), for NOTICE.md
sources: src/*.cpp                                    # what the builder compiles (globs, space separated; .c, .cc, .cpp)
cflags: -DFOO=1                                       # optional, extra flags for this library's own sources
---
```

Below it: a short description, "Files taken" (which files, from which tag), "Local changes" (every edit, file by
file, or `None.`), and "Our adapter" (the `scratchbox_<x>.hpp` that wraps it). A header-only library leaves
`sources` empty.

## Building

`packages/core/src/node/3d-engine/native-third-party.ts`:

- `nativeThirdPartyRoot()` is on the include path of every engine compile (`NativeCppCompilerService.compileSource`
  adds it after `include/`), so engine code writes `#include "meshoptimizer/src/meshoptimizer.h"`.
- `buildVendoredLibrary(name)` compiles the library's `sources` once into a static archive in the native build
  cache, keyed on the content of every source and every header they include, the flags and the compiler. It uses
  the engine's flags (`clang++ -std=c++20 -O3`, C sources `-std=c11 -O3`; `-march=native` only with
  `SCRATCHBOX_NATIVE_ARCH=1`) plus the library's `cflags`. It returns the archive's path.
- To link it: `compileSource(code, { vendored: ['meshoptimizer'] })`, or put the archive path from
  `buildVendoredLibrary` in a `NativeCompileSpec`'s `libs` (with `nativeThirdPartyRoot()` in `includeDirs`).

No system packages are installed: a library either builds from its vendored sources or is not used.

## Notices

`npm run notices:native` rewrites the "Native third-party code" section of the root `NOTICE.md` from every
`VENDORED.md` and licence file here. Run it after adding or updating a library and commit the result; never edit
that section by hand. The test fails when it drifts.

## Adding a library (checklist)

1. Confirm the licence is on the list above (read the licence file and the headers of the files you take).
2. Copy the files into `third_party/<name>/`, with the licence file, unchanged.
3. Write `VENDORED.md` (front matter and the three sections).
4. Write the adapter `include/scratchbox_<x>.hpp`.
5. `npm run notices:native`, then run `packages/core/test/native-third-party.test.ts`.
