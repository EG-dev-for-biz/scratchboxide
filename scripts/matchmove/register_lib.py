"""
Frame-to-tile registration helpers: render the tiles near a camera guess, match the video frame to the
render with LoFTR, lift matched render pixels to 3D with the render's metric depth, and solve the
frame's pose with RANSAC PnP using the clip's calibrated lens (COLMAP SIMPLE_RADIAL, k1 only).
"""
import numpy as np
import cv2
import torch
import kornia

import tile_render as tr

_MATCHER = None


def matcher():
    global _MATCHER
    if _MATCHER is None:
        _MATCHER = kornia.feature.LoFTR(pretrained='outdoor').eval()
    return _MATCHER


def _gray(img, w, h):
    g = cv2.cvtColor(cv2.resize(np.ascontiguousarray(img), (w, h), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY)
    return torch.from_numpy(g).float()[None, None] / 255.0


def match(frame_rgb, render_rgb, work_w=640, work_h=360, min_conf=0.2):
    """LoFTR matches as full-resolution pixel coordinates (frame, render) plus confidence."""
    with torch.inference_mode():
        out = matcher()({'image0': _gray(frame_rgb, work_w, work_h), 'image1': _gray(render_rgb, work_w, work_h)})
    k0 = out['keypoints0'].numpy()
    k1 = out['keypoints1'].numpy()
    conf = out['confidence'].numpy()
    keep = conf >= min_conf
    s0 = np.array([frame_rgb.shape[1] / work_w, frame_rgb.shape[0] / work_h])
    s1 = np.array([render_rgb.shape[1] / work_w, render_rgb.shape[0] / work_h])
    # LoFTR returns pixel-corner coordinates at the working size; convert to full-size pixel centres
    return (k0[keep] + 0.5) * s0 - 0.5, (k1[keep] + 0.5) * s1 - 0.5, conf[keep]


def intrinsics_matrix(cam, width, height):
    """OpenCV K and distortion for the clip, scaled to width x height (COLMAP uses pixel-corner origin)."""
    f, cx, cy, k1 = cam['params']
    sx, sy = width / cam['width'], height / cam['height']
    K = np.array([[f * sx, 0, (cx * sx) - 0.5], [0, f * sy, (cy * sy) - 0.5], [0, 0, 1.0]])
    return K, np.array([k1, 0, 0, 0, 0], float)


def pose_to_lookat(R, t, distance=20.0):
    """Renderer camera (position, target, up) from an OpenCV pose x_cam = R x_world + t."""
    C = -R.T @ t
    forward = R[2]
    down = R[1]
    return C, C + forward * distance, -down


def solve_frame(frame_rgb, cam, glb, guess, vfov_render=None, iterations=3, render_w=960, render_h=540,
                reproj_px=4.0, log=None):
    """
    Absolute pose of one frame in the tile frame. `guess` is (position, target, up). Returns dict with R, t,
    inlier 2D (frame pixels) / 3D (tile metres) correspondences and diagnostics, or None when it fails.
    """
    H, W = frame_rgb.shape[:2]
    K, dist = intrinsics_matrix(cam, W, H)
    vfov_frame = np.degrees(2 * np.arctan((H / 2) / K[1, 1]))
    position, target, up = [np.asarray(v, float) for v in guess]
    best = None
    for it in range(iterations):
        vfov = vfov_render if (vfov_render and it == 0) else vfov_frame
        r = tr.render(glb, position, target, up, vfov, render_w, render_h, spp=4)
        p_frame, p_render, conf = match(frame_rgb, r['color'])
        X = tr.lift(r, p_render)
        ok = np.isfinite(X).all(1)
        p_frame, X, conf = p_frame[ok], X[ok], conf[ok]
        if len(X) < 12:
            if log: log(f'  iter {it}: only {len(X)} lifted matches')
            break
        success, rvec, tvec, inliers = cv2.solvePnPRansac(X, p_frame, K, dist, iterationsCount=5000,
                                                          reprojectionError=reproj_px, confidence=0.9999,
                                                          flags=cv2.SOLVEPNP_SQPNP)
        n_in = 0 if inliers is None else len(inliers)
        if not success or n_in < 10:
            if log: log(f'  iter {it}: PnP failed ({n_in} inliers of {len(X)})')
            break
        idx = inliers.ravel()
        rvec, tvec = cv2.solvePnPRefineLM(X[idx], p_frame[idx], K, dist, rvec, tvec)
        R, _ = cv2.Rodrigues(rvec)
        t = tvec.ravel()
        proj, _ = cv2.projectPoints(X[idx], rvec, tvec, K, dist)
        rms = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - p_frame[idx]) ** 2, 1))))
        C = -R.T @ t
        if log: log(f'  iter {it}: {len(X)} lifted, {n_in} inliers, rms {rms:.2f}px, centre {np.round(C, 2)}')
        best = {'R': R, 't': t, 'center': C, 'points2d': p_frame[idx], 'points3d': X[idx], 'inliers': n_in,
                'lifted': len(X), 'rmsPx': rms, 'render': r}
        position, target, up = pose_to_lookat(R, t)
    return best
