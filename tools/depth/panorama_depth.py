#!/usr/bin/env python3
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.

import os
import sys
import argparse
import json
import math
import torch
import torch.nn.functional as F
import numpy as np
from PIL import Image

def get_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    elif torch.backends.mps.is_available():
        return torch.device("mps")
    else:
        return torch.device("cpu")

def get_look_at_matrix(yaw_deg, pitch_deg):
    """
    Constructs a camera-to-world rotation matrix for a camera positioned
    at the origin looking at yaw_deg and pitch_deg.
    Yaw is rotation around Y (azimuth), pitch is rotation around X (elevation).
    """
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)

    # Forward direction in world space
    fx = math.sin(yaw) * math.cos(pitch)
    fy = math.sin(pitch)
    fz = -math.cos(yaw) * math.cos(pitch)
    f = torch.tensor([fx, fy, fz], dtype=torch.float32)

    # Camera Z-axis points in direction opposite to look direction
    z_c = -f

    # Orthonormal basis
    if abs(pitch_deg) > 89.9:
        # Looking straight up or down (zenith / nadir)
        sign = 1.0 if pitch_deg > 0 else -1.0
        x_c = torch.tensor([1.0, 0.0, 0.0], dtype=torch.float32)
        y_c = torch.tensor([0.0, 0.0, sign], dtype=torch.float32)
        z_c = torch.tensor([0.0, -sign, 0.0], dtype=torch.float32)
    else:
        # Standard Look-At right/up calculation
        up = torch.tensor([0.0, 1.0, 0.0], dtype=torch.float32)
        x_c = torch.linalg.cross(up, z_c)
        x_c = x_c / torch.linalg.vector_norm(x_c)
        y_c = torch.linalg.cross(z_c, x_c)
        y_c = y_c / torch.linalg.vector_norm(y_c)

    # Rotation matrix columns are x_c, y_c, z_c
    R = torch.stack([x_c, y_c, z_c], dim=1)
    return R

def _as_fov_list(fov, n):
    return list(fov) if isinstance(fov, (list, tuple)) else [fov] * n


def extract_perspective_faces(equirect_tensor, fov_deg, face_size, rot_params, device):
    """
    Extracts perspective faces from an equirectangular image tensor (3, H, W).
    fov_deg may be a scalar or a per-face list.
    """
    C, H_eq, W_eq = equirect_tensor.shape
    num_faces = len(rot_params)
    fovs = _as_fov_list(fov_deg, num_faces)
    
    # Grid of coordinates on the target face
    # target size is (face_size, face_size)
    y, x = torch.meshgrid(
        torch.linspace(0, face_size - 1, face_size, device=device),
        torch.linspace(0, face_size - 1, face_size, device=device),
        indexing='ij'
    )
    
    cx = (face_size - 1.0) * 0.5
    cy = (face_size - 1.0) * 0.5

    # We will sample all faces at once
    face_grids = []
    
    for (yaw_deg, pitch_deg), fov in zip(rot_params, fovs):
        f = 0.5 * face_size / math.tan(math.radians(fov) * 0.5)
        # Local ray vectors (+Y up in camera space, v=0 is the top row)
        rx = x - cx
        ry = cy - y
        rz = torch.full_like(rx, -f)
        local_rays = torch.stack([rx, ry, rz], dim=-1)
        local_rays = local_rays / torch.linalg.vector_norm(local_rays, dim=-1, keepdim=True)

        R = get_look_at_matrix(yaw_deg, pitch_deg).to(device)
        
        # Transform rays from camera local space to world space
        # R is (3, 3), local_rays is (face_size, face_size, 3)
        world_rays = torch.matmul(local_rays, R.t())  # (face_size, face_size, 3)
        
        wx = world_rays[..., 0]
        wy = world_rays[..., 1]
        wz = world_rays[..., 2]
        
        # Map to equirectangular spherical coordinates
        pitch = torch.asin(torch.clamp(wy, -1.0, 1.0))
        yaw = torch.atan2(wx, -wz)
        
        # Map to normalized grid coordinates in [-1, 1] for grid_sample
        grid_x = yaw / math.pi
        grid_y = -pitch / (math.pi * 0.5)
        
        grid = torch.stack([grid_x, grid_y], dim=-1)  # (face_size, face_size, 2)
        face_grids.append(grid)
        
    # Stack to batch (num_faces, face_size, face_size, 2)
    grid_batch = torch.stack(face_grids, dim=0)
    
    # Prepare input tensor for grid_sample (B, C, H, W)
    equirect_batch = equirect_tensor.unsqueeze(0).repeat(num_faces, 1, 1, 1).to(device)
    
    # Run bilinear sampling
    faces_batch = F.grid_sample(equirect_batch, grid_batch, mode='bilinear', padding_mode='reflection', align_corners=False)
    
    return faces_batch

