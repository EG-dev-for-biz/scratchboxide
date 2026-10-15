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

def _project_faces_to_equirect(face_depths, fovs, face_size, equirect_size, rot_params, device):
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
        radial = planar * local_norm / torch.clamp(-lz, min=1e-4)

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


def stitch_depth_maps(face_depths, fov_deg, face_size, equirect_size, rot_params, device, face_scales=None):
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
    for (radial, weight), s in zip(_project_faces_to_equirect(face_depths, fovs, face_size, equirect_size, rot_params, device), face_scales):
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


def load_depth_model(scene_type, device):
    """Loads Depth Anything V2 Metric (indoor or outdoor). Any failure is a DepthFailure."""
    model_name = ("depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf" if scene_type == "indoor"
                  else "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf")
    try:
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        print(f"[DepthService] Loading model weights from Hugging Face: {model_name}")
        processor = AutoImageProcessor.from_pretrained(model_name)
        model = AutoModelForDepthEstimation.from_pretrained(model_name).to(device)
        model.eval()
    except Exception as e:
        raise DepthFailure(f"the depth model {model_name} could not be loaded: {e}")
    return processor, model, model_name


def predict_depth(processor, model, image_np, size, device):
    """Metric depth for one HxWx3 uint8 image, resampled to size=(H, W)."""
    inputs = processor(images=image_np, return_tensors="pt").to(device)
    with torch.no_grad():
        predicted = model(**inputs).predicted_depth
    return F.interpolate(predicted.unsqueeze(1), size=size, mode="bilinear", align_corners=False).squeeze()


def equirect_depth_from_model(img_pil, scene_type, device):
    processor, model, model_name = load_depth_model(scene_type, device)
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
        face_depths = []
        for i in range(len(rot_params)):
            face_np = (faces_batch[i].cpu().numpy().transpose(1, 2, 0) * 255.0).astype(np.uint8)
            face_depths.append(predict_depth(processor, model, face_np, (face_size, face_size), device))
        face_depths_tensor = torch.stack(face_depths, dim=0)
    except DepthFailure:
        raise
    except Exception as e:
        raise DepthFailure(f"depth inference with {model_name} failed: {e}")

    print("[DepthService] Stitching and blending multi-view depth maps back to equirectangular grid...")
    # Stitch on CPU: grid_sample(padding_mode='border') is not implemented on MPS, and the stitch is memory-bound.
    stitch_device = torch.device("cpu") if device.type == "mps" else device
    fd = face_depths_tensor.to(stitch_device)
    # Per-face scale alignment in the overlap bands (monocular metric depth is consistent only up to a per-view
    # scale); absolute scale is fixed afterwards by the floor fit.
    face_scales = align_face_scales(fd, face_fovs, face_size, rot_params, stitch_device)
    print("[DepthService] Face scale alignment: " + ", ".join(f"{s:.3f}" for s in face_scales))
    depth = stitch_depth_maps(fd, face_fovs, face_size, (H_eq, W_eq), rot_params, stitch_device, face_scales)
    return depth.cpu().numpy(), model_name


def perspective_depth_from_model(img_pil, scene_type, device):
    """Planar (z) metric depth for an ordinary perspective photo, at the photo's own size."""
    processor, model, model_name = load_depth_model(scene_type, device)
    W, H = img_pil.size
    try:
        depth = predict_depth(processor, model, np.array(img_pil), (H, W), device)
    except Exception as e:
        raise DepthFailure(f"depth inference with {model_name} failed: {e}")
    return depth.cpu().numpy(), model_name


