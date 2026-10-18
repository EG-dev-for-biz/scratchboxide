#!/usr/bin/env python3
"""Google MediaPipe Pose Landmark Detection Script (Python Tasks API).

Reads the image from <image_path> (or raw image bytes from stdin when no path is given) and writes JSON to stdout:
  {"poses": [{"world": [{x, y, z, visibility} x33], "image": [{x, y, z, visibility} x33]}]}

Usage:
  python3 scripts/detect_pose.py <model_path> [num_poses] [min_confidence] [image_path]

Run under packages/core/src/python/scratchbox/worker_host.py the landmarker is created once per
(model, num_poses, min_confidence) and reused for every later image.
"""

import json
import os
import sys

# (model_path, num_poses, min_conf) -> PoseLandmarker; survives between calls in a persistent worker.
_LANDMARKERS = {}


def main() -> None:
    try:
        import cv2
        import numpy as np
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
    except ImportError as e:
        print(json.dumps({"error": f"Missing python dependency: {e}. Install with: pip install mediapipe opencv-python-headless"}))
        sys.exit(1)

    model_path = sys.argv[1] if len(sys.argv) > 1 else None
    num_poses = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    min_conf = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
    image_path = sys.argv[4] if len(sys.argv) > 4 else None

    # If no model path provided, search common model locations
    if not model_path or not os.path.exists(model_path):
        candidates = [
            model_path,
            os.path.join(os.getcwd(), "assets/models/pose_landmarker_full.task"),
            os.path.join(os.getcwd(), "assets/models/pose_landmarker_heavy.task"),
            os.path.join(os.getcwd(), "public/models/pose_landmarker_full.task"),
            os.path.expanduser("~/.cache/mediapipe/pose_landmarker_full.task"),
        ]
        found = False
        for cand in candidates:
            if cand and os.path.exists(cand):
                model_path = cand
                found = True
                break
        if not found:
            print(json.dumps({"error": f"MediaPipe model asset not found at {model_path or 'default paths'}"}))
            sys.exit(2)

    if image_path:
        try:
            with open(image_path, "rb") as f:
                data = f.read()
        except OSError as e:
            print(json.dumps({"error": f"Could not read the image {image_path}: {e}"}))
            sys.exit(2)
    else:
        data = sys.stdin.buffer.read()
    if not data:
        print(json.dumps({"error": "No image data received" + (f" in {image_path}" if image_path else " on stdin")}))
        sys.exit(2)

    arr = np.frombuffer(data, dtype=np.uint8)
    img_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img_bgr is None:
        print(json.dumps({"error": "Failed to decode image from buffer"}))
        sys.exit(2)

    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb)

    key = (model_path, num_poses, min_conf)
    options = None if key in _LANDMARKERS else vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.IMAGE,
        num_poses=num_poses,
        min_pose_detection_confidence=min_conf,
        min_pose_presence_confidence=min_conf,
        output_segmentation_masks=False,
    )

    try:
        if options is not None:
            _LANDMARKERS[key] = vision.PoseLandmarker.create_from_options(options)
        result = _LANDMARKERS[key].detect(mp_image)
    except Exception as e:
        print(json.dumps({"error": f"Inference error: {e}"}))
        sys.exit(3)

    def serialize_landmarks(landmarks):
        return [
            {
                "x": float(lm.x),
                "y": float(lm.y),
                "z": float(lm.z),
                "visibility": float(lm.visibility if lm.visibility is not None else 1.0),
            }
            for lm in landmarks
        ]

    poses = [
        {
            "world": serialize_landmarks(world),
            "image": serialize_landmarks(image),
        }
        for world, image in zip(result.pose_world_landmarks, result.pose_landmarks)
    ]

    print(json.dumps({"poses": poses}))


if __name__ == "__main__":
    main()
