# Python sidecars — one resolver, the project's .venv, typed failure

**Date:** 2026-10-19 · **Target:** every Python spawn in the app (object and occluder masks, subject segmentation, pose, depth, TAPIR, photo tier, the Python 3D engine) · **Status:** Verified

## What was wrong
Each sidecar picked its interpreter its own way (`PYTHON_BIN`, `SCRATCHBOX_DEPTH_PYTHON`, a `findUp` for `.venv`, a list of Homebrew paths) and all fell back to `python3` on PATH. Started with the system Python, which has no OpenCV, `ObjectSegmenterService` / `scripts/segment_object.py` (used by the texture pass and `streetview_survey`) failed on every view.

## What changed
- `resolveRepoPython({ overrideVars, modules, purpose })` (`packages/core/src/node/process/repo-python.ts`): a sidecar's own variable when it has one (`SCRATCHBOX_DEPTH_PYTHON`, `SCRATCHBOX_POSE_PYTHON`), else `SCRATCHBOX_PYTHON`, else the project's `.venv/bin/python` (in a git worktree without its own `.venv`, the main checkout's). Never `python3` on PATH; `PYTHON_BIN` is no longer read.
- A missing interpreter, or one without the modules the sidecar imports (checked with `importlib.util.find_spec`, cached on success), throws `PythonEnvironmentError` (`python_interpreter_missing` | `python_modules_missing`) with the fix, e.g. ``run `/usr/bin/python3 -m pip install numpy opencv-python mediapipe` ``.
- Services resolve at first use, not at construction (several are constructed at module load), through the shared resolver: ObjectSegmenterService, VfxSubjectSegmenterService, MediaPipePoseService, PanoramaDepthService, TapirTrackingService, NativePythonRunnerService (and local SF3D through it), photo-tier rectify, streetview ownership masks; PerformerPoseTrackService and GvhmrBodyService keep their dedicated venvs and fall back to the resolver instead of `python3`.
- Startup check (`logPythonEnvironment`, desktop-app/server/app.ts): logs the interpreter and that numpy, cv2, mediapipe, PIL, torch, transformers are present, or the error and its fix.

## Live results (worktree picker-python, ports 3261/3262/3263, in-app agent)
| Start | Startup log | `streetview_survey` Haughwout, `ownershipMasks: true` |
|---|---|---|
| no `SCRATCHBOX_PYTHON`, no `PYTHON_BIN` | `[Scratchbox Python] sidecars run on …/picker-python/.venv/bin/python (the project's .venv); numpy, cv2, mediapipe, PIL, torch, transformers present` | 4 views, all `segmented`: owner/occluder masks written (IoU 0.78, 0.894, 0.809, 0.375) |
| `SCRATCHBOX_PYTHON=/usr/bin/python3` | error: needs numpy, cv2, mediapipe, PIL, torch, transformers … Fix: run `/usr/bin/python3 -m pip install …` | every view `refused` with "The object segmenter (scripts/segment_object.py) needs the Python modules numpy, cv2, mediapipe, which /usr/bin/python3 does not have. Fix: run `/usr/bin/python3 -m pip install numpy opencv-python mediapipe`" |

## Evidence
`test-results/screenshots/picker_python/live_python_masks_haughwout_building.png` (the chat result), `live_python_masks_overlay.jpg` (the 4 views with their ownership and occluder masks). Test: `packages/core/test/repo-python.test.ts`.

## Candidate Tool/Service Ideas
- A `/api/health/python` route returning `checkPythonEnvironment()`, so the Settings page can show the interpreter and missing modules.