def fit_floor(equirect_depth, H_eq, W_eq, auto_eye, eye_height):
    """
    Floor band: rows in the lower 80-95% of the frame (pitch ~ -54 .. -81 deg), central half of azimuth. For each
    floor pixel the vertical drop is h = -ry * d; with metric depth and a level camera, h is the eye height.
      auto:     trust the metric model, eyeHeight = median(h)          (AI panoramas: unknown rig height)
      explicit: trust the given eyeHeight, rescale depth so median(h) == eyeHeight
    Returns (eye_height, scale_correction, floor_fit_applied, tilt_deg, tilt_yaw_deg). Raises DepthFailure when
    the eye height cannot be measured or the depth disagrees with the given eye height beyond a 4x rescale.
    """
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
        if auto_eye:
            raise DepthFailure(f"the eye height cannot be measured: only {drops.size} floor pixels in a {W_eq}x{H_eq} panorama; pass an explicit eye height")
        print("[DepthService] Floor fit skipped: too few floor pixels; depth is used at the model's own scale")
        return eye_height, 1.0, False, 0.0, 0.0

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

    if auto_eye:
        print(f"[DepthService] Measured camera eye height from the metric floor: {median_drop:.3f} m")
        return median_drop, 1.0, True, tilt_deg, tilt_yaw_deg
    scale_correction = eye_height / median_drop
    if not (0.25 <= scale_correction <= 4.0):
        raise DepthFailure(f"the depth model puts the floor {median_drop:.2f} m below the camera, which needs a {scale_correction:.2f}x rescale "
                           f"to match the given eye height {eye_height:.2f} m (more than 4x either way); check the eye height or the panorama")
    print(f"[DepthService] Floor-fit scale correction: {scale_correction:.4f} (floor drop {median_drop:.3f} m -> {eye_height:.2f} m)")
    return eye_height, scale_correction, True, tilt_deg, tilt_yaw_deg


def save_preview(depth, path):
    # Log-scaled colour ramp: near is warm/bright, far is deep purple.
    log_depth = np.log(np.clip(depth, 0.1, 100.0))
    normalized = (log_depth - np.min(log_depth)) / max((np.max(log_depth) - np.min(log_depth)), 1e-5)
    r_map = 255 - (normalized * 255.0).astype(np.uint8)
    g_map = 255 - (np.power(normalized, 1.8) * 255.0).astype(np.uint8)
    b_map = (np.power(normalized, 3.0) * 255.0).astype(np.uint8)
    Image.fromarray(np.stack([r_map, g_map, b_map], axis=-1)).save(path)


def main():
    parser = argparse.ArgumentParser(description="Depth Anything V2 metric depth for 360 panoramas and perspective photos")
    parser.add_argument("--input", required=True, help="Input image path (equirectangular panorama, or a photo with --projection perspective)")
    parser.add_argument("--output-depth", required=True, help="Output metric float32 binary depth map path")
    parser.add_argument("--output-preview", required=True, help="Output colormapped preview PNG path")
    parser.add_argument("--output-json", required=True, help="Output metadata JSON path")
    parser.add_argument("--projection", default="equirect", choices=["equirect", "perspective"],
                        help="equirect: radial depth for a 360 panorama (default); perspective: planar z depth for a photo")
    parser.add_argument("--scene-type", default="outdoor", choices=["indoor", "outdoor"], help="Scene type to load appropriate metric model")
    parser.add_argument("--eye-height", default="auto", help="Equirect only: camera eye height in meters, or 'auto' to measure it from the metric floor")
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

    auto_eye = str(args.eye_height).lower() == "auto"
    if not auto_eye:
        try:
            eye_height = float(args.eye_height)
        except ValueError:
            fail(f"--eye-height must be a number of meters or 'auto', got {args.eye_height}", 2)
        if not eye_height > 0:
            fail(f"--eye-height must be positive, got {eye_height}", 2)
    else:
        eye_height = None

    try:
        if args.projection == "perspective":
            depth, model_name = perspective_depth_from_model(img_pil, args.scene_type, device)
        elif args.mock:
            if auto_eye:
                fail("--mock builds its room at a given eye height; pass --eye-height", 2)
            depth = mock_room_depth(W, H, eye_height)
            model_name = "mock-synthetic-room (test geometry, no depth model)"
        else:
            depth, model_name = equirect_depth_from_model(img_pil, args.scene_type, device)

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
        if args.projection == "equirect":
            if args.mock:
                eye, scale_correction, floor_fit, tilt, tilt_yaw = eye_height, 1.0, False, 0.0, 0.0
            else:
                eye, scale_correction, floor_fit, tilt, tilt_yaw = fit_floor(depth, H, W, auto_eye, eye_height)
            depth = depth * scale_correction
            metadata.update({
                "eyeHeight": eye,
                "eyeHeightInferred": auto_eye and not args.mock,
                "floorFitApplied": floor_fit,
                "horizonTiltDeg": tilt,
                "horizonTiltYawDeg": tilt_yaw,
                "levelCameraOk": tilt < 2.0,
                "groundY": -eye,
                "scaleCorrection": scale_correction,
            })
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

    print(f"[DepthService] Completed. Range: {metadata['minDepth']:.2f}m - {metadata['maxDepth']:.2f}m Avg: {metadata['averageDepth']:.2f}m ({model_name})")


if __name__ == "__main__":
    main()
