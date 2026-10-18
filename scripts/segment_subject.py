#!/usr/bin/env python3
"""MediaPipe Image Segmenter — per-frame holdout matte generator.

Reads a single input image file and writes a binary PNG mask to the output path.
White pixels (255) = foreground subject; black pixels (0) = background.

Usage:
    python3 scripts/segment_subject.py <input_png_path> <output_mask_path>

The mask comes from MediaPipe: the Tasks ImageSegmenter with a selfie_segmenter.tflite model file when one is
found, else the legacy SelfieSegmentation solution. The answer names the model that made the mask, and why the
first one was not used. When neither can run, no mask is written and the answer is a failure with each reason;
nothing else (no GrabCut guess, no fixed rectangle) stands in for a segmentation.

Output (stdout, one JSON line):
    {"success": true, "inputPath": "...", "outputPath": "...", "width": 1920, "height": 1080,
     "model": "...", "modelNote": "..." (only when the first model was not used)}
    On error: {"success": false, "error": "..."} and a non-zero exit code
"""

import json
import os
import sys

# Models created once and reused for every later frame when this script runs in a persistent worker
# (packages/core/src/python/scratchbox/worker_host.py).
_TASKS_SEGMENTERS = {}
_LEGACY_SEGMENTER = []


def main() -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore  # noqa: F401
    except ImportError as e:
        print(json.dumps({"success": False, "error": f"Missing dependency: {e}. Install: pip install opencv-python-headless"}))
        sys.exit(1)

    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Usage: segment_subject.py <input_path> <output_path>"}))
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    if not os.path.exists(input_path):
        print(json.dumps({"success": False, "error": f"Input file not found: {input_path}"}))
        sys.exit(2)

    img_bgr = cv2.imread(input_path, cv2.IMREAD_COLOR)
    if img_bgr is None:
        print(json.dumps({"success": False, "error": f"Failed to decode image: {input_path}"}))
        sys.exit(2)

    h, w = img_bgr.shape[:2]

    mask, model, reasons = _run_mediapipe_segmenter(img_bgr)
    if mask is None:
        print(json.dumps({"success": False, "error": "MediaPipe could not segment the frame: " + "; ".join(reasons)}))
        sys.exit(4)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    if not cv2.imwrite(output_path, mask):
        print(json.dumps({"success": False, "error": f"Failed to write mask to: {output_path}"}))
        sys.exit(3)

    answer = {"success": True, "inputPath": input_path, "outputPath": output_path, "width": w, "height": h, "model": model}
    if reasons:
        answer["modelNote"] = "The MediaPipe Tasks selfie segmenter was not used: " + "; ".join(reasons)
    print(json.dumps(answer))


def _run_mediapipe_segmenter(img_bgr):  # type: ignore
    """Returns (uint8 binary mask, model name, reasons earlier models were not used), or (None, None, reasons)."""
    reasons = []
    try:
        import mediapipe as mp  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as e:
        return None, None, [f"mediapipe is not installed ({e}); install it with: pip install mediapipe"]

    img_rgb = img_bgr[:, :, ::-1].copy()

    # MediaPipe Tasks ImageSegmenter (MediaPipe 0.10+) with a selfie segmenter model file.
    model_path = _find_model_path([
        "assets/models/selfie_segmenter.tflite",
        "assets/models/selfie_segmentation.tflite",
        os.path.expanduser("~/.cache/mediapipe/selfie_segmenter.tflite"),
    ])
    if not model_path:
        reasons.append("no selfie_segmenter.tflite in assets/models or ~/.cache/mediapipe")
    else:
        try:
            from mediapipe.tasks import python as mp_python  # type: ignore
            from mediapipe.tasks.python import vision  # type: ignore

            opts = vision.ImageSegmenterOptions(
                base_options=mp_python.BaseOptions(model_asset_path=model_path),
                output_category_mask=True
            )
            segmenter = _TASKS_SEGMENTERS.get(model_path)
            if segmenter is None:
                segmenter = vision.ImageSegmenter.create_from_options(opts)
                _TASKS_SEGMENTERS[model_path] = segmenter
            result = segmenter.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb))
            if result.category_mask is not None:
                cat = result.category_mask.numpy_view().astype(np.uint8)
                # Category 1 = person/foreground
                return np.where(cat == 1, np.uint8(255), np.uint8(0)), f"mediapipe-tasks-image-segmenter ({os.path.basename(model_path)})", reasons
            reasons.append(f"the Tasks ImageSegmenter ({model_path}) returned no category mask")
        except Exception as e:  # noqa: BLE001 - the reason is reported in the answer
            reasons.append(f"the Tasks ImageSegmenter ({model_path}) failed: {e}")

    # Legacy SelfieSegmentation solution (bundled with the mediapipe package).
    try:
        if not _LEGACY_SEGMENTER:
            _LEGACY_SEGMENTER.append(mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=1))  # type: ignore
        result = _LEGACY_SEGMENTER[0].process(img_rgb)
        if result.segmentation_mask is not None:
            # Binarize: > 0.5 confidence → foreground
            return (result.segmentation_mask > 0.5).astype("uint8") * 255, "mediapipe-legacy-selfie-segmentation (model_selection=1)", reasons
        reasons.append("the legacy SelfieSegmentation solution returned no mask")
    except Exception as e:  # noqa: BLE001 - the reason is reported in the answer
        reasons.append(f"the legacy SelfieSegmentation solution failed: {e}")

    return None, None, reasons


def _find_model_path(candidates: list) -> "str | None":
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


if __name__ == "__main__":
    main()