def _project_faces_to_equirect(face_depths, fovs, face_size, equirect_size, rot_params, device, planar_to_radial=True):
    """
    Yields (radial_depth, weight) equirect maps for each face. Weight is cos^8 of the angle from the
    face center multiplied by a border feather that reaches exactly zero at the face edge, so no
    face can leave a hard cutoff seam.
    """
    H_eq, W_eq = equirect_size
    v, u = torch.meshgrid(
        torch.linspace(0, H_eq - 1, H_eq, device=device),
        torch.linspace(0, W_eq - 1, W_eq, device=device),
        indexing='ij'
    )
    pitch = (0.5 - (v + 0.5) / H_eq) * math.pi
    yaw = ((u + 0.5) / W_eq * 2.0 - 1.0) * math.pi
    cos_pitch = torch.cos(pitch)
    world_rays = torch.stack([torch.sin(yaw) * cos_pitch, torch.sin(pitch), -torch.cos(yaw) * cos_pitch], dim=-1)

    cx = (face_size - 1.0) * 0.5
    cy = (face_size - 1.0) * 0.5

    for i, ((yaw_deg, pitch_deg), fov) in enumerate(zip(rot_params, fovs)):
        f = 0.5 * face_size / math.tan(math.radians(fov) * 0.5)
        R = get_look_at_matrix(yaw_deg, pitch_deg).to(device)
        local_rays = torch.matmul(world_rays, R)  # r_local = R^T r_world
        lx, ly, lz = local_rays[..., 0], local_rays[..., 1], local_rays[..., 2]
        visible = lz < -1e-4

        t = -f / torch.clamp(lz, max=-1e-4)
        grid_x = 2.0 * (lx * t + cx) / (face_size - 1.0) - 1.0
        grid_y = 2.0 * (cy - ly * t) / (face_size - 1.0) - 1.0
        in_bounds = (grid_x.abs() <= 1.0) & (grid_y.abs() <= 1.0) & visible

        grid = torch.stack([grid_x, grid_y], dim=-1).unsqueeze(0)
        planar = F.grid_sample(face_depths[i].unsqueeze(0).unsqueeze(0), grid, mode='bilinear', padding_mode='border', align_corners=False).squeeze()

        local_norm = torch.linalg.vector_norm(local_rays, dim=-1)
        radial = planar * local_norm / torch.clamp(-lz, min=1e-4) if planar_to_radial else planar

        # Border feather: 1 in the interior, smoothly to 0 over the outer 20% of the face
        edge_dist = 1.0 - torch.maximum(grid_x.abs(), grid_y.abs())
        feather = torch.clamp(edge_dist / 0.2, 0.0, 1.0)
        feather = feather * feather * (3.0 - 2.0 * feather)
        weight = torch.pow(-lz / torch.clamp(local_norm, min=1e-4), 8.0) * feather
        weight = torch.where(in_bounds, weight, torch.zeros_like(weight))
        yield radial, weight


def align_face_scales(face_depths, fovs, face_size, rot_params, device, passes=3, work_res=(512, 1024)):
    """
    Monocular metric depth is only consistent up to a per-view scale. Estimate one scalar per face so
    that overlapping faces agree (median depth ratio in the overlap band), iterating against the
    running consensus. Works at reduced resolution; returns a list of scale factors.
    """
    n = len(rot_params)
    scales = [1.0] * n
    maps = list(_project_faces_to_equirect(face_depths, fovs, face_size, work_res, rot_params, device))
    for _ in range(passes):
        for i in range(n):
            # Consensus of all *other* faces at current scales
            num = torch.zeros(work_res, device=device)
            den = torch.zeros(work_res, device=device)
            for j in range(n):
                if j == i:
                    continue
                d, w = maps[j]
                num += d * scales[j] * w
                den += w
            d_i, w_i = maps[i]
            overlap = (w_i > 0.05) & (den > 0.05) & (d_i > 1e-3)
            if overlap.sum() < 200:
                continue
            consensus = num[overlap] / den[overlap]
            ratio = consensus / (d_i[overlap] * scales[i])
            # Robust: median of ratios, damped so a single pass cannot overshoot
            step = float(torch.median(ratio))
            scales[i] *= 1.0 + 0.7 * (step - 1.0)
    # Normalise so the mean scale is 1 (absolute scale is set later by the floor prior)
    mean_s = sum(scales) / n
    return [s / mean_s for s in scales]


