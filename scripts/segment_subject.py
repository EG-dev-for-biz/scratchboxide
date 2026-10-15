#!/usr/bin/env python3
"""MediaPipe Image Segmenter — per-frame holdout matte generator.

Reads a single input image file and writes a binary PNG mask to the output path.
White pixels (255) = foreground subject; black pixels (0) = background.

Usage:
    python3 scripts/segment_subject.py <input_png_path> <output_mask_path>

Output (stdout):
    JSON: {"success": true, "inputPath": "...", "outputPath": "...", "width": 1920, "height": 1080}
    On error: {"success": false, "error": "..."}
"""

import json
import os
import sys


def main() -> None:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
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

    # Try MediaPipe Image Segmenter (selfie segmentation model).
    # Falls back to GrabCut-based saliency segmentation if MediaPipe is unavailable.
    mask = _run_mediapipe_segmenter(img_bgr) or _run_grabcut_fallback(img_bgr)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    success = cv2.imwrite(output_path, mask)
    if not success:
        print(json.dumps({"success": False, "error": f"Failed to write mask to: {output_path}"}))
        sys.exit(3)

    print(json.dumps({"success": True, "inputPath": input_path, "outputPath": output_path, "width": w, "height": h}))


def _run_mediapipe_segmenter(img_bgr) -> "np.ndarray | None":  # type: ignore
    """Run MediaPipe SelfieSegmentation model. Returns uint8 binary mask or None if unavailable."""
    try:
        import mediapipe as mp  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        return None

    try:
        # Try the newer Tasks API first (MediaPipe 0.10+)
        from mediapipe.tasks import python as mp_python  # type: ignore
        from mediapipe.tasks.python import vision  # type: ignore
        import numpy as np  # type: ignore

        # Look for model in common locations
        model_path = _find_model_path([
            "assets/models/selfie_segmenter.tflite",
            "assets/models/selfie_segmentation.tflite",
            os.path.expanduser("~/.cache/mediapipe/selfie_segmenter.tflite"),
        ])

        if model_path:
            base_opts = mp_python.BaseOptions(model_asset_path=model_path)
            opts = vision.ImageSegmenterOptions(
                base_options=base_opts,
                output_category_mask=True
            )
            segmenter = vision.ImageSegmenter.create_from_options(opts)
            img_rgb = img_bgr[:, :, ::-1].copy()
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb)
            result = segmenter.segment(mp_image)
            if result.category_mask is not None:
                cat = result.category_mask.numpy_view().astype(np.uint8)
                # Category 1 = person/foreground
                mask = np.where(cat == 1, np.uint8(255), np.uint8(0))
                return mask
            segmenter.close()
    except Exception:
        pass

    # Legacy SelfieSegmentation model
    try:
        import mediapipe as mp  # type: ignore
        import numpy as np  # type: ignore

        with mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=1) as seg:  # type: ignore
            img_rgb = img_bgr[:, :, ::-1].copy()
            result = seg.process(img_rgb)
            if result.segmentation_mask is not None:
                raw = result.segmentation_mask
                # Binarize: > 0.5 confidence → foreground
                mask = (raw > 0.5).astype("uint8") * 255
                return mask
    except Exception:
        pass

    return None


def _run_grabcut_fallback(img_bgr) -> "np.ndarray":  # type: ignore
    """GrabCut-based coarse foreground/background segmentation (no model required)."""
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    h, w = img_bgr.shape[:2]

    # Assume subject is centred in the frame (typical for talent/performer shots)
    margin_x = max(1, w // 10)
    margin_y = max(1, h // 10)
    rect = (margin_x, margin_y, w - 2 * margin_x, h - 2 * margin_y)

    mask_gc = np.zeros((h, w), np.uint8)
    bg_model = np.zeros((1, 65), np.float64)
    fg_model = np.zeros((1, 65), np.float64)

    try:
        cv2.grabCut(img_bgr, mask_gc, rect, bg_model, fg_model, 5, cv2.GC_INIT_WITH_RECT)
        final = np.where((mask_gc == cv2.GC_FGD) | (mask_gc == cv2.GC_PR_FGD), np.uint8(255), np.uint8(0))
    except Exception:
        # Last-resort: return a solid white rectangle in the centre third
        final = np.zeros((h, w), dtype=np.uint8)
        x1, y1 = w // 3, h // 3
        x2, y2 = 2 * w // 3, 2 * h // 3
        final[y1:y2, x1:x2] = 255

    return final


def _find_model_path(candidates: list) -> "str | None":
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


if __name__ == "__main__":
    main()
