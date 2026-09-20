#!/usr/bin/env python3
"""Google MediaPipe Pose Landmark Detection Script (Python Tasks API).

Reads raw image bytes from stdin and writes JSON to stdout:
  {"poses": [{"world": [{x, y, z, visibility} x33], "image": [{x, y, z, visibility} x33]}]}

Usage:
  python3 scripts/detect_pose.py <model_path> [num_poses] [min_confidence]
"""

import json
import os
import sys

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

    data = sys.stdin.buffer.read()
    if not data:
        print(json.dumps({"error": "No image data received on stdin"}))
        sys.exit(2)

    arr = np.frombuffer(data, dtype=np.uint8)
    img_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img_bgr is None:
        print(json.dumps({"error": "Failed to decode image from buffer"}))
        sys.exit(2)

    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb)

    options = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.IMAGE,
        num_poses=num_poses,
        min_pose_detection_confidence=min_conf,
        min_pose_presence_confidence=min_conf,
        output_segmentation_masks=False,
    )

    try:
        landmarker = vision.PoseLandmarker.create_from_options(options)
        result = landmarker.detect(mp_image)
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