def stitch_depth_maps(face_depths, fov_deg, face_size, equirect_size, rot_params, device, face_scales=None, planar_to_radial=True):
    """
    Stitches predicted perspective face depth maps (num_faces, face_size, face_size)
    back to a single equirectangular depth map of size equirect_size (H_eq, W_eq).
    Raises DepthFailure when any panorama pixel is seen by no face: no depth is invented for it.
    """
    n = len(rot_params)
    fovs = _as_fov_list(fov_deg, n)
    face_scales = face_scales or [1.0] * n

    accum_depth = torch.zeros(equirect_size, device=device)
    accum_weight = torch.zeros(equirect_size, device=device)
    for (radial, weight), s in zip(_project_faces_to_equirect(face_depths, fovs, face_size, equirect_size, rot_params, device, planar_to_radial), face_scales):
        accum_depth += radial * s * weight
        accum_weight += weight

    covered = accum_weight > 0
    uncovered = int((~covered).sum())
    if uncovered:
        raise DepthFailure(f"{uncovered} panorama pixels are seen by no depth face")
    return accum_depth / torch.where(covered, accum_weight, torch.ones_like(accum_weight))


class DepthFailure(Exception):
    """The depth step could not do what was asked. The sidecar exits non-zero with this message; nothing is written."""


def fail(message, code=3):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(code)


def mock_room_depth(W, H, eye_height):
    """
    Test geometry for --mock only (pipeline tests with no depth model): a cylindrical room with floor, ceiling and
    columns. Its metadata names it as mock geometry; it is never produced in place of a failed model run.
    """
    v, u = np.meshgrid(np.linspace(0, H - 1, H), np.linspace(0, W - 1, W), indexing='ij')
    pitch = (0.5 - v / H) * np.pi
    yaw = (u / W * 2.0 - 1.0) * np.pi
    cos_pitch = np.cos(pitch)
    ry = np.sin(pitch)

    depth = np.zeros((H, W), dtype=np.float32)
    for y in range(H):
        ry_val = ry[y, 0]
        if ry_val < -0.05:
            depth[y, :] = -eye_height / ry_val
        elif ry_val > 0.4:
            depth[y, :] = (10.0 - eye_height) / ry_val
        else:
            relief = np.maximum(0, np.cos(yaw[y, :] * 12.0)) * 1.2
            depth[y, :] = (15.0 - relief) / cos_pitch[y, 0]
    return np.clip(depth, 0.1, 80.0)


# The one depth model: Depth Anything V2 Small, the only Depth Anything V2 checkpoint published under Apache-2.0
# (the Base/Large/Giant checkpoints are CC-BY-NC-4.0, and the Metric fine-tunes carry no licence on the Hub and are
# trained on non-commercial data). It predicts relative inverse depth (disparity: larger is nearer). The revision is
# pinned so every run uses the same weights; tools/depth/fetch_depth_model.py downloads them ahead of time.
MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"
MODEL_REVISION = "5426e4f0f36572d16453bbda7a8389317b1bef99"
MODEL_LICENSE = "Apache-2.0"
# Disparity at or below this fraction of a view's largest disparity is the far plane (sky, or anything the model puts
# at infinity): those pixels sit at the depth of that disparity floor (100x the view's nearest depth) and are counted
# in the metadata (farPlanePixels).
FAR_DISPARITY_FRACTION = 0.01


