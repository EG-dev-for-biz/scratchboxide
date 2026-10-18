#!/usr/bin/env python3
"""Tracks MediaPipe 33-landmark pose through a performer video (or a single image).

Output JSON schema (consumed by PerformerPoseTrackService):
  {
    "source": str, "width": int, "height": int, "fps": float, "model": str,
    "hero_mask": str | null,   # first-frame person segmentation PNG (0..255) when requested
    "frames": [
      { "frame_index": int, "timestamp": float,
        "image": [[x, y, z, visibility] * 33] | null,   # normalized image coords
        "world": [[x, y, z, visibility] * 33] | null }  # metric, hip-centred, y-down
    ]
  }

Usage:
  track_performer_pose.py --input clip.mp4 --output pose_track.json
      [--model pose_landmarker_heavy.task] [--fps 25] [--max-seconds 4.8] [--max-width 720]
      [--mask-output hero_mask.png]
"""
import argparse
import json
import os
import sys

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}


def default_model_path() -> str:
    candidates = [
        os.environ.get('SCRATCHBOX_POSE_MODEL', ''),
        # The repo's model (Google's MediaPipe storage, Apache-2.0), the one MediaPipePoseService uses.
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'pose_landmarker_full.task'),
        os.path.expanduser('~/.cache/scratchbox/pose_landmarker_heavy.task'),
        os.path.expanduser('~/.cache/depthbox/mediapipe/pose_landmarker_lite.task'),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    raise FileNotFoundError('No MediaPipe pose_landmarker .task model found: assets/models/pose_landmarker_full.task (committed) is missing; restore it or set SCRATCHBOX_POSE_MODEL')


def landmarks_to_list(landmarks):
    return [[float(l.x), float(l.y), float(l.z), float(getattr(l, 'visibility', 1.0) or 0.0)] for l in landmarks]


def resize_for_tracking(frame, max_width):
    h, w = frame.shape[:2]
    if w <= max_width:
        return frame
    scale = max_width / float(w)
    return cv2.resize(frame, (max_width, int(round(h * scale))), interpolation=cv2.INTER_AREA)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model', default=None)
    parser.add_argument('--fps', type=float, default=0.0, help='Resample rate; 0 keeps the source rate')
    parser.add_argument('--max-seconds', type=float, default=0.0)
    parser.add_argument('--max-width', type=int, default=720)
    parser.add_argument('--mask-output', default=None, help='PNG path for the first frame person segmentation mask')
    args = parser.parse_args()

    model_path = args.model or default_model_path()
    ext = os.path.splitext(args.input)[1].lower()
    is_image = ext in IMAGE_EXTS

    # The Metal GPU delegate aborts in headless macOS sessions; CPU is deterministic everywhere.
    base_options = mp_tasks.BaseOptions(model_asset_path=model_path, delegate=mp_tasks.BaseOptions.Delegate.CPU)
    running_mode = vision.RunningMode.IMAGE if is_image else vision.RunningMode.VIDEO
    options = vision.PoseLandmarkerOptions(
        base_options=base_options,
        running_mode=running_mode,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
        output_segmentation_masks=bool(args.mask_output),
    )

    frames_out = []
    width = height = 0
    source_fps = 0.0

    with vision.PoseLandmarker.create_from_options(options) as landmarker:
        if is_image:
            img = cv2.imread(args.input)
            if img is None:
                print(f'Cannot read image {args.input}', file=sys.stderr)
                return 2
            height, width = img.shape[:2]
            rgb = cv2.cvtColor(resize_for_tracking(img, args.max_width), cv2.COLOR_BGR2RGB)
            result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            frames_out.append(frame_record(0, 0.0, result))
            save_mask(result, args.mask_output)
        else:
            cap = cv2.VideoCapture(args.input)
            if not cap.isOpened():
                print(f'Cannot open video {args.input}', file=sys.stderr)
                return 2
            source_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            target_fps = args.fps if args.fps > 0 else source_fps
            max_t = args.max_seconds if args.max_seconds > 0 else float('inf')

            src_index = 0
            next_sample_t = 0.0
            out_index = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                t = src_index / source_fps
                src_index += 1
                if t > max_t + 1e-6:
                    break
                if t + 1e-6 < next_sample_t:
                    continue
                next_sample_t += 1.0 / target_fps
                rgb = cv2.cvtColor(resize_for_tracking(frame, args.max_width), cv2.COLOR_BGR2RGB)
                result = landmarker.detect_for_video(
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int(round(t * 1000))
                )
                frames_out.append(frame_record(out_index, out_index / target_fps, result))
                if out_index == 0:
                    save_mask(result, args.mask_output)
                out_index += 1
            cap.release()
            source_fps = target_fps

    payload = {
        'source': os.path.abspath(args.input),
        'width': width,
        'height': height,
        'fps': source_fps,
        'model': os.path.basename(model_path),
        'hero_mask': os.path.abspath(args.mask_output) if args.mask_output and os.path.exists(args.mask_output) else None,
        'frames': frames_out,
    }
    with open(args.output, 'w') as f:
        json.dump(payload, f)

    tracked = sum(1 for fr in frames_out if fr['world'] is not None)
    print(json.dumps({'frames': len(frames_out), 'tracked': tracked, 'output': args.output}))
    return 0


def save_mask(result, mask_path):
    if not mask_path or not result.segmentation_masks:
        return
    mask = result.segmentation_masks[0].numpy_view()
    cv2.imwrite(mask_path, (mask.squeeze() * 255.0).clip(0, 255).astype('uint8'))


def frame_record(index, timestamp, result):
    image = world = None
    if result.pose_landmarks:
        image = landmarks_to_list(result.pose_landmarks[0])
    if result.pose_world_landmarks:
        world = landmarks_to_list(result.pose_world_landmarks[0])
    return {'frame_index': index, 'timestamp': timestamp, 'image': image, 'world': world}


if __name__ == '__main__':
    sys.exit(main())
