#!/usr/bin/env python3
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.
"""Joint depth and camera poses for the views of one Street View drive, by Depth Anything 3 Small.

Used by Da3RigDepthService (packages/core/src/node/spatial/Da3RigDepthService.ts) for Street View registration
(rig-depth-registration.ts). Depth Anything 3 Small is allowed for registration only (user decision, 2026-11-08;
Apache-2.0 weights; the larger DA3 models are non-commercial and are refused here).

Request (stdin, one JSON object):
    {"model": "depth-anything/DA3-SMALL", "stride": 2, "outPath": "/tmp/x.f32",
     "views": [{"panoId": "...", "yawDeg": 30, "jpegBase64": "..."}, ...]}
The views travel inline because Street View imagery is never written to disk (the worker protocol's file-path rule
gives way to that). Only the derived depth and confidence are written, to outPath: for each view in order, its depth
then its confidence, float32, row-major, at 1/stride resolution.

Answer (stdout, one JSON object): {"device", "ms", "views": [{"width", "height", "w2c" (12), "fx", "fy", "cx", "cy",
"offset"}]} with offsets in float32 elements into outPath.
"""
import base64
import json
import os
import sys
import time

import numpy as np

ALLOWED_MODELS = {"depth-anything/DA3-SMALL", "depth-anything/DA3-BASE"}

# model id -> (device, model); kept between calls in the persistent worker
_loaded = {}


def fail(message, code=3):
    print(message, file=sys.stderr)
    sys.exit(code)


def device_name():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load(model_id):
    if model_id not in ALLOWED_MODELS:
        fail(f"{model_id} is not allowed: only the Apache-2.0 Depth Anything 3 models ({', '.join(sorted(ALLOWED_MODELS))}) may run here")
    if model_id not in _loaded:
        from depth_anything_3.api import DepthAnything3
        dev = device_name()
        model = DepthAnything3.from_pretrained(model_id).to(device="cpu")
        if dev != "cpu":
            model = model.to(device=dev)
        _loaded[model_id] = (dev, model)
    return _loaded[model_id]


def decode(b64):
    import cv2
    buf = np.frombuffer(base64.b64decode(b64), np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        fail("a view could not be decoded as an image")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def main():
    req = json.loads(sys.stdin.read() or "{}")
    views = req.get("views") or []
    out_path = req.get("outPath")
    stride = max(1, int(req.get("stride", 1)))
    if not views or not out_path:
        fail("the request needs views and outPath")
    dev, model = load(req.get("model", "depth-anything/DA3-SMALL"))
    images = [decode(v["jpegBase64"]) for v in views]
    t0 = time.time()
    pred = model.inference(images)
    ms = (time.time() - t0) * 1000
    depth = np.asarray(pred.depth, np.float32)
    conf = np.asarray(pred.conf, np.float32) if pred.conf is not None else np.ones_like(depth)
    ext = np.asarray(pred.extrinsics, np.float64)
    intr = np.asarray(pred.intrinsics, np.float64)
    answer = []
    offset = 0
    with open(out_path, "wb") as f:
        for i in range(len(views)):
            d = np.ascontiguousarray(depth[i, ::stride, ::stride])
            c = np.ascontiguousarray(conf[i, ::stride, ::stride])
            h, w = d.shape
            k = intr[i]
            answer.append({
                "width": int(w), "height": int(h),
                "w2c": ext[i][:3, :4].reshape(-1).tolist(),
                # pixel (x, y) of the strided map is pixel (x * stride, y * stride) of the model's map
                "fx": float(k[0, 0] / stride), "fy": float(k[1, 1] / stride),
                "cx": float((k[0, 2] - 0.5) / stride + 0.5), "cy": float((k[1, 2] - 0.5) / stride + 0.5),
                "offset": offset,
            })
            f.write(d.tobytes())
            f.write(c.tobytes())
            offset += 2 * h * w
    print(json.dumps({"device": dev, "ms": ms, "views": answer}))


if __name__ == "__main__":
    main()