def model_cache_dir():
    """Weights cache: SCRATCHBOX_MODEL_CACHE, else <repo>/.model-cache (gitignored). Weights are never committed."""
    root = os.environ.get("SCRATCHBOX_MODEL_CACHE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".model-cache")
    return os.path.join(os.path.abspath(root), "huggingface")


# device -> (processor, model); kept between calls when this script runs in a persistent worker
# (packages/core/src/python/scratchbox/worker_host.py), so the weights load once.
_MODEL_CACHE = {}


def model_label():
    return f"{MODEL_ID}@{MODEL_REVISION[:8]} ({MODEL_LICENSE})"


def load_depth_model(device):
    """Loads Depth Anything V2 Small once per device. Any failure is a DepthFailure."""
    cached = _MODEL_CACHE.get(str(device))
    if cached is not None:
        print(f"[DepthService] Reusing loaded model {MODEL_ID} on {device}")
        return cached[0], cached[1], model_label()
    try:
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        cache_dir = model_cache_dir()
        print(f"[DepthService] Loading {MODEL_ID} (revision {MODEL_REVISION[:8]}) from {cache_dir}")
        processor = AutoImageProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION, cache_dir=cache_dir)
        model = AutoModelForDepthEstimation.from_pretrained(MODEL_ID, revision=MODEL_REVISION, cache_dir=cache_dir).to(device)
        model.eval()
    except Exception as e:
        raise DepthFailure(f"the depth model {MODEL_ID} could not be loaded: {e}")
    _MODEL_CACHE[str(device)] = (processor, model)
    return processor, model, model_label()


def disparity_to_depth(disparity):
    """
    Relative depth from the model's disparity, taking the disparity shift as zero (depth = 1 / disparity), up to one
    unknown scale. Disparity at or below FAR_DISPARITY_FRACTION of the maximum is the far plane. Returns
    (depth, far_mask) with depth in the same arbitrary unit everywhere; callers fix the scale.
    """
    disparity = torch.as_tensor(disparity, dtype=torch.float32)
    peak = float(torch.max(disparity))
    if not peak > 0:
        raise DepthFailure("the depth model returned no positive disparity")
    floor = peak * FAR_DISPARITY_FRACTION
    far = disparity <= floor
    depth = 1.0 / torch.clamp(disparity, min=floor)
    return depth, far


def predict_disparity(processor, model, image_np, size, device):
    """Relative disparity for one HxWx3 uint8 image, resampled to size=(H, W)."""
    inputs = processor(images=image_np, return_tensors="pt").to(device)
    with torch.no_grad():
        predicted = model(**inputs).predicted_depth
    return F.interpolate(predicted.unsqueeze(1), size=size, mode="bilinear", align_corners=False).squeeze()


def predict_disparity_batch(processor, model, images_np, size, device):
    """Relative disparity for a list of same-size HxWx3 uint8 images in one forward pass, each resampled to size=(H, W)."""
    inputs = processor(images=list(images_np), return_tensors="pt").to(device)
    with torch.no_grad():
        predicted = model(**inputs).predicted_depth  # (N, h, w)
    return F.interpolate(predicted.unsqueeze(1), size=size, mode="bilinear", align_corners=False).squeeze(1)


