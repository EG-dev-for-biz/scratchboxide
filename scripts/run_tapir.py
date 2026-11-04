#!/usr/bin/env python3
"""Google DeepMind TAPIR Point Tracking Script.

Tracks dense query points across video frames using Google DeepMind's TAPIR / TAP-Net model.
Reads JSON input from stdin:
  {
    "framesPath": "/path/to/frames.rgb",   # raw uint8 RGB, numFrames x height x width x 3 (or videoPath / framePaths)
    "numFrames": T, "width": W, "height": H,
    "videoPath": "/path/to/video.mp4",
    "queryPoints": [[x_norm, y_norm], ...],
    "queryFrames": [0, ...],
    "checkpointPath": "/path/to/tapir_checkpoint.pt",
    "useCausal": true
  }

On failure it writes {"error": "..."} and exits non-zero; it never substitutes another tracker.
Writes JSON result to stdout:
  {
    "success": true,
    "numFrames": T,
    "numPoints": N,
    "coords": [[[x, y], ...], ...],
    "visibilities": [[v, ...], ...]
  }
"""

import json
import os
import sys

# checkpoint path -> loaded model; survives between calls under packages/core/src/python/scratchbox/worker_host.py.
_MODELS = {}


def main() -> None:
    try:
        import cv2
        import numpy as np
    except ImportError as e:
        print(json.dumps({"error": f"Missing python dependencies: {e}. Install with: pip install opencv-python-headless numpy"}))
        sys.exit(1)

    try:
        input_data = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"error": f"Failed to parse JSON input from stdin: {e}"}))
        sys.exit(2)

    query_points = input_data.get("queryPoints", [])
    query_frames = input_data.get("queryFrames", None)
    checkpoint_path = input_data.get("checkpointPath", None)
    video_path = input_data.get("videoPath", None)
    frame_paths = input_data.get("framePaths", None)
    frames_path = input_data.get("framesPath", None)

    if not query_points:
        print(json.dumps({"error": "No queryPoints provided"}))
        sys.exit(2)

    # 1. Load video frames
    frames = []
    if frames_path and os.path.exists(frames_path):
        t, h, w = int(input_data.get("numFrames", 0)), int(input_data.get("height", 0)), int(input_data.get("width", 0))
        raw = np.fromfile(frames_path, dtype=np.uint8)
        if t <= 0 or h <= 0 or w <= 0 or raw.size != t * h * w * 3:
            print(json.dumps({"error": f"framesPath holds {raw.size} bytes, expected {t}x{h}x{w}x3"}))
            sys.exit(2)
        frames = list(raw.reshape(t, h, w, 3))
    elif video_path and os.path.exists(video_path):
        cap = cv2.VideoCapture(video_path)
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            frames.append(frame_rgb)
        cap.release()
    elif frame_paths:
        for fp in frame_paths:
            if os.path.exists(fp):
                bgr = cv2.imread(fp)
                if bgr is not None:
                    frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))

    if not frames:
        print(json.dumps({"error": "No frames loaded from framesPath, videoPath or framePaths"}))
        sys.exit(2)

    T = len(frames)
    H, W, C = frames[0].shape
    N = len(query_points)

    if query_frames is None or len(query_frames) != N:
        query_frames = [0] * N

    # 2. Try loading PyTorch and DeepMind TAPIR model
    try:
        import torch

        model = None
        resolved_ckpt = None
        if checkpoint_path and os.path.exists(checkpoint_path):
            resolved_ckpt = checkpoint_path
        else:
            # Common checkpoint paths
            candidates = [
                os.path.expanduser("~/.cache/tapir/tapir_checkpoint_panning.pt"),
                os.path.join(os.getcwd(), "models/tapir_checkpoint.pt"),
                os.path.join(os.getcwd(), "assets/models/tapir_checkpoint.pt")
            ]
            for cand in candidates:
                if os.path.exists(cand):
                    resolved_ckpt = cand
                    break
        if resolved_ckpt is not None:
            # Loaded once per checkpoint and kept (on its device) for later calls in a persistent worker.
            model = _MODELS.get(resolved_ckpt)
            if model is None:
                model = torch.load(resolved_ckpt, map_location="cpu")

        if model is None:
            print(json.dumps({"error": "TAPIR checkpoint not found (pass checkpointPath, or place it at ~/.cache/tapir/tapir_checkpoint_panning.pt)"}))
            sys.exit(3)

        # Prepare tensors
        queries_np = np.zeros((1, N, 3), dtype=np.float32)
        for i in range(N):
            queries_np[0, i, 0] = query_frames[i]
            queries_np[0, i, 1] = query_points[i][1] * (H - 1) # y
            queries_np[0, i, 2] = query_points[i][0] * (W - 1) # x

        video_np = np.stack(frames, axis=0).astype(np.float32) # (T, H, W, 3)
        video_norm = (video_np / 127.5) - 1.0 # [-1.0, 1.0]
        video_tensor = torch.from_numpy(video_norm)[None] # (1, T, H, W, 3)
        queries_tensor = torch.from_numpy(queries_np)

        # SCRATCHBOX_TORCH_DEVICE pins it (the tests pin the CPU); else CUDA, then Apple's MPS, then the CPU
        device = os.environ.get("SCRATCHBOX_TORCH_DEVICE", "").strip() or (
            "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu"))
        model = model.to(device)
        model.eval()
        _MODELS[resolved_ckpt] = model
        video_tensor = video_tensor.to(device)
        queries_tensor = queries_tensor.to(device)

        with torch.no_grad():
            outputs = model(video_tensor, queries_tensor) if callable(model) else model.forward(video_tensor, queries_tensor)

        if isinstance(outputs, dict):
            tracks = outputs.get("tracks", outputs.get("tracks_prediction"))
            occlusions = outputs.get("occlusion", outputs.get("occlusions"))
        elif isinstance(outputs, (tuple, list)):
            tracks = outputs[0]
            occlusions = outputs[1] if len(outputs) > 1 else None
        else:
            tracks = outputs
            occlusions = None

        if isinstance(tracks, torch.Tensor):
            tracks = tracks.cpu().numpy()
        if isinstance(occlusions, torch.Tensor):
            occlusions = occlusions.cpu().numpy()

        if tracks.ndim == 4:
            tracks = tracks[0] # (T, N, 2)

        # Normalize tracks to [0, 1]
        norm_coords = []
        norm_vis = []

        for t in range(T):
            t_coords = []
            t_vis = []
            for n in range(N):
                tx = float(np.clip(tracks[t, n, 0] / max(W - 1, 1), 0.0, 1.0))
                ty = float(np.clip(tracks[t, n, 1] / max(H - 1, 1), 0.0, 1.0))
                t_coords.append([tx, ty])

                if occlusions is not None:
                    occ = float(occlusions[0, t, n] if occlusions.ndim == 3 else occlusions[t, n])
                    vis = 1.0 / (1.0 + float(np.exp(np.clip(occ, -15.0, 15.0))))
                else:
                    vis = 1.0
                t_vis.append(float(vis))

            norm_coords.append(t_coords)
            norm_vis.append(t_vis)

        print(json.dumps({
            "success": True,
            "backend": "tapir",
            "numFrames": T,
            "numPoints": N,
            "coords": norm_coords,
            "visibilities": norm_vis
        }))

    except Exception as e:
        print(json.dumps({"error": f"TAPIR inference failed: {e}"}))
        sys.exit(4)

if __name__ == "__main__":
    main()
