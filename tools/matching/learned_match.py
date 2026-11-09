"""Learned image matching for Street View registration: DISK keypoints + LightGlue (kornia, Apache-2.0), on the Mac's GPU
(mps) when there is one.

A persistent-worker sidecar (packages/core/src/node/spatial/LearnedFeatureMatcherService.ts). One request on stdin:
  {"images": [{"id", "b64"}], "pairs": [{"a", "b", "essential": {"fa": [fx, fy, cx, cy], "fb": [...]}?}],
   "maxKeypoints": 2048, "ignoreBottomPx": 0}
The images travel inline (Street View imagery is never written to disk). A pair with `essential` keeps only the matches
that fit one essential matrix (MAGSAC, 1 px), both views' intrinsics given. Answer on stdout, one JSON line:
  {"device", "ms", "pairs": [{"a", "b", "raw", "pa": [[x, y]...], "pb": [...], "score": [...]}]}
"""
import base64, json, sys, time

import cv2
import numpy as np


def fail(msg):
    print(json.dumps({"error": msg}))
    sys.exit(2)


_MODELS = {}


def models():
    if "disk" not in _MODELS:
        import torch
        import kornia.feature as KF
        dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        _MODELS["dev"] = dev
        _MODELS["disk"] = KF.DISK.from_pretrained("depth").eval().to(dev)
        _MODELS["lg"] = KF.LightGlueMatcher("disk").eval().to(dev)
    return _MODELS


def features(img, max_kp, ignore_bottom):
    import torch
    m = models()
    t = torch.from_numpy(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).float().permute(2, 0, 1)[None].to(m["dev"]) / 255.0
    with torch.no_grad():
        f = m["disk"](t, max_kp, pad_if_not_divisible=True)[0]
    h = img.shape[0]
    keep = f.keypoints[:, 1] < h - ignore_bottom if ignore_bottom > 0 else torch.ones(len(f.keypoints), dtype=torch.bool, device=f.keypoints.device)
    return f.keypoints[keep], f.descriptors[keep], img.shape[:2]


def undistorted(pts, k):
    fx, fy, cx, cy = k
    return np.stack([(pts[:, 0] - cx) / fx, (pts[:, 1] - cy) / fy], 1)


def main():
    import torch
    import kornia.feature as KF
    req = json.loads(sys.stdin.read() or "{}")
    imgs = {}
    for im in req.get("images") or []:
        a = cv2.imdecode(np.frombuffer(base64.b64decode(im["b64"]), np.uint8), cv2.IMREAD_COLOR)
        if a is None:
            fail(f"image {im.get('id')} does not decode")
        imgs[im["id"]] = a
    max_kp = int(req.get("maxKeypoints", 2048))
    ignore = int(req.get("ignoreBottomPx", 0))
    t0 = time.time()
    m = models()
    feats = {}
    out = []
    for p in req.get("pairs") or []:
        for k in (p["a"], p["b"]):
            if k not in feats:
                if k not in imgs:
                    fail(f"pair names image {k}, which the request does not carry")
                feats[k] = features(imgs[k], max_kp, ignore)
        (k0, d0, s0), (k1, d1, s1) = feats[p["a"]], feats[p["b"]]
        if len(k0) < 2 or len(k1) < 2:
            out.append({"a": p["a"], "b": p["b"], "raw": 0, "pa": [], "pb": [], "score": []})
            continue
        with torch.no_grad():
            l0 = KF.laf_from_center_scale_ori(k0[None], torch.ones(1, len(k0), 1, 1, device=m["dev"]))
            l1 = KF.laf_from_center_scale_ori(k1[None], torch.ones(1, len(k1), 1, 1, device=m["dev"]))
            d, idx = m["lg"](d0, d1, l0, l1, hw1=tuple(s0), hw2=tuple(s1))
        a = k0[idx[:, 0]].cpu().numpy().astype(np.float64)
        b = k1[idx[:, 1]].cpu().numpy().astype(np.float64)
        sc = d.cpu().numpy().ravel()
        keep = np.ones(len(a), bool)
        e = p.get("essential")
        if e is not None:
            keep[:] = False
            if len(a) >= 8:
                # both views' intrinsics: normalised coordinates, identity camera, threshold 1 px of the first view
                na, nb = undistorted(a, e["fa"]), undistorted(b, e["fb"])
                E, mask = cv2.findEssentialMat(na, nb, np.eye(3), method=cv2.USAC_MAGSAC, prob=0.9999, threshold=1.0 / e["fa"][0])
                if mask is not None:
                    keep = mask.ravel().astype(bool)
        out.append({"a": p["a"], "b": p["b"], "raw": int(len(a)), "pa": a[keep].round(2).tolist(), "pb": b[keep].round(2).tolist(), "score": sc[keep].round(3).tolist()})
    print(json.dumps({"device": m["dev"], "ms": round((time.time() - t0) * 1000), "pairs": out}))


if __name__ == "__main__":
    main()