def equirect_depth_from_model(img_pil, device):
    """Relative radial depth for an equirectangular panorama (one arbitrary scale); fit_floor makes it metric."""
    processor, model, model_name = load_depth_model(device)
    W_eq, H_eq = img_pil.size
    try:
        # 8 horizontal yaw plates at 45 degree intervals, 2 polar vertical plates (zenith / nadir)
        rot_params = [
            (0.0, 0.0), (45.0, 0.0), (90.0, 0.0), (135.0, 0.0),
            (180.0, 0.0), (225.0, 0.0), (270.0, 0.0), (315.0, 0.0),
            (0.0, 90.0), (0.0, -90.0)
        ]
        # Ring faces at 90 deg reach only ~42.7 deg pitch midway between centers, while a 90 deg polar face starts
        # at 45 deg: zero overlap -> scalloped seam. Widen the poles to 120 deg (coverage down to ~22-30 deg) so
        # every direction is seen by at least two faces.
        face_fovs = [90.0] * 8 + [120.0, 120.0]
        face_size = 512
        img_tensor = torch.from_numpy(np.array(img_pil).transpose(2, 0, 1)).float() / 255.0
        print(f"[DepthService] Extracting {len(rot_params)} perspective face plates at {face_size}x{face_size}...")
        faces_batch = extract_perspective_faces(img_tensor, face_fovs, face_size, rot_params, device)
        # All faces are face_size x face_size, so they go through the model as one batch.
        faces_np = [(faces_batch[i].cpu().numpy().transpose(1, 2, 0) * 255.0).astype(np.uint8) for i in range(len(rot_params))]
        face_disparity = predict_disparity_batch(processor, model, faces_np, (face_size, face_size), device)
    except DepthFailure:
        raise
    except Exception as e:
        raise DepthFailure(f"depth inference with {model_name} failed: {e}")

    print("[DepthService] Stitching and blending multi-view depth maps back to equirectangular grid...")
    # Stitch on CPU: grid_sample(padding_mode='border') is not implemented on MPS, and the stitch is memory-bound.
    stitch_device = torch.device("cpu") if device.type == "mps" else device
    # Per-face far planes: each face's own disparity peak sets its far threshold, before the faces are aligned.
    face_depths, far_masks = [], []
    for i in range(face_disparity.shape[0]):
        d, far = disparity_to_depth(face_disparity[i].to(stitch_device))
        face_depths.append(d)
        far_masks.append(far)
    fd = torch.stack(face_depths, dim=0)
    # Per-face scale alignment in the overlap bands (relative depth is consistent only up to a per-view scale);
    # absolute scale is fixed afterwards by the floor fit.
    face_scales = align_face_scales(fd, face_fovs, face_size, rot_params, stitch_device)
    print("[DepthService] Face scale alignment: " + ", ".join(f"{s:.3f}" for s in face_scales))
    depth = stitch_depth_maps(fd, face_fovs, face_size, (H_eq, W_eq), rot_params, stitch_device, face_scales)
    far_weight = stitch_depth_maps(torch.stack([m.float() for m in far_masks], dim=0), face_fovs, face_size, (H_eq, W_eq), rot_params, stitch_device, planar_to_radial=False)
    return depth.cpu().numpy(), (far_weight.cpu().numpy() >= 0.5), model_name


def perspective_depth_from_model(img_pil, device):
    """Relative planar (z) depth for an ordinary perspective photo at the photo's own size, median depth = 1."""
    processor, model, model_name = load_depth_model(device)
    W, H = img_pil.size
    try:
        disparity = predict_disparity(processor, model, np.array(img_pil), (H, W), device).cpu()
    except Exception as e:
        raise DepthFailure(f"depth inference with {model_name} failed: {e}")
    depth, far = disparity_to_depth(disparity)
    near = depth[~far]
    if near.numel() == 0:
        raise DepthFailure("the depth model puts every pixel at the far plane")
    depth = depth / float(torch.median(near))
    return depth.numpy(), far.numpy(), model_name


def fit_floor(equirect_depth, H_eq, W_eq, auto_eye, eye_height):
    """
    Floor band: rows in the lower 80-95% of the frame (pitch ~ -54 .. -81 deg), central half of azimuth. For each
    floor pixel the vertical drop is h = -ry * d; with metric depth and a level camera, h is the eye height.
    The depth model's output is relative (one unknown scale), so the eye height must be given: depth is rescaled so
    median(h) == eyeHeight, which makes it metric. auto_eye is refused (a relative depth cannot measure a height).
    Returns (eye_height, scale_correction, floor_fit_applied, tilt_deg, tilt_yaw_deg). Raises DepthFailure when
    the eye height is not given or the floor band cannot be measured.
    """
    if auto_eye:
        raise DepthFailure(f"the eye height cannot be measured from relative depth ({MODEL_ID} predicts depth up to one scale); pass the camera's eye height in metres")
    lower_v_start = int(0.80 * H_eq)
    lower_v_end = int(0.95 * H_eq)
    center_u_start = int(0.25 * W_eq)
    center_u_end = int(0.75 * W_eq)

    rows = np.arange(lower_v_start, lower_v_end)
    pitch_rows = (0.5 - (rows + 0.5) / H_eq) * np.pi
    ry_rows = np.sin(pitch_rows)
    valid_rows = ry_rows < -0.05
    band = equirect_depth[rows[valid_rows], center_u_start:center_u_end]
    drops = (-ry_rows[valid_rows])[:, None] * band

    if drops.size <= 100:
        raise DepthFailure(f"the floor cannot be measured: only {drops.size} floor pixels in a {W_eq}x{H_eq} panorama, so the relative depth has no metric scale")

    median_drop = float(np.median(drops))
    if not median_drop > 0:
        raise DepthFailure(f"the floor band has no positive depth (median drop {median_drop})")
    # Level-camera QC: per-azimuth median floor drop should be flat. A tilted horizon shows up as a first-harmonic
    # variation h(yaw) = c + a cos + b sin.
    col_drop = np.median(drops, axis=0)
    yaws = ((np.arange(center_u_start, center_u_end) + 0.5) / W_eq * 2.0 - 1.0) * np.pi
    A = np.stack([np.ones_like(yaws), np.cos(yaws), np.sin(yaws)], axis=1)
    coef, *_ = np.linalg.lstsq(A, col_drop, rcond=None)
    amp = float(math.hypot(coef[1], coef[2]))
    mean_floor_dist = float(np.median(band))
    tilt_deg = math.degrees(math.atan2(amp, max(1e-3, mean_floor_dist)))
    tilt_yaw_deg = math.degrees(math.atan2(coef[2], coef[1]))
    level_msg = "OK" if tilt_deg < 2.0 else "WARNING: panorama is not level; regenerate with a level camera or rotate with the SO(3) resampler"
    print(f"[DepthService] Horizon level QC: tilt {tilt_deg:.2f} deg toward yaw {tilt_yaw_deg:.0f} deg -> {level_msg}")

    scale_correction = eye_height / median_drop
    print(f"[DepthService] Floor-fit scale: {scale_correction:.4f} m per model unit (floor drop {median_drop:.4f} units -> {eye_height:.2f} m)")
    return eye_height, scale_correction, True, tilt_deg, tilt_yaw_deg


def save_preview(depth, path):
    # Log-scaled colour ramp: near is warm/bright, far is deep purple.
    log_depth = np.log(np.maximum(depth, 1e-6))
    lo, hi = np.percentile(log_depth, 1.0), np.percentile(log_depth, 99.0)
    normalized = np.clip((log_depth - lo) / max(hi - lo, 1e-5), 0.0, 1.0)
    r_map = 255 - (normalized * 255.0).astype(np.uint8)
    g_map = 255 - (np.power(normalized, 1.8) * 255.0).astype(np.uint8)
    b_map = (np.power(normalized, 3.0) * 255.0).astype(np.uint8)
    Image.fromarray(np.stack([r_map, g_map, b_map], axis=-1)).save(path)


def main():
    parser = argparse.ArgumentParser(description="Depth Anything V2 Small depth for 360 panoramas (metric, from the floor) and perspective photos (relative)")
    parser.add_argument("--input", required=True, help="Input image path (equirectangular panorama, or a photo with --projection perspective)")
    parser.add_argument("--output-depth", required=True, help="Output float32 binary depth map path (row-major width x height)")
    parser.add_argument("--output-preview", required=True, help="Output colormapped preview PNG path")
    parser.add_argument("--output-json", required=True, help="Output metadata JSON path")
    parser.add_argument("--projection", default="equirect", choices=["equirect", "perspective"],
                        help="equirect: metric radial depth for a 360 panorama (default); perspective: relative planar z depth for a photo")
    parser.add_argument("--eye-height", default=None, help="Equirect: the camera's eye height in metres above the floor (required: it sets the metric scale)")
    parser.add_argument("--median-depth-m", default=None, help="Perspective: the scene's median depth in metres, when known; the relative depth is scaled to it")
    parser.add_argument("--device", default="auto", help="Execution device (auto, mps, cuda, cpu)")
    parser.add_argument("--mock", action="store_true", help="Equirect test geometry (a synthetic room) instead of the depth model; labelled as mock in the metadata")
    args = parser.parse_args()

    if args.mock and args.projection != "equirect":
        fail("--mock is equirect test geometry only", 2)

    for path_arg in [args.output_depth, args.output_preview, args.output_json]:
        dir_name = os.path.dirname(path_arg)
        if dir_name and not os.path.exists(dir_name):
            os.makedirs(dir_name, exist_ok=True)

    device = get_device() if args.device == "auto" else torch.device(args.device)
    print(f"[DepthService] Initializing. Device: {device} Projection: {args.projection} MockMode: {args.mock}")

    if not os.path.exists(args.input):
        fail(f"input image not found: {args.input}", 1)
    try:
        img_pil = Image.open(args.input).convert("RGB")
        W, H = img_pil.size
        print(f"[DepthService] Loaded image: {args.input} ({W}x{H})")
    except Exception as e:
        fail(f"failed to open image {args.input}: {e}", 1)

    def positive_metres(value, flag):
        try:
            v = float(value)
        except (TypeError, ValueError):
            fail(f"{flag} must be a number of metres, got {value}", 2)
        if not v > 0:
            fail(f"{flag} must be positive, got {v}", 2)
        return v

    eye_height = None
    if args.projection == "equirect":
        if args.eye_height is None or str(args.eye_height).lower() == "auto":
            fail(f"--eye-height is required: {MODEL_ID} predicts relative depth, and the panorama's metric scale comes from the camera's height above the floor", 2)
        eye_height = positive_metres(args.eye_height, "--eye-height")
    median_depth_m = positive_metres(args.median_depth_m, "--median-depth-m") if args.median_depth_m is not None else None
    if median_depth_m is not None and args.projection != "perspective":
        fail("--median-depth-m applies to --projection perspective only", 2)

    try:
        far = None
        if args.projection == "perspective":
            depth, far, model_name = perspective_depth_from_model(img_pil, device)
        elif args.mock:
            depth = mock_room_depth(W, H, eye_height)
            model_name = "mock-synthetic-room (test geometry, no depth model)"
        else:
            depth, far, model_name = equirect_depth_from_model(img_pil, device)

        depth = np.asarray(depth, dtype=np.float32)
        if depth.shape != (H, W):
            raise DepthFailure(f"the depth map is {depth.shape[1]}x{depth.shape[0]}, not the image's {W}x{H}")
        if not np.all(np.isfinite(depth)) or float(np.min(depth)) <= 0:
            raise DepthFailure("the depth map has non-finite or non-positive values")

        metadata = {
            "success": True,
            "projection": args.projection,
            "depthKind": "planar-z" if args.projection == "perspective" else "radial",
            "width": W,
            "height": H,
            "modelUsed": model_name,
        }
        if not args.mock:
            metadata.update({
                "modelId": MODEL_ID,
                "modelRevision": MODEL_REVISION,
                "modelLicense": MODEL_LICENSE,
                "modelOutput": "relative inverse depth (disparity), converted with zero disparity shift: depth = scale / disparity",
                "farPlanePixels": int(np.count_nonzero(far)) if far is not None else 0,
            })
        if args.projection == "equirect":
            if args.mock:
                eye, scale_correction, floor_fit, tilt, tilt_yaw = eye_height, 1.0, False, 0.0, 0.0
            else:
                eye, scale_correction, floor_fit, tilt, tilt_yaw = fit_floor(depth, H, W, False, eye_height)
            depth = depth * scale_correction
            metadata.update({
                "depthUnits": "metres",
                "scaleSource": "mock geometry" if args.mock else f"floor fit to the given eye height {eye:.3f} m",
                "eyeHeight": eye,
                "eyeHeightInferred": False,
                "floorFitApplied": floor_fit,
                "horizonTiltDeg": tilt,
                "horizonTiltYawDeg": tilt_yaw,
                "levelCameraOk": tilt < 2.0,
                "groundY": -eye,
                "scaleCorrection": scale_correction,
            })
        else:
            if median_depth_m is not None:
                depth = depth * median_depth_m
                metadata.update({"depthUnits": "metres", "scaleSource": f"given median depth {median_depth_m:.3f} m"})
            else:
                metadata.update({"depthUnits": "relative", "scaleSource": "median depth of the non-far pixels = 1"})
    except DepthFailure as e:
        fail(str(e))

    metadata.update({
        "minDepth": float(np.min(depth)),
        "maxDepth": float(np.max(depth)),
        "averageDepth": float(np.mean(depth)),
    })

    try:
        with open(args.output_depth, "wb") as f:
            f.write(depth.astype(np.float32).tobytes())
        print(f"[DepthService] Wrote float32 binary depth: {args.output_depth} ({depth.nbytes / (1024*1024):.2f} MB)")
        save_preview(depth, args.output_preview)
        print(f"[DepthService] Saved colormapped preview image: {args.output_preview}")
        with open(args.output_json, "w") as f:
            json.dump(metadata, f, indent=2)
        print(f"[DepthService] Saved metadata JSON: {args.output_json}")
    except Exception as e:
        fail(f"failed to write the depth outputs: {e}", 1)

    print(f"[DepthService] Completed. Range: {metadata['minDepth']:.3f} - {metadata['maxDepth']:.3f} {metadata.get('depthUnits')} Avg: {metadata['averageDepth']:.3f} ({model_name})")


if __name__ == "__main__":
    main()
